import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { KeyValueStore } from '../../host/stateStore';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';
import { SessionFeedbackStore, feedbackRecordKey } from './sessionFeedbackStore';

class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

describe('SessionFeedbackStore (TASK-490)', () => {
  it('persists and reloads session and turn feedback reports across store instances', async () => {
    const kv = new MemoryKeyValueStore();
    const store1 = new SessionFeedbackStore(kv);

    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'Implement TASK-490 in packages/core/src/ai/feedback/sessionFeedbackStore.ts and run npm run test:core',
      toolMode: 'full',
      sessionMode: 'chat',
      evaluatedAt: '2026-10-28T12:00:00Z',
      userFeedback: {
        targetKind: 'session',
        issueKey: 'FX-BF-112',
        promptText: 'Implement TASK-490',
        verdict: 'helpful',
        createdAt: '2026-10-28T12:00:00Z'
      }
    });

    await store1.saveReport('FX-BF-112', report);
    await store1.saveReport('FX-BF-112', { ...report, turnIndex: 2 }, 2);

    const store2 = new SessionFeedbackStore(kv);
    const loadedSession = store2.getReport('FX-BF-112');
    const loadedTurn = store2.getReport('FX-BF-112', 2);

    assert.ok(loadedSession);
    assert.equal(loadedSession.overallScore, report.overallScore);
    assert.equal(loadedSession.inputDigest, report.inputDigest);
    assert.equal(loadedSession.userFeedback?.verdict, 'helpful');

    assert.ok(loadedTurn);
    assert.equal(loadedTurn.turnIndex, 2);
    assert.equal(feedbackRecordKey('FX-BF-112', 2), 'FX-BF-112#turn:2');

    const summary = SessionFeedbackStore.toSessionSummary(loadedSession);
    assert.equal(summary.overallScore, report.overallScore);
    assert.equal(summary.grade, report.grade);
    assert.equal(summary.verdict, 'helpful');
  });
});
