import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

test.slow();
let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const roots: string[] = [];
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('scheduled allowance handover checkpoints and continues the active stage in the same session', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-scheduled-handover-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-scheduled-handover-repo-'));
  roots.push(profile, repo);
  const agentDir = path.join(profile, 'agents', 'scheduled-reviewer');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ schemaVersion: 1, id: 'scheduled-reviewer', name: 'Scheduled reviewer', type: 'gateway', entry: 'session' }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'initial');
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp({
    ai: {
      activeProvider: 'vercel-gateway', workingDirectory: repo,
      providers: {
        'codex-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') },
        'claude-code-cli': { enabled: false }, 'copilot-cli': { enabled: false },
        'antigravity-cli': { enabled: false }, 'cursor-cli': { enabled: false }
      }
    }
  }, { userDataDir: profile, settingsPath: path.join(profile, 'settings.json') }, {
    AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined,
    PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'vercel-gateway': 0.1, 'codex-cli': 0.1 })
  }, { openNewSession: false });
  const page = app.window;
  const scheduleId = await page.evaluate(async repo => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Handover', key: 'HND', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repo,
      workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Continue this ticket', description: '', issueType: 'Task', status: 'Backlog' }], defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.agentRuntime.refresh();
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: 'scheduled-handover', name: 'Scheduled handover', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'review', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [], agent: { agentId: 'scheduled-reviewer', scope: 'global', toolMode: 'read-only' }, instructions: 'Review the ticket and report your findings.', outputs: [{ id: 'review-report', kind: 'report', required: true }], mutatesWorktree: false },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: ['review-report'], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ], edges: [{ id: 'next', from: 'review', to: 'approve', on: 'success', required: true }]
    } as never);
    const issues = await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 10, `project:${project.id}`);
    const view = await window.praxis.scheduledRuns.save({ projectId: project.id, name: 'Handover', timezone: 'UTC', date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), time: '12:00', workflowId: 'scheduled-handover', tickets: issues.issues.map(issue => ({ connectionId: `project:${project.id}`, issueKey: issue.key, title: issue.summary })) });
    await window.praxis.scheduledRuns.startNow(view.run.id);
    return view.run.id;
  }, repo);
  await expect.poll(() => mock!.requests.length).toBeGreaterThan(0);
  const original = await page.evaluate(async () => (await window.praxis.ai.listSessions()).find(session => session.workflowRole === 'stage'));
  expect(['planning', 'executing']).toContain(original?.state);
  expect(original?.worktreePath).toBeTruthy();
  fs.writeFileSync(path.join(original!.worktreePath!, 'checkpoint.txt'), 'work before handover\n');
  await app.electronApp.evaluate(() => { process.env.PRAXIS_E2E_PROVIDER_USAGE = JSON.stringify({ 'vercel-gateway': 0.95, 'codex-cli': 0.1 }); });
  await expect.poll(async () => (await page.evaluate(id => window.praxis.scheduledRuns.get(id), scheduleId))?.run.entries[0].outcome?.handovers?.length, { timeout: 30000 }).toBe(1);
  const view = await page.evaluate(id => window.praxis.scheduledRuns.get(id), scheduleId);
  const outcome = view!.run.entries[0].outcome!;
  expect(outcome.workflowRunId).toBe(original!.workflowRunId);
  expect(outcome.handovers![0].usedPercent).toBe(95);
  const checkpoint = outcome.handovers![0].checkpointRef!;
  expect(execFileSync('git', ['show', `${checkpoint}:checkpoint.txt`], { cwd: original!.worktreePath!, encoding: 'utf8' })).toBe('work before handover\n');
  const replacement = await page.evaluate(async key => (await window.praxis.ai.listSessions()).find(session => session.issueKey === key), original!.issueKey);
  expect(replacement?.sessionId).toBe(original!.sessionId);
  expect(replacement?.provider).toBe('codex-cli');
  expect(replacement?.handoverBrief?.revision).toBeGreaterThan(0);
  await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.getRun(id), outcome.workflowRunId!))?.status, { timeout: 30000 }).toBe('awaiting-approval');
  await expect.poll(async () => (await page.evaluate(id => window.praxis.scheduledRuns.get(id), scheduleId))?.run.entries[0].outcome?.artifacts?.length).toBeGreaterThan(0);
});
