import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  SCORING_RUBRIC_VERSION,
  FEEDBACK_SCHEMA_VERSION,
  computeFeedbackInputDigest,
  scoreToFeedbackGrade,
  type FeedbackEvaluationInput
} from './feedbackTypes';

describe('feedbackTypes & canonical digest (TASK-488)', () => {
  it('exposes rubric and schema version 1', () => {
    assert.equal(SCORING_RUBRIC_VERSION, 1);
    assert.equal(FEEDBACK_SCHEMA_VERSION, 1);
  });

  it('maps scores to grades deterministically', () => {
    assert.equal(scoreToFeedbackGrade(95), 'A');
    assert.equal(scoreToFeedbackGrade(90), 'A');
    assert.equal(scoreToFeedbackGrade(89), 'B');
    assert.equal(scoreToFeedbackGrade(80), 'B');
    assert.equal(scoreToFeedbackGrade(74), 'C');
    assert.equal(scoreToFeedbackGrade(64), 'D');
    assert.equal(scoreToFeedbackGrade(59), 'F');
    assert.equal(scoreToFeedbackGrade(0), 'F');
  });

  it('produces identical SHA-256 digests regardless of object key or catalog ordering', () => {
    const inputA: FeedbackEvaluationInput = {
      kind: 'prompt-readiness',
      promptText: 'Create a feature plan for session scoring',
      toolMode: 'read-only',
      sessionMode: 'chat',
      activeSkills: ['human-review', 'plan-authoring'],
      configuredMcpServers: ['github', 'jira'],
      availableSkills: [
        { name: 'plan-authoring', description: 'Author plans', triggers: ['plan', 'feature'] },
        { name: 'human-review', description: 'Review work', triggers: ['review'] }
      ],
      userFeedback: {
        targetKind: 'prompt',
        promptText: 'Create a feature plan for session scoring',
        verdict: 'needs-work',
        frictionTags: ['wasted-steps', 'missed-skill'],
        createdAt: '2026-10-28T12:00:00Z'
      }
    };

    const inputB: FeedbackEvaluationInput = {
      sessionMode: 'chat',
      toolMode: 'read-only',
      promptText: 'Create a feature plan for session scoring',
      kind: 'prompt-readiness',
      activeSkills: ['plan-authoring', 'human-review'],
      configuredMcpServers: ['jira', 'github'],
      availableSkills: [
        { name: 'human-review', description: 'Review work', triggers: ['review'] },
        { name: 'plan-authoring', description: 'Author plans', triggers: ['feature', 'plan'] }
      ],
      userFeedback: {
        createdAt: '2026-10-28T13:30:00Z', // createdAt is excluded from semantic digest
        verdict: 'needs-work',
        promptText: 'Create a feature plan for session scoring',
        targetKind: 'prompt',
        frictionTags: ['missed-skill', 'wasted-steps']
      }
    };

    const digestA = computeFeedbackInputDigest(inputA);
    const digestB = computeFeedbackInputDigest(inputB);
    assert.equal(digestA.length, 64);
    assert.equal(digestA, digestB);
  });

  it('distinguishes prompt-readiness from session-execution digests', () => {
    const base: FeedbackEvaluationInput = {
      kind: 'prompt-readiness',
      promptText: 'Fix bug in parser'
    };
    const exec: FeedbackEvaluationInput = {
      ...base,
      kind: 'session-execution'
    };
    assert.notEqual(computeFeedbackInputDigest(base), computeFeedbackInputDigest(exec));
  });
});
