import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssueDetails } from '../types';
import { AUTOPILOT_SESSION_PROMPT, buildSystemPrompt } from './agentPrompt';
import { coerceGadgetBlock } from './gadgets/validation';
import { parseChatBlocks } from './gadgets/blockParser';
import {
  TICKET_REVIEW_APPLY_GADGET_ID,
  TICKET_REVIEW_APPLY_GATE,
  TICKET_REVIEW_SESSION_PROMPT,
  buildTicketReviewGoal,
  reviewedIssueKey,
  ticketReviewSessionKey
} from './ticketReview';

const ISSUE = {
  key: 'APP-101',
  summary: 'Add CSV export',
  issueType: 'Story',
  status: 'To Do',
  description: 'Users can export the table.'
} as IssueDetails;

test('a review session key round-trips to the ticket and never equals the ticket key', () => {
  const key = ticketReviewSessionKey('APP-101');
  assert.notEqual(key, 'APP-101');
  assert.equal(reviewedIssueKey(key), 'APP-101');
});

test('an ordinary session key is not mistaken for a ticket review', () => {
  assert.equal(reviewedIssueKey('APP-101'), undefined);
  assert.equal(reviewedIssueKey('SESSION-1a2b3c4d'), undefined);
  // A real project called REVIEW must not be read as a review of ticket "1".
  assert.equal(reviewedIssueKey('REVIEW-1'), undefined);
  assert.equal(reviewedIssueKey(undefined), undefined);
  assert.equal(reviewedIssueKey(ticketReviewSessionKey('  ')), undefined);
});

test('the goal carries the description exactly once, so it is not paid for twice', () => {
  const description = 'Unique description marker 7f3a.';
  const goal = buildTicketReviewGoal({ ...ISSUE, description });
  assert.equal(goal.split(description).length - 1, 1);
  assert.match(goal, /Review ticket APP-101/);
});

test('a ticket with no description says so, so the agent does not invent one to "preserve"', () => {
  const goal = buildTicketReviewGoal({ ...ISSUE, description: undefined });
  assert.match(goal, /\*\*Description:\*\* \*\(none\)\*/);
});

test('every gadget example in the review prompt is accepted by the real validator', () => {
  // The prompt teaches the model by example. If validation tightens and an
  // example stops passing, every review would silently degrade to a wall of
  // fallback text — so the examples are held to the same schema as real output.
  const parsed = parseChatBlocks(TICKET_REVIEW_SESSION_PROMPT, {
    scope: { hostId: 'host', sessionId: 'session', workId: 'APP-101' },
    issuedAt: '2026-09-22T10:00:00.000Z',
    idPrefix: 'p'
  });
  const gadgets = parsed.blocks.filter(block => block.type === 'gadget');
  assert.equal(parsed.malformed, 0);
  assert.equal(gadgets.length, 3, 'a findings choice, a questions form and the apply form');

  for (const [index, block] of gadgets.entries()) {
    const coerced = coerceGadgetBlock((block as { gadget: unknown }).gadget, `b${index}`);
    assert.equal(coerced.type, 'gadget', coerced.type === 'fallback' ? coerced.reason?.message : '');
  }

  const forms = gadgets
    .map(block => (block as { gadget: { kind: string; gadgetId: string; actions: { actionId: string; gate?: string; effect: string }[] } }).gadget)
    .filter(gadget => gadget.kind === 'form');
  const form = forms.find(gadget => gadget.gadgetId === TICKET_REVIEW_APPLY_GADGET_ID);
  assert.ok(form, 'the apply form is present');
  // Only the apply form may carry a mutating action; the questions form must
  // stay informational or its answer would never be reported back to the agent.
  const questions = forms.find(gadget => gadget.gadgetId === 'review-questions');
  assert.ok(questions?.actions.every(action => action.effect === 'informational'));
  const apply = form?.actions.find(action => action.actionId === 'apply');
  assert.equal(apply?.effect, 'mutating');
  assert.equal(apply?.gate, TICKET_REVIEW_APPLY_GATE);
});

test('a ticket-review task gets the review prompt, not the delivery planning prompt', () => {
  const prompt = buildSystemPrompt(
    {
      kind: 'ticket-review',
      sessionMode: 'review',
      goal: buildTicketReviewGoal(ISSUE),
      scope: 'Read-only ticket review.',
      definitionOfDone: 'Findings presented.'
    },
    ISSUE
  );
  assert.ok(prompt.includes('This session is read-only'));
  assert.ok(prompt.includes(TICKET_REVIEW_APPLY_GATE));
});

test('the prompt names the ticket, never the internal review session key', () => {
  const sessionKey = ticketReviewSessionKey('APP-101');
  const prompt = buildSystemPrompt(
    {
      kind: 'ticket-review',
      sessionMode: 'review',
      goal: buildTicketReviewGoal(ISSUE),
      scope: 'Read-only ticket review.',
      definitionOfDone: 'Findings presented.'
    },
    { ...ISSUE, key: sessionKey }
  );
  // An agent that sees `review~APP-101` as "the ticket key" would ask the
  // tracker for a ticket that does not exist.
  assert.ok(!prompt.includes(sessionKey));
  assert.ok(prompt.includes('- Key: APP-101'));
});

test('the prompt tells the agent to settle a question with evidence before it asks the user', () => {
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /Answer it yourself before you ask/);
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /Never ask the user to confirm something you could have looked up/);
  // A ticket that contradicts the evidence is a finding, not a question.
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /is a \*\*finding\*\*/);
});

test('the Autopilot prompt directs the agent to decide and continue without routine questions', () => {
  assert.match(AUTOPILOT_SESSION_PROMPT, /without asking the user routine follow-up questions/);
  assert.match(AUTOPILOT_SESSION_PROMPT, /choose one, continue/);
});

test('the prompt spells out how to write a gadget that will display', () => {
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /own line/);
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /Escape every double quote/);
  assert.match(TICKET_REVIEW_SESSION_PROMPT, /under 300 characters/);
});

test('the working style and project instructions follow the task prompt, style first', () => {
  const prompt = buildSystemPrompt(
    { goal: 'Do it.', scope: '', definitionOfDone: '', workingStyle: '- Plan first.', projectInstructions: '## Project instructions\nUse tabs.' },
    ISSUE
  );
  assert.match(prompt, /## Working style\nFollow these habits whichever tools you have:\n- Plan first\./);
  assert.ok(prompt.indexOf('## Working style') < prompt.indexOf('## Project instructions'));
  assert.doesNotMatch(buildSystemPrompt({ goal: 'Do it.', scope: '', definitionOfDone: '' }, ISSUE), /Working style/);
});
