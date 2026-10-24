import { stageSessionCompletion } from './workflowAgentStage';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IssueDetails, IssueTrackerService } from '@praxis/core';
import { resolveStageTicketContext } from './workflowAgentStage';

function mockTrackerService(issues: Record<string, IssueDetails>): IssueTrackerService {
  return {
    mode: 'demo',
    async getIssue(key: string) {
      if (issues[key]) return issues[key];
      throw new Error(`Issue ${key} not found`);
    },
    async getTransitions() {
      return [];
    },
    async addComment() {},
    async updateIssue() {},
    async transitionIssue() {}
  } as unknown as IssueTrackerService;
}

test('resolveStageTicketContext returns empty object when run has no issueKey', async () => {
  const result = await resolveStageTicketContext(
    { runId: 'run-1', projectId: 'p1' },
    'read-only'
  );
  assert.deepEqual(result, {});
});

test('resolveStageTicketContext resolves ticket details, description, comments, and attachments in workflow mode', async () => {
  const issue: IssueDetails = {
    key: 'PROJ-42',
    summary: 'Implement user authentication with JWT',
    issueType: 'Story',
    status: 'In Progress',
    priority: 'High',
    assignee: 'Alice',
    description: 'The authentication service must issue JWTs on successful login.',
    comments: [
      { author: 'Bob', body: 'Please ensure expiration is set to 15 minutes.' }
    ],
    attachments: [
      {
        fileName: 'jwt-architecture.png',
        mimeType: 'image/png',
        sizeBytes: 12345,
        contentUrl: 'https://example.com/jwt.png'
      }
    ],
    projectKey: 'PROJ'
  };

  const service = mockTrackerService({ 'PROJ-42': issue });

  const result = await resolveStageTicketContext(
    { runId: 'run-1', projectId: 'p1', issueKey: 'PROJ-42', issueConnectionId: 'conn-1' },
    'full',
    {
      getConnection: () => 'conn-1',
      getService: async () => service
    }
  );

  assert.ok(result.ticketContext);
  assert.match(result.ticketContext, /## Active Ticket: PROJ-42 — Implement user authentication with JWT/);
  assert.match(result.ticketContext, /The authentication service must issue JWTs on successful login/);
  assert.match(result.ticketContext, /Please ensure expiration is set to 15 minutes/);
  assert.match(result.ticketContext, /## Ticket Context Directives \(Workflow Mode\)/);
  assert.match(result.ticketContext, /stage progression and terminal outcome write-back are managed by the workflow engine/);
  assert.doesNotMatch(result.ticketContext, /tracker_transition_ticket/);

  assert.equal(result.attachments?.length, 1);
  assert.equal(result.attachments?.[0].fileName, 'jwt-architecture.png');
  assert.equal(result.attachments?.[0].sourceUrl, 'https://example.com/jwt.png');
  assert.equal(result.attachments?.[0].mediaType, 'image/png');
  assert.equal(result.attachments?.[0].sizeBytes, 12345);
});

test('resolveStageTicketContext tolerates missing or deleted tickets gracefully without failing the stage', async () => {
  const service = mockTrackerService({});

  const result = await resolveStageTicketContext(
    { runId: 'run-1', projectId: 'p1', issueKey: 'GHOST-999' },
    'read-only',
    {
      getConnection: () => 'conn-1',
      getService: async () => service
    }
  );

  assert.deepEqual(result, {});
});


test('a stage waits for provider background work and cannot claim success from an unknown or failed result', () => {
  const background = { id: 'bg', source: 'provider' as const, label: 'Checks', startedAt: '2026-01-01', updatedAt: '2026-01-01' };
  for (const state of ['running', 'paused'] as const) assert.equal(stageSessionCompletion({ state: 'completed', backgroundTasks: [{ ...background, state }] }), undefined);
  for (const state of ['failed', 'unknown', 'stopped'] as const) assert.equal(stageSessionCompletion({ state: 'completed', backgroundTasks: [{ ...background, state }] })?.state, 'failed');
  assert.equal(stageSessionCompletion({ state: 'completed', backgroundTasks: [{ ...background, state: 'completed' }] })?.state, 'completed');
  assert.equal(stageSessionCompletion({ state: 'completed', backgroundTasks: [{ ...background, source: 'shell', state: 'running' }] })?.state, 'completed', 'a long-lived service does not hold a stage open');
});
