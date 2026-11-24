import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPreview,
  cleanUserText,
  computeNextAutoTitleFromSet,
  extractExecutorContextLimit,
  parseTranscriptLines,
  resolveFallbackContextLimit,
} from '../sidecars/fork_panel/core.mjs';

describe('cleanUserText & cleanPreview', () => {
  it('extracts USER_REQUEST and strips metadata blocks', () => {
    const raw = `<USER_REQUEST>\nHello world\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime: 123\n</ADDITIONAL_METADATA>`;
    assert.equal(cleanUserText(raw), 'Hello world');
  });

  it('truncates long previews cleanly with ellipsis', () => {
    const out = cleanPreview('a'.repeat(30), 10);
    assert.equal(out.length, 10);
    assert.ok(out.endsWith('…'));
  });
});

describe('parseTranscriptLines', () => {
  it('groups multi-tool turns and sets exact non-user endStepIndex', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nTurn 1\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 1000, cache_read_tokens: 0, tool_calls: [{ name: 'read_file' }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'file body' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 500, cache_read_tokens: 1200, content: 'Reply 1' }),
      JSON.stringify({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nTurn 2\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 400, cache_read_tokens: 1800, content: 'Reply 2' }),
    ];

    const res = parseTranscriptLines(lines);
    assert.equal(res.turns.length, 2);
    assert.equal(res.turns[0].userStepIndex, 0);
    assert.equal(res.turns[0].endStepIndex, 3);
    assert.equal(res.turns[0].canForkAfter, true);
    assert.equal(res.turns[0].toolCount, 1);
    assert.deepEqual(res.turns[0].toolNames, ['read_file']);
    assert.equal(res.turns[0].replyFull, 'Reply 1');

    assert.equal(res.turns[1].userStepIndex, 4);
    assert.equal(res.turns[1].endStepIndex, 5);
    assert.equal(res.turns[1].tokenDelta, 500);
    assert.equal(res.latestCompletedNonUserStep, 5);
    assert.equal(res.busy, false);
  });

  it('deduplicates rewound/edited USER_INPUT steps without leaking stale turns', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nKeep me\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Answer 1' }),
      // Stale/cancelled Turn 2 that was later edited/rewound
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nSTALE DELETED PROMPT\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'STALE REPLY' }),
      // Replacement Turn 2 at step_index 2
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nFinal Turn 2\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Final Reply 2' }),
    ];

    const res = parseTranscriptLines(lines);
    assert.equal(res.turns.length, 2);
    assert.equal(res.turns[1].userFull, 'Final Turn 2');
    assert.equal(res.turns[1].replyFull, 'Final Reply 2');
  });

  it('preserves out-of-order parallel tool completions without truncating sibling steps', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Run two tools' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'a' }, { name: 'b' }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'RUNNING' }),
      // Step 3 finishes BEFORE Step 2
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'b done' }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'a done' }),
      JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Both done' }),
    ];

    const res = parseTranscriptLines(lines);
    assert.equal(res.turns.length, 1);
    assert.equal(res.turns[0].endStepIndex, 4);
    assert.equal(res.turns[0].replyFull, 'Both done');
    assert.equal(res.turns[0].inProgress, false);
  });

  it('advances endStepIndex past hidden SYSTEM_MESSAGE / Conversation Forked steps', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 1' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reply 1' }),
      // Hidden step 2 = CORTEX_STEP_TYPE_SYSTEM_MESSAGE (Conversation Forked, omitted from transcript.jsonl)
      JSON.stringify({ step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 2 after fork' }),
      JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reply 2' }),
      // Hidden step 5 = trailing SYSTEM_MESSAGE reflected in summaryStepCount = 6
    ];

    const res = parseTranscriptLines(lines, [], 6);
    assert.equal(res.turns.length, 2);
    assert.equal(res.turns[0].endStepIndex, 2); // right before step 3 USER_INPUT
    assert.equal(res.turns[1].endStepIndex, 5); // right at final hidden step 5
    assert.equal(res.latestCompletedNonUserStep, 5);
  });

  it('marks dangling USER_INPUT with no reply as non-forkable and busy', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 1' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reply 1' }),
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Pending Turn 2' }),
    ];

    const res = parseTranscriptLines(lines);
    assert.equal(res.turns.length, 2);
    assert.equal(res.turns[0].canForkAfter, true);
    assert.equal(res.turns[1].canForkAfter, false);
    assert.equal(res.latestCompletedNonUserStep, 1);
    assert.equal(res.busy, true);
  });
});

