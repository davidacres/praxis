import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatBlocks } from './gadgets/blockParser';
import { coerceGadgetBlock } from './gadgets/validation';
import {
  HUMAN_REVIEW_GATE,
  HUMAN_REVIEW_SESSION_PREFIX,
  HUMAN_REVIEW_SIGNOFF_GADGET_ID,
  HUMAN_REVIEW_SESSION_PROMPT,
  buildHumanReviewGoal,
  buildHumanReviewTaskDefinition,
  humanReviewSessionKey,
  reviewedTargetKey
} from './humanReview';
import { buildSystemPrompt } from './agentPrompt';

const TARGET = {
  key: 'FEAT-200',
  summary: 'Add user preference sync',
  description: 'Synchronize user preferences with cloud backend.'
};

test('a human review session key round-trips to the target key and never equals the target key', () => {
  const key = humanReviewSessionKey('FEAT-200');
  assert.notEqual(key, 'FEAT-200');
  assert.equal(reviewedTargetKey(key), 'FEAT-200');
});

test('an ordinary session key is not mistaken for a human review', () => {
  assert.equal(reviewedTargetKey('FEAT-200'), undefined);
  assert.equal(reviewedTargetKey('SESSION-12345'), undefined);
  assert.equal(reviewedTargetKey(undefined), undefined);
  assert.equal(reviewedTargetKey(humanReviewSessionKey('  ')), undefined);
});

test('buildHumanReviewGoal includes target key, summary, and description', () => {
  const goal = buildHumanReviewGoal(TARGET);
  assert.match(goal, /FEAT-200/);
  assert.match(goal, /Add user preference sync/);
  assert.match(goal, /Synchronize user preferences/);
});

test('every gadget example in the human review prompt is accepted by the real validator', () => {
  const parsed = parseChatBlocks(HUMAN_REVIEW_SESSION_PROMPT, {
    scope: { hostId: 'host', sessionId: 'session', workId: 'FEAT-200' },
    issuedAt: '2026-10-14T10:00:00.000Z',
    idPrefix: 'hr'
  });

  assert.equal(parsed.malformed, 0, 'no malformed gadget blocks');
  const gadgets = parsed.blocks.filter(block => block.type === 'gadget');
  assert.equal(gadgets.length, 2, 'a feature review form and the final sign-off form');

  for (const [index, block] of gadgets.entries()) {
    const coerced = coerceGadgetBlock((block as { gadget: unknown }).gadget, `b${index}`);
    assert.equal(coerced.type, 'gadget', coerced.type === 'fallback' ? coerced.reason?.message : '');
  }

  // Verify feature review form structure: contains both multiple choice (select) and free text (textarea)
  const forms = gadgets.map(b => (b as { gadget: any }).gadget);
  const featureForm = forms.find(g => g.gadgetId === 'feature-review-1');
  assert.ok(featureForm, 'feature review form is present');
  assert.equal(featureForm.kind, 'form');

  const selectField = featureForm.payload.fields.find((f: any) => f.type === 'select');
  assert.ok(selectField, 'feature review form has multiple-choice select field');
  assert.ok(selectField.options.length >= 3, 'multiple choice options provided');

  const textareaField = featureForm.payload.fields.find((f: any) => f.type === 'textarea');
  assert.ok(textareaField, 'feature review form has free-text textarea field');

  // Verify all actions are informational so they travel back as turns to the agent
  for (const form of forms) {
    assert.ok(
      form.actions.every((a: any) => a.effect === 'informational'),
      'actions must be informational to trigger follow-up turns'
    );
  }

  // Verify sign-off form
  const signoffForm = forms.find(g => g.gadgetId === HUMAN_REVIEW_SIGNOFF_GADGET_ID);
  assert.ok(signoffForm, 'sign-off form is present');
  const signoffSelect = signoffForm.payload.fields.find((f: any) => f.type === 'select');
  assert.ok(signoffSelect, 'sign-off form has verdict selection');
});

test('buildHumanReviewTaskDefinition produces a human-review task with review prompt', () => {
  const task = buildHumanReviewTaskDefinition(TARGET);
  assert.equal(task.kind, 'human-review');
  assert.equal(task.sessionMode, 'review');

  const prompt = buildSystemPrompt(task, {
    key: TARGET.key,
    summary: TARGET.summary,
    description: TARGET.description,
    issueType: 'Task',
    status: 'In progress',
    projectKey: 'FEAT'
  });

  assert.match(prompt, /human review/i);
  assert.match(prompt, /multiple choice options as much as possible/i);
  assert.match(prompt, /free text/i);
  assert.match(prompt, /This session is read-only/i);
});
