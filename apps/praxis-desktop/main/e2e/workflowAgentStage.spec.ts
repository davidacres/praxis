import { openSession } from './sessionNavigation';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * FX-BE-025 — an agent stage really executes.
 *
 * Everything here is the production path except the LLM HTTP endpoint, which is
 * the in-process mock gateway. A real discovered + trusted agent passes
 * preflight, `VercelAgentService.startTask` runs a real agent loop against the
 * mock, `AiSessionManager` fires the real lifecycle events, the orchestrator's
 * session watcher resolves, `stageOutcomeFromSession` extracts the artifact,
 * the worktree is frozen, and the run reaches `awaiting-approval` with no
 * manual advancement.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/** A profile dir with one trusted agent already on disk. */
function profileWithAgent(): { userDataDir: string; settingsPath: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-agent-'));
  tempDirs.push(userDataDir);
  const agentDir = path.join(userDataDir, 'agents', 'wf-reviewer');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'wf-reviewer',
      name: 'Workflow Reviewer',
      type: 'gateway',
      entry: 'noop'
    })
  );
  return { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') };
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-agent-repo-'));
  tempDirs.push(root);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

test('an agent stage runs a real session and produces its declared artifact', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'Reviewed the implementation snapshot: the change is correct and complete.'
  });
  const profile = profileWithAgent();
  const repo = createRepository();

  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', workingDirectory: repo } },
    profile,
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Agent Delivery',
        key: 'AGT',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );

    // Make sure the just-written agent manifest is discovered.
    await window.praxis.agentRuntime.refresh();

    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: `agent-${project.id}`,
      name: 'Agent review',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'review',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
          agent: { agentId: 'wf-reviewer', scope: 'global', toolMode: 'read-only' },
          instructions: 'Review the change for correctness and report your findings.',
          outputs: [{ id: 'review-report', kind: 'report', required: true }],
          mutatesWorktree: false,
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: ['review-report'],
          prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
        }
      ],
      edges: [{ id: 'e1', from: 'review', to: 'approve', on: 'success', required: true }]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, `agent-${project.id}`, 'Agent-driven');
    return { runId: summary.runId };
  }, repo);

  // No manual advancement anywhere: wait for the orchestrator to drive the
  // agent stage through a real session.
  await expect
    .poll(
      async () => page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.status), started.runId),
      { timeout: 30000, message: 'run should reach awaiting-approval on its own' }
    )
    .toBe('awaiting-approval');

  const detail = await page.evaluate(async runId => {
    const summary = await window.praxis.workflows.getRun(runId);
    const stage = summary?.stages.find(row => row.nodeId === 'review');
    const sessions = await window.praxis.ai.listSessions();
    const stageSession = sessions.find(s => s.workflowRunId === runId && s.workflowNodeId === 'review');
    return {
      outcome: stage?.outcome,
      hasSessionId: !!stage?.sessionId,
      artifacts: stage?.artifacts.map(a => a.contractId),
      gate: summary?.gates.find(g => g.gate === 'qa')?.state,
      sessionState: stageSession?.state,
      sessionProvider: stageSession?.provider,
      sessionModel: stageSession?.model,
      sessionWorktree: stageSession?.worktreePath ?? stageSession?.workingDirectory
    };
  }, started.runId);

  // The stage genuinely ran and its declared artifact is recorded.
  expect(detail.outcome).toBe('succeeded');
  expect(detail.hasSessionId).toBe(true);
  expect(detail.artifacts).toEqual(['review-report']);
  expect(detail.gate).toBe('passed');

  // A real, attributed agent session exists and finished against the mock.
  expect(detail.sessionState).toBe('completed');
  expect(detail.sessionProvider).toBe('vercel-gateway');
  expect(detail.sessionModel).toBeTruthy();
  expect(detail.sessionWorktree).toBeTruthy();

  // Workflow stage runtime provenance stays visible, but cannot be changed
  // independently of the stage that owns it.
  await openSession(page);
  const providerChip = page.getByTestId('session-provider');
  const modelChip = page.getByTestId('session-model');
  await expect(providerChip).toContainText('Vercel AI Gateway');
  await expect(modelChip).toContainText(detail.sessionModel as string);
  expect(await providerChip.evaluate(element => element.tagName)).toBe('SPAN');
  expect(await modelChip.evaluate(element => element.tagName)).toBe('SPAN');

  // The mock gateway actually received the chat request — proof the real
  // provider path executed, not a stub.
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests.some(r => r.authorization === 'Bearer e2e-key')).toBe(true);

  // Approval was unlocked by the agent-satisfied gate.
  await expect
    .poll(async () =>
      page.evaluate(async runId => {
        const s = await window.praxis.workflows.approveRun(runId, 'e2e');
        return s.status;
      }, started.runId)
    )
    .toBe('succeeded');
});

test('an agent stage with a missing Agent Hub binding is rejected before a run or session exists', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'unused' });
  const repo = createRepository();

  // A plain profile: no agent on disk, so `wf-reviewer` cannot be discovered.
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', workingDirectory: repo } },
    undefined,
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;

  const failure = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Untrusted', key: 'UNT', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'x', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: `u-${project.id}`, name: 'U', scope: 'project', projectId: project.id,
      version: 1, entryNodeId: 'review', createdAt: now, updatedAt: now,
      nodes: [
        {
          type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
          agent: { agentId: 'ghost-agent', scope: 'global', toolMode: 'read-only' },
          instructions: 'Review.', outputs: [{ id: 'r', kind: 'report', required: true }],
          mutatesWorktree: false, satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: ['r'],
          prompt: 'ok?', requiredGates: ['qa'], allowBypass: false
        }
      ],
      edges: [{ id: 'e1', from: 'review', to: 'approve', on: 'success', required: true }]
    } as never);
    try {
      await window.praxis.workflows.startRun(project.id, `u-${project.id}`, 'x');
      return { started: true };
    } catch (cause) {
      const sessions = await window.praxis.ai.listSessions();
      return {
        started: false,
        message: cause instanceof Error ? cause.message : String(cause),
        sessionOpened: sessions.some(session => session.workflowId === `u-${project.id}`)
      };
    }
  }, repo);

  expect(failure.started).toBe(false);
  expect(failure.message).toMatch(/not in the .* catalog|not trusted|preflight/i);
  expect(failure.sessionOpened).toBe(false);
  expect(mock.requests.length).toBe(0);
});
