import * as assert from 'node:assert';
import {
  extractClarificationQuestions,
  normalizeClarificationCommentBody
} from '../ai/aiReviewService';

suite('aiReviewService clarification comment sanitization', () => {
  test('keeps only numbered clarification questions', () => {
    const body = normalizeClarificationCommentBody(`Implementation is blocked because several details are missing.
Questions:
1. Which environment should this target?
2. What tenant should be used?`);

    assert.strictEqual(
      body,
      '1. Which environment should this target?\n2. What tenant should be used?'
    );
  });

  test('strips tool traces and reasoning from Copilot clarification output', () => {
    const questions = extractClarificationQuestions(`Thought: I should inspect the repo first.
Tool: read_file src/config.ts
Tool result: found staging references
Questions:
1. Which environment should this target?
2. Should the existing feature flag remain enabled?`);

    assert.deepStrictEqual(questions, [
      'Which environment should this target?',
      'Should the existing feature flag remain enabled?'
    ]);
  });

  test('adds a question mark for question-like numbered lines missing punctuation', () => {
    const body = normalizeClarificationCommentBody(`1. Which environment should this target
2. What tenant should be used`);

    assert.strictEqual(
      body,
      '1. Which environment should this target?\n2. What tenant should be used?'
    );
  });
});