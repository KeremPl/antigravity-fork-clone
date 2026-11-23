/**
 * Pure, dependency-free core helpers for Antigravity Fork & Clone.
 * Shared by sidecars/fork_panel/main.mjs and automated unit tests.
 */

export function cleanUserText(raw) {
  const s = String(raw || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  return (m ? m[1] : s)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

export function cleanPreview(text, maxLen = 200) {
  const oneLine = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

/**
 * Replays append-only transcript.jsonl content into an ordered list of turns.
 * - Deduplicates rewound/edited USER_INPUT steps (truncating stale steps >= idx)
 * - Preserves out-of-order parallel tool completions (non-user steps overwrite by idx)
 * - Guarantees every forkable endStepIndex is a completed non-USER_INPUT step.
 */
export function parseTranscriptLines(lines, childEdges = [], summaryStepCount = 0) {
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
        replyAt: '',
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

  const isBusy = lastStepIsUser || (turns.length > 0 && turns[turns.length - 1].inProgress);
  const totalSteps = Math.max(maxStepIndex + 1, Number(summaryStepCount) || 0);

  // Antigravity omits internal SYSTEM_MESSAGE / Conversation Forked / CHECKPOINT
  // steps from transcript.jsonl, yet ForkConversation requires forkAtStepIndex to
  // land immediately before the next USER_INPUT (or at the final step of the chat).
  // Advance each completed turn's endStepIndex across any trailing hidden steps.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.endStepIndex <= t.userStepIndex) continue;
    if (i + 1 < turns.length) {
      const beforeNextUser = turns[i + 1].userStepIndex - 1;
      if (beforeNextUser > t.endStepIndex) {
        t.endStepIndex = beforeNextUser;
      }
    } else if (!isBusy && totalSteps - 1 > t.endStepIndex) {
      t.endStepIndex = totalSteps - 1;
    }
    if (t.endStepIndex > latestCompletedNonUserStep) {
      latestCompletedNonUserStep = t.endStepIndex;
    }
  }

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

  return {
    turns,
    maxStepIndex,
    totalSteps,
    latestCompletedNonUserStep,
    busy: isBusy,
  };
}

/**
 * Hierarchical auto-numbering:
 *   "Chat"     -> "Chat (1)", then "Chat (2)"
 *   "Chat (1)" -> "Chat (1) (1)", then "Chat (1) (2)"
 */
export function computeNextAutoTitleFromSet(parentTitle, existingLowerSet) {
  const base = String(parentTitle || '').trim() || 'Conversation';
  let n = 1;
  while (existingLowerSet.has(`${base} (${n})`.toLowerCase()) && n < 9999) {
    n += 1;
  }
  return `${base} (${n})`;
}
