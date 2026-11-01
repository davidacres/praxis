import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * A read-only Plan stage on an agent that ends its turn when a tool is refused, as Copilot does.
 *
 * TASK-501's Plan failed three times in ten seconds: the planner opened with a shell command, the
 * read-only stage refused it, Copilot stopped ("Operation cancelled by user"), and the stage had
 * no plan. A command that only reads is now let through, and a turn a refusal ended is continued
 * with the reason instead of failing the stage.
 */

test.slow();

const AGENT = path.join(__dirname, 'fixtures', 'refusalEndsTurnAcpAgent.mjs');
let app: TestApp | undefined;
const roots: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('a read-only plan stage may run git status, and is continued after a refused command ends its turn', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-readonly-shell-'));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-readonly-shell-log-')), 'agent.log');
  roots.push(repo, path.dirname(log));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-m', 'initial');

  app = await launchTestApp({
    ai: {
      activeProvider: 'copilot-cli', workingDirectory: repo,
      providers: {
        'copilot-cli': { cliPath: AGENT },
        'codex-cli': { enabled: false }, 'claude-code-cli': { enabled: false },
        'antigravity-cli': { enabled: false }, 'cursor-cli': { enabled: false }
      }
    }
  }, undefined, { REFUSAL_AGENT_LOG: log }, { openNewSession: false });
  const page = app.window;

  const runId = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Read-only shell', key: 'ROS', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath: repoPath,
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [], defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.agentRuntime.refresh();
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: `ros-${project.id}`, name: 'Plan only', scope: 'project', projectId: project.id,
      version: 1, entryNodeId: 'plan', createdAt: now, updatedAt: now,
      nodes: [
        {
          type: 'agent-task', id: 'plan', name: 'Plan', x: 0, y: 0, inputs: [],
          agent: { agentId: 'praxis-reviewer', profileId: 'praxis-reviewer', hostId: 'praxis-reviewer', scope: 'global', toolMode: 'read-only' },
          instructions: 'Plan the change.', outputs: [{ id: 'plan', kind: 'plan', required: true }], mutatesWorktree: false
        },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: ['plan'], prompt: 'Go?', requiredGates: [], allowBypass: false }
      ],
      edges: [{ id: 'e1', from: 'plan', to: 'approve', on: 'success', required: true }]
    } as never);
    const summary = await window.praxis.workflows.startRun(project.id, `ros-${project.id}`, 'Plan', undefined, undefined, undefined, { uncommittedChanges: 'omit', permissionMode: 'auto' });
    return summary.runId;
  }, repo);

  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId), { timeout: 60000, message: 'the plan stage should settle' })
    .not.toBe('running');
  const settled = await page.evaluate(id => window.praxis.workflows.getRun(id), runId);
  const agentLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  expect(settled?.status, `${settled?.events.map(event => event.message).join('\n')}\n--- agent:\n${agentLog}`).toBe('awaiting-approval');

  expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    'git status --short allowed',
    'npm test refused',
    'continued'
  ]);
  const plan = settled?.stages.find(stage => stage.nodeId === 'plan');
  expect(plan?.outcome).toBe('succeeded');
  expect(plan?.attempts, 'the continuation is the same attempt, not a retry').toBe(1);
});
