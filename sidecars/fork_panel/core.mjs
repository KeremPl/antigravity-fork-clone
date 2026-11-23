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
export function decodeProtoFields(buf, start = 0, end = buf.length) {
  const fields = new Map();
  let pos = start;
  const readVarint = () => {
    let val = 0n;
    let shift = 0n;
    while (pos < end && shift < 70n) {
      const b = buf[pos++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return val;
      shift += 7n;
    }
    return val;
  };
  while (pos < end) {
    const tag = Number(readVarint());
    const fieldNum = tag >>> 3;
    const wire = tag & 7;
    if (!fieldNum) break;
    let val;
    if (wire === 0) {
      val = Number(readVarint());
    } else if (wire === 1) {
      pos += 8;
      continue;
    } else if (wire === 2) {
      const len = Number(readVarint());
      if (len < 0 || pos + len > end) break;
      val = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) {
      pos += 4;
      continue;
    } else {
      break;
    }
    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push(val);
  }
  return fields;
}

/**
 * Extracts Antigravity's exact per-conversation compaction token cap
 * (executor_metadata.data -> field 10 -> field 2 -> field 5).
 */
export function extractExecutorContextLimit(buf) {
  if (!(buf instanceof Uint8Array) || buf.length === 0) return 0;
  try {
    const root = decodeProtoFields(buf);
    const f10 = root.get(10)?.[0];
    if (!(f10 instanceof Uint8Array)) return 0;
    const f2 = decodeProtoFields(f10).get(2)?.[0];
    if (!(f2 instanceof Uint8Array)) return 0;
    const f5 = decodeProtoFields(f2).get(5)?.[0];
    return typeof f5 === 'number' && Number.isFinite(f5) && f5 > 0 ? f5 : 0;
  } catch {
    return 0;
  }
}

export function resolveFallbackContextLimit(rawModel) {
  const m = String(rawModel || '').toLowerCase();
  if (/gpt-oss-120b/.test(m)) return 131072;
  if (/orchestrator/.test(m)) return 512000;
  return 256000;
}

export function parseTranscriptLines(lines, childEdges = [], summaryStepCount = 0, executorLimit = 0) {
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
  let lastPlannerOrderIdx = -1;
  let lastPlannerObj = null;
  let lastCheckpointOrderIdx = -1;
  let lastCheckpointObj = null;

  for (let orderIdx = 0; orderIdx < orderedSteps.length; orderIdx++) {
    const obj = orderedSteps[orderIdx];
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

    if (obj.type === 'CHECKPOINT') {
      lastCheckpointOrderIdx = orderIdx;
      lastCheckpointObj = obj;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      if (obj.model) current.model = String(obj.model);
      const inTok = Number(obj.input_tokens) || 0;
      const cacheTok = Number(obj.cache_read_tokens) || 0;
      if (inTok + cacheTok > 0) {
        current.promptTokens = inTok + cacheTok;
        lastPlannerOrderIdx = orderIdx;
        lastPlannerObj = obj;
      }
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

  // Compute exact context window usage from latest PLANNER_RESPONSE (+ trailing uncounted steps)
  const estimateStepTok = (s) => {
    const textLen =
      String(s?.content || '').length +
      String(s?.thinking || '').length +
      (Array.isArray(s?.tool_calls) ? JSON.stringify(s.tool_calls).length : 0);
    return Math.ceil(textLen / 4);
  };

  let usedTokens = 0;
  let cachedTokens = 0;
  let lastPromptTokens = 0;
  let activeModel = lastPlannerObj ? String(lastPlannerObj.model || '') : '';
  if (lastCheckpointOrderIdx > lastPlannerOrderIdx && lastCheckpointObj) {
    // Just compacted and waiting for next PLANNER_RESPONSE: avoid stale pre-compaction count
    const summaryTok =
      Number(lastCheckpointObj.output_tokens) > 0
        ? Number(lastCheckpointObj.output_tokens)
        : estimateStepTok(lastCheckpointObj);
    let trailingTokens = 0;
    for (let j = lastCheckpointOrderIdx + 1; j < orderedSteps.length; j++) {
      trailingTokens += estimateStepTok(orderedSteps[j]);
    }
    usedTokens = summaryTok + trailingTokens;
  } else if (lastPlannerObj) {
    const inTok = Number(lastPlannerObj.input_tokens) || 0;
    const cacheTok = Number(lastPlannerObj.cache_read_tokens) || 0;
    const outTok = Number(lastPlannerObj.output_tokens) || 0;
    lastPromptTokens = inTok + cacheTok;
    cachedTokens = cacheTok;

    let trailingTokens = 0;
    for (let j = lastPlannerOrderIdx + 1; j < orderedSteps.length; j++) {
      trailingTokens += estimateStepTok(orderedSteps[j]);
    }
    usedTokens = lastPromptTokens + outTok + trailingTokens;
  }

  const contextLimit =
    Number(executorLimit) > 0 ? Number(executorLimit) : resolveFallbackContextLimit(activeModel);
  const freeTokens = Math.max(0, contextLimit - usedTokens);
  const usedPercent = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;
  const cacheHitRatio =
    lastPromptTokens > 0 ? Math.round((cachedTokens / lastPromptTokens) * 1000) / 10 : 0;

  return {
    turns,
    maxStepIndex,
    totalSteps,
    latestCompletedNonUserStep,
    busy: isBusy,
    context: {
      usedTokens,
      contextLimit,
      freeTokens,
      usedPercent: Number(usedPercent.toFixed(1)),
      remainingPercent: Number(Math.max(0, 100 - usedPercent).toFixed(1)),
      cacheHitRatio,
      model: activeModel,
    },
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
