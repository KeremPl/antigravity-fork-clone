/**
 * Native Fork & Clone sidecar backend for Antigravity Desktop.
 *
 * - GET /api/turns : Reads the open conversation's transcript.jsonl and
 *   conversation_summaries.db (read-only) to build a chronological Turn 1..N
 *   timeline with exact step indices, token deltas, tool summaries, and
 *   persistent parent/child fork lineage chips.
 * - POST /api/fork : Calls Antigravity's native LanguageServerService
 *   ForkConversation RPC (and UpdateConversationAnnotations for custom title),
 *   records parent -> child lineage locally, and returns the new native
 *   conversation ID.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  computeNextAutoTitleFromSet,
  extractExecutorContextLimit,
  parseTranscriptLines,
} from './core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function findAppDataDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
  }
  const fallback = join(homedir(), '.gemini', 'antigravity');
  return existsSync(fallback) ? fallback : '';
}

function getLineagePath() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) return join(dataDir, 'lineage.json');
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'fork-clone', 'fork_panel', 'lineage.json');
}

const MAX_CACHE_ENTRIES = 64;
const lineageCache = { path: '', sig: '', data: { edges: [] } };
const summaryCache = new Map();
const executorLimitCache = new Map();

function statSig(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

function dbStatSig(dbPath) {
  const mainSig = statSig(dbPath);
  if (!mainSig) return '';
  const walSig = statSig(`${dbPath}-wal`);
  return walSig ? `${mainSig}|${walSig}` : mainSig;
}

function setBoundedCache(map, key, value) {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, value);
}

function readLineage() {
  const p = getLineagePath();
  const sig = statSig(p);
  if (!sig) {
    lineageCache.path = p;
    lineageCache.sig = '';
    lineageCache.data = { edges: [] };
    return lineageCache.data;
  }
  if (lineageCache.path === p && lineageCache.sig === sig) {
    return lineageCache.data;
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    lineageCache.path = p;
    lineageCache.sig = sig;
    lineageCache.data = { edges: Array.isArray(parsed?.edges) ? parsed.edges : [] };
    return lineageCache.data;
  } catch {
    return { edges: [] };
  }
}

function appendLineageEdge(edge) {
  const p = getLineagePath();
  const current = readLineage();
  const nextEdges = [edge, ...current.edges];
  // Keep latest 500 edges
  if (nextEdges.length > 500) nextEdges.length = 500;
  const data = { edges: nextEdges };
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, p);
    lineageCache.path = p;
    lineageCache.sig = statSig(p);
    lineageCache.data = data;
  } catch (err) {
    console.error('[fork-clone] Failed to persist lineage:', err?.message || err);
  }
}

function lsPost(method, body, timeoutMs = 30000) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) {
    return Promise.reject(new Error('Language server credentials unavailable'));
  }
  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const payload = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = null;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = parsed?.message || text || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }
          resolve(parsed ?? {});
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function readSummaryMeta(appData, convId) {
  const dbPath = join(appData, 'conversation_summaries.db');
  const sig = dbStatSig(dbPath);
  if (!sig) return null;
  const cached = summaryCache.get(convId);
  if (cached && cached.sig === sig) return cached.row;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        'SELECT title, step_count, project_id, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?'
      )
      .get(convId);
    const val = row || null;
    setBoundedCache(summaryCache, convId, { sig, row: val });
    return val;
  } catch {
    return cached?.row || null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function computeNextAutoTitle(appData, parentTitle, projectId) {
  const existing = new Set();

  if (appData) {
    const dbPath = join(appData, 'conversation_summaries.db');
    if (existsSync(dbPath)) {
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = projectId
          ? db.prepare('SELECT title FROM conversation_summaries WHERE project_id = ?').all(projectId)
          : db.prepare('SELECT title FROM conversation_summaries').all();
        for (const r of rows) {
          if (r?.title) existing.add(String(r.title).trim().toLowerCase());
        }
      } catch {
        // ignore read errors
      } finally {
        try {
          db?.close();
        } catch {}
      }
    }
  }

  // Also include recent titles from local lineage in case summaries DB lags by a moment
  for (const e of readLineage().edges) {
    if (projectId && e?.projectId && e.projectId !== projectId) continue;
    if (e?.childTitle) existing.add(String(e.childTitle).trim().toLowerCase());
  }

  return computeNextAutoTitleFromSet(parentTitle, existing);
}

function readExecutorLimit(appData, convId) {
  const dbPath = join(appData, 'conversations', `${convId}.db`);
  const sig = dbStatSig(dbPath);
  const cached = executorLimitCache.get(convId);
  if (!sig) return cached?.limit || 0;
  if (cached && cached.sig === sig) return cached.limit;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT data FROM executor_metadata ORDER BY rowid DESC LIMIT 1')
      .get();
    const parsed = row?.data instanceof Uint8Array ? extractExecutorContextLimit(row.data) : 0;
    const limit = parsed > 0 ? parsed : cached?.limit || 0;
    setBoundedCache(executorLimitCache, convId, { sig, limit });
    return limit;
  } catch {
    // Keep last known limit on transient SQLITE_BUSY so the ring never flickers
    return cached?.limit || 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function parseTranscriptTurns(appData, convId, clientEtag = '') {
  const logPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  let st;
  try {
    st = statSync(logPath);
  } catch {
    return { found: false, turns: [], totalSteps: 0, latestForkStepIndex: -1, etag: '' };
  }

  const lineage = readLineage();
  const parentEdge = lineage.edges.find((e) => e.childId === convId) || null;
  const childEdges = lineage.edges.filter((e) => e.parentId === convId);

  const summary = readSummaryMeta(appData, convId);
  const executorLimit = readExecutorLimit(appData, convId);
  const summaryStepCount = Number(summary?.step_count) || 0;
  const title = (summary?.title || '').trim();
  const lineageSig = `${parentEdge?.parentId || ''}:${childEdges.length}`;
  const etag = `${convId}|${st.mtimeMs}|${st.size}|${summaryStepCount}|${title}|${lineageSig}|${executorLimit}`;

  // Early short-circuit before reading or parsing transcript.jsonl
  if (clientEtag && clientEtag === etag) {
    return { found: true, conversationId: convId, unchanged: true, etag };
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const { turns, totalSteps, latestCompletedNonUserStep, busy, hasSubagents, firstSubagentTurn, context } =
    parseTranscriptLines(lines, childEdges, summaryStepCount, executorLimit);

  return {
    found: true,
    conversationId: convId,
    title: title || 'Untitled conversation',
    projectId: summary?.project_id || '',
    totalSteps,
    turnCount: turns.length,
    latestForkStepIndex: latestCompletedNonUserStep,
    busy,
    hasSubagents,
    firstSubagentTurn,
    context,
    parent: parentEdge
      ? {
          parentId: parentEdge.parentId,
          parentTitle: parentEdge.parentTitle || 'Parent conversation',
          turnNumber: parentEdge.turnNumber || 0,
          stepIndex: parentEdge.stepIndex,
          kind: parentEdge.kind || 'fork',
        }
      : null,
    turns,
    etag,
  };
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => {
  try {
    return new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE,
    });
  } catch (err) {
    return new Response(`Panel loading error: ${err.message}`, { status: 503, contentType: 'text/plain' });
  }
});

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => {
      try {
        return new Response(readFileSync(join(__dirname, file), 'utf-8'), {
          contentType,
          headers: NO_STORE,
        });
      } catch (err) {
        return new Response(`Asset error: ${err.message}`, { status: 404, contentType: 'text/plain' });
      }
    },
    'GET'
  );
}

app.api(
  '/api/turns',
  (data) => {
    const conv = String(data.conversationId || app.config.conversationId || '').trim();
    if (!conv || !ID_RE.test(conv)) {
      return { found: false, conversationId: conv || null, turns: [] };
    }
    const appData = findAppDataDir();
    if (!appData) {
      return { found: false, conversationId: conv, turns: [], error: 'App data directory not found' };
    }
    return parseTranscriptTurns(appData, conv, String(data.etag || ''));
  },
  'GET'
);

app.api(
  '/api/fork',
  async (data) => {
    const conv = String(data.conversationId || app.config.conversationId || '').trim();
    const stepIndex = Number(data.stepIndex);
    const turnNumber = Number(data.turnNumber) || 0;
    const kind = String(data.kind || 'fork');
    const customTitle = typeof data.title === 'string' ? data.title.trim() : '';

    if (!conv || !ID_RE.test(conv)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid conversationId' }), {
        status: 400,
        contentType: 'application/json',
      });
    }
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid stepIndex' }), {
        status: 400,
        contentType: 'application/json',
      });
    }

    const appData = findAppDataDir();
    const parentMeta = appData ? readSummaryMeta(appData, conv) : null;
    const parentTitle = (parentMeta?.title || '').trim() || 'Conversation';
    const parentProjectId = parentMeta?.project_id || '';

    try {
      // Retry stepping past hidden non-user steps (e.g. CORTEX_STEP_TYPE_SYSTEM_MESSAGE /
      // Conversation Forked markers omitted from transcript.jsonl) if needed.
      let attemptIdx = stepIndex;
      let fres = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          fres = await lsPost('ForkConversation', {
            sourceCascadeId: conv,
            forkAtStepIndex: attemptIdx,
            targetForkWorkspace: 1, // FORK_TARGET_CURRENT_WORKSPACE
          });
          break;
        } catch (err) {
          const msg = String(err?.message || '');
          const m = msg.match(/step\s+(\d+)\s+is\s+CORTEX_STEP_TYPE_(?:SYSTEM_MESSAGE|CHECKPOINT|EPHEMERAL)/i);
          if (m && attempt < 3) {
            const nextIdx = Number(m[1]);
            if (nextIdx > attemptIdx) {
              attemptIdx = nextIdx;
              continue;
            }
          }
          throw err;
        }
      }

      const newCascadeId = String(fres?.newCascadeId || '').trim();
      if (!newCascadeId) {
        throw new Error('ForkConversation returned no newCascadeId');
      }

      const targetProjectId = fres?.newProjectId || parentProjectId;
      const targetTitle = customTitle || computeNextAutoTitle(appData, parentTitle, targetProjectId);
      let finalTitle = targetTitle;
      try {
        await lsPost(
          'UpdateConversationAnnotations',
          {
            cascadeId: newCascadeId,
            annotations: { title: targetTitle },
            mergeAnnotations: true,
          },
          10000
        );
      } catch (err) {
        finalTitle = parentTitle;
        console.error('[fork-clone] UpdateConversationAnnotations failed:', err?.message || err);
      }

      if (kind !== 'clone') {
        appendLineageEdge({
          parentId: conv,
          parentTitle,
          childId: newCascadeId,
          childTitle: finalTitle || parentTitle,
          projectId: targetProjectId,
          turnNumber,
          stepIndex: fres?.forkedAtStepIndex ?? stepIndex,
          kind,
          createdAt: new Date().toISOString(),
        });
      }

      return {
        ok: true,
        newCascadeId,
        forkedAtStepIndex: fres?.forkedAtStepIndex ?? stepIndex,
        newProjectId: fres?.newProjectId || '',
        title: finalTitle || parentTitle,
      };
    } catch (err) {
      const errMsg = err?.message || 'ForkConversation failed';
      const isSubagentErr = /subagent/i.test(errMsg);
      console.error('[fork-clone] ForkConversation failed:', errMsg);
      return new Response(
        JSON.stringify({
          ok: false,
          error: errMsg,
          ...(isSubagentErr ? { errorCode: 'SUBAGENT_UNSUPPORTED' } : {}),
        }),
        { status: isSubagentErr ? 422 : 500, contentType: 'application/json' }
      );
    }
  },
  'POST'
);

app.run();
