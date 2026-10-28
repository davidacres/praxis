import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { rewritePromptFromFeedback } from './promptRewriteHelper';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';

describe('promptRewriteHelper (TASK-491)', () => {
  it('constructs a deterministic copy-ready prompt offline without mutating score or dimensions', async () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'Create a feature plan for session scoring',
      toolMode: 'read-only',
      sessionMode: 'chat'
    });

    const rewritten = await rewritePromptFromFeedback(report);
    assert.ok(rewritten.aiRewrite);
    assert.equal(rewritten.aiRewrite.deterministicFallback, true);
    assert.match(rewritten.aiRewrite.rewrittenPrompt, /plan-authoring/);
    assert.match(rewritten.aiRewrite.rewrittenPrompt, /Requirements & Verification:/);
    // Score, grade, and dimensions must remain strictly unchanged
    assert.equal(rewritten.overallScore, report.overallScore);
    assert.equal(rewritten.grade, report.grade);
    assert.equal(rewritten.inputDigest, report.inputDigest);
    assert.deepEqual(rewritten.dimensions, report.dimensions);
  });

  it('uses an optional completionClient when provided and preserves deterministic scores', async () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'Fix bug',
      toolMode: 'full',
      sessionMode: 'chat'
    });

    const rewritten = await rewritePromptFromFeedback(report, {
      completionClient: {
        async complete(_system, _user) {
          return {
            text: 'Fix the parser bug in `packages/core/src/folder/markdownPlanParser.ts` and verify with `npm run test:core`.',
            modelId: 'claude-sonnet-4-6'
          };
        }
      }
    });

    assert.ok(rewritten.aiRewrite);
    assert.equal(rewritten.aiRewrite.deterministicFallback, false);
    assert.equal(rewritten.aiRewrite.modelId, 'claude-sonnet-4-6');
    assert.match(rewritten.aiRewrite.rewrittenPrompt, /markdownPlanParser\.ts/);
    assert.equal(rewritten.overallScore, report.overallScore);
    assert.equal(rewritten.grade, report.grade);
  });
});
