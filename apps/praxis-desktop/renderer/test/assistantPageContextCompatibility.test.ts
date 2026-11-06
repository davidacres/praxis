import test from 'node:test';
import assert from 'node:assert/strict';
import type { PageAssistantContext } from '@praxis/core';
import { INCOMPATIBLE_PAGE_CONTEXT_MESSAGE, incompatiblePageContextMessage, isCompatiblePageContext } from '../src/assistant/assistantPageContext.ts';

/* TASK-484 AC-C: a proposal applies only on the page it was produced on. */

const issue: PageAssistantContext = { pageType: 'issue', title: 'Issue TEAM-12', summary: 'A ticket', projectId: 'p1', issueKey: 'TEAM-12', entityId: 'TEAM-12' };
const board: PageAssistantContext = { pageType: 'board', title: 'Team board', summary: 'The board', projectId: 'p1', entityId: 'board-1' };
const git: PageAssistantContext = { pageType: 'git', title: 'Changes', summary: 'Working tree', projectId: 'p1' };

test('the same page is compatible, however its summary or prompts drift', () => {
  assert.equal(isCompatiblePageContext(issue, issue), true);
  assert.equal(isCompatiblePageContext(issue, { ...issue, summary: 'Updated since', data: 'new state', suggestedPrompts: ['Ask again'] }), true);
  assert.equal(isCompatiblePageContext(board, { ...board, summary: 'Different ticket counts' }), true);
});

test('a different page is not compatible', () => {
  assert.equal(isCompatiblePageContext(issue, board), false);
  assert.equal(isCompatiblePageContext(board, git), false);
  // Same type, different record.
  assert.equal(isCompatiblePageContext(issue, { ...issue, issueKey: 'TEAM-13', entityId: 'TEAM-13' }), false);
  assert.equal(isCompatiblePageContext(issue, { ...issue, title: 'Renamed ticket' }), false);
  assert.equal(isCompatiblePageContext(issue, { ...issue, projectId: 'p2' }), false);
  assert.equal(isCompatiblePageContext(board, { ...board, entityId: 'board-2' }), false);
});

test('a missing origin or a page with no registered context is never compatible', () => {
  assert.equal(isCompatiblePageContext(undefined, issue), false);
  assert.equal(isCompatiblePageContext(issue, undefined), false);
  assert.equal(isCompatiblePageContext(undefined, undefined), false);
});

test('the refusal is one message, stated once', () => {
  assert.equal(incompatiblePageContextMessage(), 'Return to the originating page to apply this proposal.');
  assert.equal(INCOMPATIBLE_PAGE_CONTEXT_MESSAGE, incompatiblePageContextMessage());
});
