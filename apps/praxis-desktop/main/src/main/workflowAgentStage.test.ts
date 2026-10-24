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


test('a later success does not silently clear a different failed background job', () => {
  const job = { source: 'provider' as const, label: 'Desktop build', startedAt: '2026-01-01', updatedAt: '2026-01-01' };
  const result = stageSessionCompletion({ state: 'completed', backgroundTasks: [
    { ...job, id: 'failed-build', state: 'failed', detail: 'Exit code 1: missing module.' },
    { ...job, id: 'later-job', state: 'completed' }
  ] });
  assert.equal(result?.state, 'failed');
  assert.match(result?.error ?? '', /Desktop build.*Exit code 1: missing module/);
  assert.match(result?.error ?? '', /retry the workflow stage/);
});

test('a job that failed while the agent was still working does not fail the stage', () => {
  const job = { source: 'provider' as const, startedAt: '2026-10-24T21:04:00.000Z' };
  // PRX-S47-148: the sandboxed test run failed, the agent re-ran it outside the sandbox and finished.
  const result = stageSessionCompletion({ state: 'completed', completedAt: '2026-10-24T21:14:38.690Z', backgroundTasks: [
    { ...job, id: 'sandboxed', label: 'npm run test:core', state: 'failed', updatedAt: '2026-10-24T21:04:26.149Z', completedAt: '2026-10-24T21:04:26.149Z' },
    { ...job, id: 'stopped', label: 'e2e', state: 'stopped', updatedAt: '2026-10-24T21:05:00.000Z', completedAt: '2026-10-24T21:05:00.000Z' },
    { ...job, id: 'rerun', label: 'npm run test:core > log', state: 'completed', updatedAt: '2026-10-24T21:04:48.002Z', completedAt: '2026-10-24T21:04:48.002Z' }
  ] });
  assert.equal(result?.state, 'completed');
});

test('a job that fails after the turn ended, or has no known result, still fails the stage', () => {
  const job = { id: 'late', source: 'provider' as const, label: 'Desktop build', startedAt: '2026-10-24T21:00:00.000Z' };
  const turn = { state: 'completed' as const, completedAt: '2026-10-24T21:10:00.000Z' };
  const late = stageSessionCompletion({ ...turn, backgroundTasks: [{ ...job, state: 'failed', updatedAt: '2026-10-24T21:12:00.000Z', completedAt: '2026-10-24T21:12:00.000Z', detail: 'Exit code 1.' }] });
  assert.equal(late?.state, 'failed');
  assert.match(late?.error ?? '', /Desktop build.*Exit code 1/);
  const unknown = stageSessionCompletion({ ...turn, backgroundTasks: [{ ...job, state: 'unknown', updatedAt: '2026-10-24T21:05:00.000Z' }] });
  assert.equal(unknown?.state, 'failed', 'an unconfirmed result is never treated as seen');
});
