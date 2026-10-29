import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseClarityAnswers } from './promptClarity';
import { checkedClarity } from './promptClarityFixtures';
import { buildFeedbackRehearsal, buildFeedbackTurningPoint } from './feedbackCoaching';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';
import { SessionFeedbackStore } from './sessionFeedbackStore';
import type { FeedbackFinding } from './feedbackTypes';
import type { KeyValueStore } from '../../host/stateStore';

describe('prompt coaching and reviewed calibration', () => {
  it('accepts interpretations only with matching prompt or bounded context evidence', () => {
    const answers = checkedClarity().answers!;
    const input = { ...answers, interpretation: {
      target: { text: 'Settings panel', evidence: 'settings panel', source: 'context', messageIndex: 0 },
      change: { text: 'Improve speed', evidence: 'faster', source: 'prompt' },
      result: { text: 'No errors', evidence: 'invented claim', source: 'prompt' }
    } };
    const parsed = parseClarityAnswers(JSON.stringify(input), 'make it faster', { turnCount: 1, touchedPaths: [], recentMessages: [{ role: 'user', text: 'Fix the settings panel.' }] });
    assert.equal(parsed.interpretation?.target.source, 'context');
    assert.equal(parsed.interpretation?.change.text, 'Improve speed');
    assert.equal(parsed.interpretation?.result.source, 'unknown');
    assert.equal(parseClarityAnswers(JSON.stringify(input), 'make it faster').interpretation?.target.source, 'unknown');
  });
  it('a proposal stops at missing slots and never invents an execution plan', () => {
    assert.deepEqual(buildFeedbackRehearsal({ kind: 'prompt-readiness', promptText: 'put the thing in the box' }).unresolved, ['target', 'change', 'result']);
    const clarity = checkedClarity();
    clarity.answers!.interpretation = {
      target: { text: 'Sync panel', evidence: 'sync panel', source: 'prompt' },
      change: { text: 'Add retry', evidence: 'retry', source: 'prompt' },
      result: { text: 'Retry succeeds', evidence: 'succeeds', source: 'prompt' }
    };
    const proposal = buildFeedbackRehearsal({ kind: 'prompt-readiness', promptText: 'add retry to sync panel', clarity,
      workspaceHints: { changedFiles: ['src/SyncPanel.tsx'], testFiles: [], packageScripts: ['check-types'] } });
    assert.deepEqual(proposal.files, ['src/SyncPanel.tsx']);
    assert.deepEqual(proposal.checks, ['npm run check-types']);
    assert.equal(proposal.steps.length, 3);
    const restricted = buildFeedbackRehearsal({ kind: 'prompt-readiness', promptText: 'add retry to sync panel', clarity, toolMode: 'project-only' });
    assert.deepEqual(restricted.unresolved, ['tool-access']);
    assert.equal(restricted.checks.length, 0);
    assert.match(restricted.steps[0], /working folder/);
  });
  it('chooses an evidence-bearing early turning point; does not invent one for clean sessions', () => {
    assert.equal(buildFeedbackTurningPoint([]), undefined);
    const finding = (step: number): FeedbackFinding => ({ id: `tool-blind-edit-loop:${step}`, dimension: 'tool-efficiency', severity: 'warning', deltaPoints: -2, title: 'Repeated failed edit', evidence: 'failed',
      steps: [{ step, toolName: 'edit_file', ok: false }], remediation: { kind: 'refine-prompt', label: 'Read first', description: 'Read the current file before editing.' } });
    const result = buildFeedbackTurningPoint([finding(8), finding(3)]);
    assert.equal(result?.actual[0].step, 3);
    assert.match(result!.proposed.join(' '), /Read the current file/);
  });
  it('persists deduplicated human labels and explicit mutes independently of score', async () => {
    const data = new Map<string, unknown>();
    const kv: KeyValueStore = { get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key, value) => { data.set(key, structuredClone(value)); } };
    const store = new SessionFeedbackStore(kv);
    const report = evaluateSessionOrPrompt({ kind: 'prompt-readiness', promptText: 'put the thing in the box', clarity: checkedClarity({ target: 'no' }) });
    const before = JSON.stringify(report);
    await store.reviewFinding(report, { inputDigest: report.inputDigest, findingId: 'clarity-target', verdict: 'wrong' });
    await store.reviewFinding(report, { inputDigest: report.inputDigest, findingId: 'clarity-target', verdict: 'context-clear', muted: true });
    const restored = new SessionFeedbackStore(kv).getFindingFeedback(report.inputDigest);
    assert.equal(restored.reviews.length, 1);
    assert.equal(restored.reviews[0].assessment?.answers?.checks.target.answer, 'no');
    assert.equal(restored.rules[0].wrong, 0);
    assert.equal(restored.rules[0].contextClear, 1);
    assert.equal(restored.rules[0].muted, true);
    assert.equal(JSON.stringify(report), before);
    const later = evaluateSessionOrPrompt({ kind: 'prompt-readiness', promptText: 'a different vague request', clarity: checkedClarity({ target: 'no' }) });
    await store.reviewFinding(later, { inputDigest: later.inputDigest, findingId: 'clarity-target', muted: false });
    assert.equal(store.getFindingFeedback(later.inputDigest).reviews.length, 0);
    assert.equal(store.getFindingFeedback(report.inputDigest).rules[0].muted, false);
    assert.equal(store.getFindingFeedback(report.inputDigest).rules[0].contextClear, 1);
    await assert.rejects(store.reviewFinding(report, { inputDigest: 'forged', findingId: 'clarity-target', verdict: 'wrong' }));
    await assert.rejects(store.reviewFinding(report, { inputDigest: report.inputDigest, findingId: 'absent', verdict: 'wrong' }));
  });
});
