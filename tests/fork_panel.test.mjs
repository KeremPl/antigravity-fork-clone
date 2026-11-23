import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPreview,
  cleanUserText,
  computeNextAutoTitleFromSet,
  parseTranscriptLines,
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
