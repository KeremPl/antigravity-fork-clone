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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

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

function readLineage() {
  const p = getLineagePath();
  if (!existsSync(p)) return { edges: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return { edges: Array.isArray(parsed?.edges) ? parsed.edges : [] };
  } catch {
    return { edges: [] };
  }
}

function appendLineageEdge(edge) {
  const p = getLineagePath();
  const data = readLineage();
  data.edges.unshift(edge);
  // Keep latest 500 edges
  if (data.edges.length > 500) data.edges.length = 500;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
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
  if (!existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        'SELECT title, step_count, project_id, workspace_uris, last_modified_time FROM conversation_summaries WHERE conversation_id = ?'
      )
      .get(convId);
    return row || null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function cleanUserText(raw) {
  const s = String(raw || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return (m ? m[1] : s)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

function cleanPreview(text, maxLen = 200) {
  const oneLine = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function parseTranscriptTurns(appData, convId) {
  const logPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(logPath)) {
    return { found: false, turns: [], totalSteps: 0, latestForkStepIndex: -1, etag: '' };
  }

  let st;
  try {
    st = statSync(logPath);
  } catch {
    return { found: false, turns: [], totalSteps: 0, latestForkStepIndex: -1, etag: '' };
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split(/\r?\n/);

  // transcript.jsonl is append-only; if the user edits/rewinds a message,
  // Antigravity appends a new USER_INPUT with an already-seen step_index.
  // Truncate stale steps >= idx only on a rewound USER_INPUT so out-of-order
  // parallel tool completions never wipe sibling steps.
  const stepMap = new Map();
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const idx = Number(obj.step_index);
    if (!Number.isFinite(idx)) continue;
    const isUser = obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT';
    if (isUser && stepMap.has(idx)) {
      for (const k of [...stepMap.keys()]) {
        if (k >= idx) stepMap.delete(k);
      }
    }
    stepMap.set(idx, obj);
  }

  const orderedSteps = [...stepMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  const turns = [];
  let current = null;
  let maxStepIndex = -1;
  let latestCompletedNonUserStep = -1;
  let lastStepIsUser = false;

  for (const obj of orderedSteps) {
    const idx = Number(obj.step_index);
    if (idx > maxStepIndex) maxStepIndex = idx;

    const isUser = obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT';
    const isDone = obj.status === 'DONE' || obj.status === 'ERROR' || !obj.status;

    if (isUser) {
      lastStepIsUser = true;
      const userText = cleanUserText(obj.content);
      const hasMedia = Array.isArray(obj.media) && obj.media.length > 0;
      current = {
        turnNumber: turns.length + 1,
        userStepIndex: idx,
        endStepIndex: -1,
        forkBeforeStepIndex: -1,
        createdAt: obj.created_at || '',
        userPreview: cleanPreview(userText || (hasMedia ? '[Image / Attachment]' : '(empty message)'), 220),
        userFull: userText.slice(0, 8000),
        hasMedia,
        replyPreview: '',
        replyFull: '',
        toolCount: 0,
        toolNames: [],
        promptTokens: 0,
        tokenDelta: 0,
        model: '',
        inProgress: false,
      };
      turns.push(current);
      continue;
    }

    lastStepIsUser = false;
    if (!current) continue;

    if (obj.status === 'RUNNING' || obj.status === 'PENDING') {
      current.inProgress = true;
    }

    if (isDone) {
      current.endStepIndex = idx;
      if (idx > latestCompletedNonUserStep) latestCompletedNonUserStep = idx;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      if (obj.model) current.model = String(obj.model);
      const inTok = Number(obj.input_tokens) || 0;
      const cacheTok = Number(obj.cache_read_tokens) || 0;
      if (inTok + cacheTok > 0) current.promptTokens = inTok + cacheTok;
      if (Array.isArray(obj.tool_calls)) {
        current.toolCount += obj.tool_calls.length;
        for (const tc of obj.tool_calls) {
          const nm = String(tc?.name || '').trim();
          if (nm && !current.toolNames.includes(nm) && current.toolNames.length < 12) {
            current.toolNames.push(nm);
          }
        }
      }
      if (typeof obj.content === 'string' && obj.content.trim()) {
        current.replyPreview = cleanPreview(obj.content, 180);
        current.replyFull = obj.content.trim().slice(0, 8000);
        if (obj.created_at) current.replyAt = obj.created_at;
      }
    }
  }

  // Attach lineage (parent breadcrumb + child branches per step)
  const lineage = readLineage();
  const parentEdge = lineage.edges.find((e) => e.childId === convId) || null;
  const childEdges = lineage.edges.filter((e) => e.parentId === convId);

  let prevCompletedEnd = -1;
  let prevTokens = 0;
  for (const t of turns) {
    t.forkBeforeStepIndex = prevCompletedEnd;
    t.canForkAfter = t.endStepIndex > t.userStepIndex;
    t.canForkBefore = t.forkBeforeStepIndex >= 0;
    if (t.promptTokens > 0) {
      t.tokenDelta = prevTokens > 0 ? Math.max(0, t.promptTokens - prevTokens) : 0;
      prevTokens = t.promptTokens;
    }
    t.branches = childEdges
      .filter((e) => e.stepIndex === t.endStepIndex || e.turnNumber === t.turnNumber)
      .map((e) => ({
        childId: e.childId,
        title: e.childTitle || 'Fork',
        createdAt: e.createdAt || '',
        kind: e.kind || 'fork',
      }));
    if (t.canForkAfter) {
      prevCompletedEnd = t.endStepIndex;
    }
  }

  const summary = readSummaryMeta(appData, convId);
  const title = (summary?.title || '').trim();
  const totalSteps = Math.max(maxStepIndex + 1, Number(summary?.step_count) || 0);
  const lineageSig = `${parentEdge?.parentId || ''}:${childEdges.length}`;
  const etag = `${convId}|${st.mtimeMs}|${st.size}|${totalSteps}|${title}|${lineageSig}`;

  return {
    found: true,
    conversationId: convId,
    title: title || 'Untitled conversation',
    projectId: summary?.project_id || '',
    totalSteps,
    turnCount: turns.length,
    latestForkStepIndex: latestCompletedNonUserStep,
    busy: lastStepIsUser || (turns.length > 0 && turns[turns.length - 1].inProgress),
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
    const snap = parseTranscriptTurns(appData, conv);
    if (!snap.found) return snap;
    if (data.etag && data.etag === snap.etag) {
      return { found: true, conversationId: conv, unchanged: true, etag: snap.etag };
    }
    return snap;
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

    try {
      const fres = await lsPost('ForkConversation', {
        sourceCascadeId: conv,
        forkAtStepIndex: stepIndex,
        targetForkWorkspace: 1, // FORK_TARGET_CURRENT_WORKSPACE
      });

      const newCascadeId = String(fres?.newCascadeId || '').trim();
      if (!newCascadeId) {
        throw new Error('ForkConversation returned no newCascadeId');
      }

      let finalTitle = customTitle;
      if (customTitle) {
        try {
          await lsPost(
            'UpdateConversationAnnotations',
            {
              cascadeId: newCascadeId,
              annotations: { title: customTitle },
              mergeAnnotations: true,
            },
            10000
          );
        } catch (err) {
          console.error('[fork-clone] UpdateConversationAnnotations failed:', err?.message || err);
        }
      } else {
        const meta = appData ? readSummaryMeta(appData, newCascadeId) : null;
        finalTitle = meta?.title || parentTitle;
      }

      if (kind !== 'clone') {
        appendLineageEdge({
          parentId: conv,
          parentTitle,
          childId: newCascadeId,
          childTitle: finalTitle || parentTitle,
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
      console.error('[fork-clone] ForkConversation failed:', err?.message || err);
      return new Response(
        JSON.stringify({ ok: false, error: err?.message || 'ForkConversation failed' }),
        { status: 500, contentType: 'application/json' }
      );
    }
  },
  'POST'
);

app.run();