describe('computeNextAutoTitleFromSet (hierarchical chaining)', () => {
  it('increments siblings (1), (2), (3) and chains children (1) (1)', () => {
    const existing = new Set();
    const t1 = computeNextAutoTitleFromSet('My Chat', existing);
    assert.equal(t1, 'My Chat (1)');
    existing.add(t1.toLowerCase());

    const t2 = computeNextAutoTitleFromSet('My Chat', existing);
    assert.equal(t2, 'My Chat (2)');
    existing.add(t2.toLowerCase());

    // Forking from "My Chat (1)" chains to "My Chat (1) (1)"
    const t11 = computeNextAutoTitleFromSet('My Chat (1)', existing);
    assert.equal(t11, 'My Chat (1) (1)');
    existing.add(t11.toLowerCase());

    const t12 = computeNextAutoTitleFromSet('My Chat (1)', existing);
    assert.equal(t12, 'My Chat (1) (2)');
  });

  it('handles case-insensitive collisions and blank parent titles', () => {
    const existing = new Set(['conversation (1)']);
    assert.equal(computeNextAutoTitleFromSet('', existing), 'Conversation (2)');
  });
});

function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeLengthDelimited(fieldNum, payload) {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(payload.length), ...payload];
}

describe('context window tracking & protobuf limit decoder', () => {
  it('extracts Antigravity compaction limit from executor_metadata protobuf (field 10 -> 2 -> 5)', () => {
    const field5 = [...encodeVarint((5 << 3) | 0), ...encodeVarint(512000)];
    const field2 = encodeLengthDelimited(2, field5);
    const field10 = encodeLengthDelimited(10, field2);
    assert.equal(extractExecutorContextLimit(new Uint8Array(field10)), 512000);
    assert.equal(extractExecutorContextLimit(new Uint8Array([])), 0);
  });

  it('resolves model fallback limits cleanly', () => {
    assert.equal(resolveFallbackContextLimit('gpt-oss-120b'), 131072);
    assert.equal(resolveFallbackContextLimit('model-orchestrator'), 512000);
    assert.equal(resolveFallbackContextLimit('gemini-4-neon-high'), 256000);
  });

  it('computes exact context tokens, percent, cache hit ratio, and trailing estimates', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Hi' }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'claude-opus-5-5-high',
        input_tokens: 10000,
        cache_read_tokens: 90000,
        output_tokens: 2000,
        content: 'Done',
      }),
    ];
    const res = parseTranscriptLines(lines, [], 0, 840000);
    assert.equal(res.context.usedTokens, 102000);
    assert.equal(res.context.contextLimit, 840000);
    assert.equal(res.context.freeTokens, 738000);
    assert.equal(res.context.usedPercent, 12.1);
    assert.equal(res.context.remainingPercent, 87.9);
    assert.equal(res.context.cacheHitRatio, 90);
    assert.equal(res.context.model, 'claude-opus-5-5-high');
  });

  it('uses CHECKPOINT summary instead of stale pre-compaction tokens right after compaction', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Long chat' }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'gemini-4-neon-high',
        input_tokens: 50000,
        cache_read_tokens: 400000,
        output_tokens: 5000,
        content: 'Old reply',
      }),
      JSON.stringify({
        step_index: 2,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        status: 'DONE',
        output_tokens: 12000,
      }),
    ];
    const res = parseTranscriptLines(lines, [], 0, 512000);
    assert.equal(res.context.usedTokens, 12000);
    assert.equal(res.context.usedPercent, 2.3);
  });

  it('safely handles truncated or malformed protobuf buffers without throwing', () => {
    assert.equal(extractExecutorContextLimit(new Uint8Array([0xff, 0xff, 0xff])), 0);
    // Field 10 with length larger than remaining buffer
    assert.equal(extractExecutorContextLimit(new Uint8Array([(10 << 3) | 2, 99, 1, 2])), 0);
    assert.equal(extractExecutorContextLimit(null), 0);
  });

  it('adds trailing uncounted step estimates after the latest PLANNER_RESPONSE', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Hi' }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 3000,
        output_tokens: 500,
        content: 'First reply',
      }),
      // Follow-up user message not yet answered (400 chars -> ~100 estimated tokens)
      JSON.stringify({
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'x'.repeat(400),
      }),
    ];
    const res = parseTranscriptLines(lines, [], 0, 256000);
    assert.equal(res.context.usedTokens, 4600);
    assert.equal(res.busy, true);
    assert.equal(res.hasSubagents, false);
    assert.equal(res.firstSubagentTurn, 0);
  });

  it('detects subagent invocations and records the first subagent turn', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 1' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reply 1' }),
      JSON.stringify({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Open site' }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'invoke_subagent' }],
      }),
      JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done' }),
    ];
    const res = parseTranscriptLines(lines);
    assert.equal(res.hasSubagents, true);
    assert.equal(res.firstSubagentTurn, 2);
    assert.equal(res.turns[0].usesSubagent, false);
    assert.equal(res.turns[1].usesSubagent, true);
  });

  it('detects subagents via step type/source markers even without invoke_subagent tool call', () => {
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Run task' }),
      JSON.stringify({ step_index: 1, source: 'SUBAGENT', type: 'SUBAGENT_RESULT', status: 'DONE', content: 'ok' }),
    ];
    const res = parseTranscriptLines(lines);
    assert.equal(res.hasSubagents, true);
    assert.equal(res.firstSubagentTurn, 1);
  });
});
