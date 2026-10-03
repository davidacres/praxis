import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueDetails, WorkflowTransition } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { resolveTicketContext } from './ticketContext';

function mockTrackerService(issues: Record<string, IssueDetails>, transitions: WorkflowTransition[] = []): IssueTrackerService {
  return {
    mode: 'demo',
    async getIssue(key: string) {
      if (issues[key]) return issues[key];
      throw new Error(`Issue ${key} not found`);
    },
    async getTransitions() {
      return transitions;
    },
    async addComment() {},
    async updateIssue() {},
    async transitionIssue() {}
  } as unknown as IssueTrackerService;
}

test('resolveTicketContext includes main ticket details, description, and comments', async () => {
  const mainIssue: IssueDetails = {
    key: 'PROJ-101',
    summary: 'Implement OAuth refresh token',
    issueType: 'Story',
    status: 'To Do',
    priority: 'High',
    assignee: 'Alice',
    description: 'When the access token expires, use the refresh token to get a new one.',
    comments: [
      { author: 'Bob', body: 'Ensure we rotate refresh tokens on each use.' }
    ],
    projectKey: 'PROJ'
  };

  const context = await resolveTicketContext({ issue: mainIssue, toolMode: 'full' });

  assert.match(context, /## Active Ticket: PROJ-101 — Implement OAuth refresh token/);
  assert.match(context, /- Status: To Do/);
  assert.match(context, /- Priority: High/);
  assert.match(context, /- Assignee: Alice/);
  assert.match(context, /When the access token expires/);
  assert.match(context, /Ensure we rotate refresh tokens on each use/);
  assert.match(context, /## Ticket Lifecycle & Progress Reporting Directives/);
  assert.match(context, /tracker_transition_ticket/);
  assert.match(context, /tracker_add_comment/);
});

test('resolveTicketContext resolves parent issue, sibling tasks, dependencies, and transitions', async () => {
  const parentIssue: IssueDetails = {
    key: 'PROJ-50',
    summary: 'Core Authentication Overhaul',
    issueType: 'Feature',
    status: 'In Progress',
    description: 'Centralize authentication across services.',
    subTasks: [
      { key: 'PROJ-101', summary: 'Implement OAuth refresh token', status: 'To Do', issueType: 'Story' },
      { key: 'PROJ-102', summary: 'Frontend token storage', status: 'In Progress', assignee: 'Charlie', issueType: 'Story' }
    ],
    projectKey: 'PROJ'
  };

  const depIssue: IssueDetails = {
    key: 'PROJ-99',
    summary: 'Database token table schema migration',
    issueType: 'Task',
    status: 'Done',
    description: 'Created refresh_tokens table with hash and expiry.',
    projectKey: 'PROJ'
  };

  const mainIssue: IssueDetails = {
    key: 'PROJ-101',
    summary: 'Implement OAuth refresh token',
    issueType: 'Story',
    status: 'To Do',
    parentKey: 'PROJ-50',
    dependsOn: ['PROJ-99'],
    projectKey: 'PROJ'
  };

  const transitions: WorkflowTransition[] = [
    { id: 't-in-progress', name: 'Start Work', toStatus: 'In Progress' },
    { id: 't-done', name: 'Complete', toStatus: 'Done' }
  ];

  const service = mockTrackerService({ 'PROJ-50': parentIssue, 'PROJ-99': depIssue }, transitions);

  const context = await resolveTicketContext({
    issue: mainIssue,
    backendService: service,
    toolMode: 'full'
  });

  assert.match(context, /### Parent Issue: PROJ-50 — Core Authentication Overhaul/);
  assert.match(context, /Centralize authentication across services/);
  assert.match(context, /Sibling Tasks under Parent \(Boundaries\):/);
  assert.match(context, /PROJ-102: Frontend token storage \[In Progress\] \(Charlie\)/);
  assert.match(context, /### Dependencies/);
  assert.match(context, /PROJ-99 — Database token table schema migration/);
  assert.match(context, /Created refresh_tokens table with hash and expiry/);
  assert.match(context, /## Available Ticket Transitions/);
  assert.match(context, /Start Work/);
  assert.match(context, /id: `t-in-progress`, moves to: "In Progress"/);
});

test('resolveTicketContext handles read-only mode directives', async () => {
  const mainIssue: IssueDetails = {
    key: 'PROJ-101',
    summary: 'Analyze memory leak',
    issueType: 'Bug',
    status: 'Investigating',
    projectKey: 'PROJ'
  };

  const context = await resolveTicketContext({ issue: mainIssue, toolMode: 'read-only' });

  assert.match(context, /## Ticket Context Directives \(Read-Only Mode\)/);
  assert.match(context, /This session is read-only: do not transition tickets/);
});
