import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

const FAKE_ACP_AGENT = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

/**
 * Runs as tree nodes, and the run workspace.
 *
 * - Each run is a child node under its project's Workflows > Runs group, with
 *   cancel and delete on the node.
 * - Opening a run puts the session doing the work in the centre and the
 *   pipeline, top to bottom, in the right pane.
 * - A stage session nests under the controller session that started its run.
 * - Deleting a run cancels it first if it is live, then removes the run and its
 *   stage sessions.
 *
 * Everything is the production path except the LLM endpoint (the in-process
 * mock gateway).
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

function profileWithAgent(): { userDataDir: string; settingsPath: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-ws-'));
  tempDirs.push(userDataDir);
  const agentDir = path.join(userDataDir, 'agents', 'wf-reviewer');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id: 'wf-reviewer', name: 'Workflow Reviewer', type: 'gateway', entry: 'noop' })
  );
  return { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') };
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-ws-repo-'));
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

interface Seeded {
  projectId: string;
  workflowId: string;
}

/** A project with a one-agent-stage workflow (review → approve), or a slow check when `slowCheck` is set. */
async function seedProject(page: Page, repo: string, slowCheck = false, toolMode: 'read-only' | 'full' = 'read-only'): Promise<Seeded> {
  return page.evaluate(
    async ({ repoPath, slow, mode }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Workspace Delivery',
          key: 'WSD',
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
      await window.praxis.agentRuntime.refresh();
      const now = new Date().toISOString();
      const workflowId = `ws-${project.id}`;
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1,
        id: workflowId,
        name: 'Workspace review',
        scope: 'project',
        projectId: project.id,
        version: 1,
        entryNodeId: 'review',
        createdAt: now,
        updatedAt: now,
        nodes: [
          slow
            ? {
                type: 'check', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
                command: 'sleep', args: ['30'], successExitCodes: [0], timeoutMs: 60000,
                outputs: [{ id: 'review-report', kind: 'log', required: true }],
                satisfiesGate: 'qa'
              }
            : {
                type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
                agent: { agentId: 'wf-reviewer', scope: 'global', toolMode: mode },
                instructions: 'Review the change for correctness and report your findings.',
                outputs: [{ id: 'review-report', kind: 'report', required: true }],
                mutatesWorktree: mode === 'full',
                satisfiesGate: 'qa'
              },
          {
            type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: ['review-report'],
            prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
          }
        ],
        edges: [{ id: 'e1', from: 'review', to: 'approve', on: 'success', required: true }]
      } as never);
      localStorage.setItem(
        `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
        JSON.stringify({ projectId: project.id, feature: 'workflows' })
      );
      return { projectId: project.id, workflowId };
    },
    { repoPath: repo, slow: slowCheck, mode: toolMode }
  );
}

async function launch(
  slowCheck = false,
  mode: 'complete' | 'error' = 'complete',
  extra: { toolMode?: 'read-only' | 'full'; toolCall?: { name: string; arguments: Record<string, unknown> }; withCodex?: boolean } = {}
): Promise<{ page: Page; seeded: Seeded }> {
  mock = await startMockGatewayServer({
    mode,
    ...(extra.toolCall ? { toolCall: extra.toolCall } : {}),
    reply: 'Reviewed the implementation snapshot: the change is correct and complete.'
  });
  const repo = createRepository();
  app = await launchTestApp(
    {
      ai: {
        activeProvider: 'vercel-gateway',
        workingDirectory: repo,
        // A second AI to switch to: the fake ACP agent standing in for Codex. The
        // other local AIs are turned off, so a real CLI on this machine is never picked.
        ...(extra.withCodex
          ? {
              providers: {
                'codex-cli': { cliPath: FAKE_ACP_AGENT },
                'claude-code-cli': { enabled: false },
                'copilot-cli': { enabled: false },
                'antigravity-cli': { enabled: false }
              }
            }
          : {})
      }
    },
    profileWithAgent(),
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;
  const seeded = await seedProject(page, repo, slowCheck, extra.toolMode);
  return { page, seeded };
}

const runStatus = (page: Page, runId: string) =>
  page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId);

test('a controller session starts a run: the run is a tree node, its stage session nests under the controller and fills the centre', async () => {
  const { page, seeded } = await launch();

  // A controller chat session, then a run it controls.
  const controller = await page.evaluate(async projectId => {
    const created = await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      projectId,
      toolMode: 'read-only',
      task: { goal: 'Coordinate the delivery run.' }
    });
    const record = (await window.praxis.ai.listSessions()).find(session => session.issueKey === created.issueKey);
    return { key: created.issueKey, id: record?.sessionId ?? '' };
  }, seeded.projectId);
  expect(controller.id).not.toBe('');

  const run = await page.evaluate(
    async ({ seededIds, ctl }) =>
      window.praxis.workflows.startRun(seededIds.projectId, seededIds.workflowId, 'Agent-driven', undefined, {
        sessionKey: ctl.key,
        sessionId: ctl.id
      }),
    { seededIds: seeded, ctl: controller }
  );
  await expect.poll(() => runStatus(page, run.runId), { timeout: 30000 }).toBe('awaiting-approval');

  // The stage session records the controller that spawned it.
  const stageSession = await page.evaluate(async runId => {
    const found = (await window.praxis.ai.listSessions()).find(
      session => session.workflowRunId === runId && session.workflowNodeId === 'review'
    );
    return found ? { key: found.issueKey, parent: found.parentSessionKey } : undefined;
  }, run.runId);
  expect(stageSession?.parent).toBe(controller.key);

  await page.reload();

  // Sessions tree: the stage session is nested under its controller.
  await page.getByTestId('nav-sessions').click();
  const childRow = page.locator(`[data-testid="session-list-row"][data-parent-session="${controller.key}"]`);
  await expect(childRow).toHaveCount(1);
  await expect(childRow).toHaveClass(/session-nav-row--child/);
  // Collapsing the controller hides its child; expanding brings it back.
  const toggle = page.getByTestId('session-children-toggle').first();
  await toggle.click();
  await expect(childRow).toHaveCount(0);
  await toggle.click();
  await expect(childRow).toHaveCount(1);

  // Workflows tree: the run is a node under Runs; opening it fills the workspace.
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  const runRow = page.getByTestId('project-workflow-run-row').filter({ hasText: /Workspace review/ });
  await expect(runRow).toHaveCount(1);
  await expect(runRow).toHaveAttribute('data-run-status', 'awaiting-approval');
  await runRow.getByRole('button').first().click();

  // Centre: the session doing the work. Right pane: the pipeline, vertically.
  await expect(page.getByTestId('wf-run-session')).toBeVisible();
  await expect(page.getByTestId('wf-run-session').locator('.session-console')).toBeVisible();
  const pipeline = page.getByTestId('wf-run-panel').getByTestId('wf-vpipe');
  await expect(pipeline).toBeVisible();
  const review = pipeline.getByTestId('wf-vpipe-step-review');
  const approve = pipeline.getByTestId('wf-vpipe-step-approve');
  await expect(review).toHaveAttribute('data-lane', 'done');
  await expect(approve).toHaveAttribute('data-lane', 'awaiting');
  // Vertical: the second step sits below the first, not beside it.
  const [reviewBox, approveBox] = [await review.boundingBox(), await approve.boundingBox()];
  expect(approveBox!.y).toBeGreaterThan(reviewBox!.y + reviewBox!.height - 1);
  expect(Math.abs(approveBox!.x - reviewBox!.x)).toBeLessThan(4);

  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'workflow-run-workspace.png'), fullPage: true });

  // The pipeline drives the centre: the approval step has no session.
  await approve.click();
  await expect(page.getByTestId('wf-run-nosession')).toBeVisible();
  await expect(page.getByTestId('wf-run-follow')).toBeVisible();
  await page.getByTestId('wf-run-follow').click();
  await expect(page.getByTestId('wf-run-session')).toBeVisible();

  // Cancel from the tree node.
  await runRow.hover();
  await page.getByTestId(`project-run-cancel-${run.runId}`).click();
  await expect.poll(() => runStatus(page, run.runId)).toBe('cancelled');
  await expect(runRow).toHaveAttribute('data-run-status', 'cancelled');
  // A settled run offers no cancel.
  await expect(page.getByTestId(`project-run-cancel-${run.runId}`)).toHaveCount(0);

  // Delete from the tree node: a themed confirm, then the run, its stage
  // session and its link on the controller are all gone; the controller stays.
  await runRow.hover();
  await page.getByTestId(`project-run-delete-${run.runId}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete run', exact: true }).click();
  await expect(runRow).toHaveCount(0);
  await expect.poll(() => runStatus(page, run.runId)).toBeUndefined();
  const after = await page.evaluate(async key => {
    const sessions = await window.praxis.ai.listSessions();
    return {
      stageLeft: sessions.filter(session => session.workflowNodeId === 'review').length,
      controller: sessions.find(session => session.issueKey === key),
    };
  }, controller.key);
  expect(after.stageLeft).toBe(0);
  expect(after.controller?.workflowRunIds ?? []).toEqual([]);
  // The workspace for a deleted run does not linger.
  await expect(page.getByTestId('wf-run-page')).toHaveCount(0);
});

test('deleting a live run cancels it first, then removes it', async () => {
  const { page, seeded } = await launch(true);

  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Slow one'),
    seeded
  );
  await expect.poll(() => runStatus(page, run.runId), { timeout: 20000 }).toBe('running');

  await page.reload();
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  const runRow = page.getByTestId('project-workflow-run-row').filter({ hasText: /Workspace review/ });
  await expect(runRow).toHaveAttribute('data-run-status', 'running');
  await expect(runsGroup).toContainText('1');

  await runRow.hover();
  await page.getByTestId(`project-run-delete-${run.runId}`).click();
  // The confirm says the run is live and will be cancelled first.
  await expect(page.getByRole('dialog')).toContainText(/cancelled first/i);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete run', exact: true }).click();

  await expect(runRow).toHaveCount(0);
  await expect.poll(() => runStatus(page, run.runId)).toBeUndefined();
});

test('the start-run dialog opens from a workflow row with that workflow preselected, and lands on the new run', async () => {
  const { page, seeded } = await launch(true);
  await page.reload();

  await page.getByTestId('project-workflow-nav-item').hover();
  await page.getByTestId(`project-workflow-run-${seeded.workflowId}`).click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Run task').fill('From the workflow row');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(page.getByTestId('wf-run-panel')).toBeVisible();
  await expect(page.getByTestId('wf-run-bar')).toContainText('Workspace review');
  // A check stage has no conversation: the centre says so rather than staying blank.
  await expect(page.getByTestId('wf-run-nosession')).toBeVisible();
  await expect(page.getByTestId('project-workflow-run-row')).toHaveCount(1);
});

const gitOut = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function startFromDirtyCheckout(choice: 'uncommitted-base-include' | 'uncommitted-base-omit' | 'uncommitted-base-commit'): Promise<{ page: Page; repo: string; runId: string }> {
  const { page, seeded } = await launch(true);
  const project = await page.evaluate(() => window.praxis.projects.list().then(list => list[0]));
  const repo = project.workspaceFolder as string;
  fs.writeFileSync(path.join(repo, 'unsaved.ts'), 'export const draft = 1;\n');
  fs.appendFileSync(path.join(repo, 'README.md'), 'local edit\n');
  await page.reload();

  await page.getByTestId('project-workflow-nav-item').hover();
  await page.getByTestId(`project-workflow-run-${seeded.workflowId}`).click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await dialog.getByLabel('Run task').fill('Start with local edits');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();

  const notice = dialog.getByTestId('uncommitted-base-notice');
  await expect(notice).toContainText('2 uncommitted files in this checkout');
  await expect(notice).toContainText('unsaved.ts');
  await expect(page.getByTestId('project-workflow-run-row')).toHaveCount(0);

  await dialog.getByTestId(choice).click();
  await expect(page.getByTestId('wf-run-panel')).toBeVisible();
  await expect(page.getByTestId('project-workflow-run-row')).toHaveCount(1);
  const run = await page.evaluate(id => window.praxis.workflows.listRuns(id).then(runs => runs[0]), project.id);
  return { page, repo, runId: (run as { runId: string }).runId };
}

/** The run's checkout: the only directory under the repo's `.worktrees`. */
const runWorktree = (repo: string): string | undefined => {
  const root = path.join(repo, '.worktrees');
  const [name] = fs.existsSync(root) ? fs.readdirSync(root) : [];
  return name ? path.join(root, name) : undefined;
};

test('a dirty checkout offers to include its changes: the run sees them, the checkout is untouched', async () => {
  const { repo } = await startFromDirtyCheckout('uncommitted-base-include');
  await expect.poll(() => runWorktree(repo)).toBeTruthy();
  const worktree = runWorktree(repo) as string;
  expect(fs.readFileSync(path.join(worktree, 'unsaved.ts'), 'utf8')).toContain('draft = 1');
  expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toContain('local edit');
  expect(gitOut(worktree, 'log', '-1', '--format=%s')).toMatch(/^WIP snapshot: uncommitted changes/);
  // The user's own checkout keeps its edits as uncommitted and unstaged: nothing was committed or staged.
  expect(gitOut(repo, 'status', '--porcelain')).toContain('?? unsaved.ts');
  expect(gitOut(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
  expect(gitOut(repo, 'log', '-1', '--format=%s').trim()).toBe('initial');
});

test('a dirty checkout can instead start from the last commit without its changes', async () => {
  const { repo } = await startFromDirtyCheckout('uncommitted-base-omit');
  await expect.poll(() => runWorktree(repo)).toBeTruthy();
  const worktree = runWorktree(repo) as string;
  expect(fs.existsSync(path.join(worktree, 'unsaved.ts'))).toBe(false);
  expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).not.toContain('local edit');
});

test('a dirty checkout can commit its changes, then the run starts from that commit', async () => {
  const { repo } = await startFromDirtyCheckout('uncommitted-base-commit');
  await expect.poll(() => runWorktree(repo)).toBeTruthy();
  const worktree = runWorktree(repo) as string;
  expect(fs.readFileSync(path.join(worktree, 'unsaved.ts'), 'utf8')).toContain('draft = 1');
  // The changes are now a real commit in the user's checkout, which is left clean.
  expect(gitOut(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^WIP: save changes/);
  expect(gitOut(repo, 'status', '--porcelain', '--', 'unsaved.ts', 'README.md').trim()).toBe('');
});

test('an out-of-credits provider pauses the run instead of failing it, and resumes once credits are back', async () => {
  // Every chat request is answered "Insufficient balance … Please recharge."
  const { page, seeded } = await launch(false, 'error');

  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Out of credits'),
    seeded
  );

  // The stage's session dies on the limit; the run pauses rather than failing.
  await expect
    .poll(
      async () =>
        page.evaluate(async id => {
          const summary = await window.praxis.workflows.getRun(id);
          return summary?.stages.find(stage => stage.nodeId === 'review')?.pause === 'provider-limit';
        }, run.runId),
      { timeout: 60000 }
    )
    .toBe(true);

  const paused = await page.evaluate(async id => {
    const summary = await window.praxis.workflows.getRun(id);
    const stage = summary?.stages.find(row => row.nodeId === 'review');
    return {
      status: summary?.status,
      paused: summary?.paused,
      endedAt: summary?.endedAt,
      lane: stage?.lane,
      outcome: stage?.outcome,
      retry: summary?.actions.some(action => action.kind === 'retry-stage' && action.nodeId === 'review'),
      explanation: summary?.explanation
    };
  }, run.runId);
  expect(paused.status).toBe('running');
  expect(paused.paused).toBe(true);
  expect(paused.endedAt).toBeUndefined();
  expect(paused.lane).toBe('paused');
  expect(paused.outcome).toBe('failed');
  // maxAttempts is 1, yet Retry is still offered — the limit did not spend it.
  expect(paused.retry).toBe(true);
  expect(paused.explanation).toMatch(/Vercel AI Gateway ran out of credits or hit its usage limit/);

  // The UI says paused, not failed, and offers one way forward.
  await page.reload();
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  const runRow = page.getByTestId('project-workflow-run-row').filter({ hasText: /Workspace review/ });
  await expect(runRow).toHaveAttribute('data-run-status', 'paused');
  await runRow.getByRole('button').first().click();
  await expect(page.getByTestId('wf-run-limit')).toBeVisible();
  await expect(page.getByTestId('wf-vpipe-step-review')).toHaveAttribute('data-lane', 'paused');
  await expect(page.getByTestId('wf-run-bar')).toContainText('paused');
  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'workflow-run-paused-limit.png'), fullPage: true });

  // Credits are back: Resume re-runs the stage and the run carries on.
  mock!.setMode('complete');
  await page.getByTestId('wf-run-resume').click();
  await expect.poll(() => runStatus(page, run.runId), { timeout: 30000 }).toBe('awaiting-approval');
  await expect(page.getByTestId('wf-run-limit')).toHaveCount(0);
  await expect(page.getByTestId('wf-vpipe-step-review')).toHaveAttribute('data-lane', 'done');
});

test('a stage whose AI ran out can be switched to another AI and carries on', async () => {
  const { page, seeded } = await launch(false, 'error', { withCodex: true });
  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Switch AI'), seeded);
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(summary => summary?.stages.find(stage => stage.nodeId === 'review')?.pause), run.runId), { timeout: 60000 })
    .toBe('provider-limit');

  await page.reload();
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  await page.getByTestId('project-workflow-run-row').filter({ hasText: /Switch AI/ }).getByRole('button').first().click();
  const notice = page.getByTestId('wf-run-limit');
  await expect(notice).toContainText('Vercel AI Gateway ran out of budget');
  await expect(notice.getByTestId('wf-limit-switch-to')).toHaveValue('codex-cli');
  await expect(notice.getByTestId('wf-run-resume')).toHaveText('Retry on Vercel AI Gateway');
  await expect(notice.getByTestId('wf-limit-stop')).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.resolve(process.cwd(), 'output', 'playwright', 'workflow-limit-ask.png') });

  await notice.getByTestId('wf-limit-switch').click();
  await expect(notice).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(summary => summary?.stages.find(stage => stage.nodeId === 'review')?.provider), run.runId), { timeout: 30000 })
    .toBe('codex-cli');
  const summary = await page.evaluate(id => window.praxis.workflows.getRun(id), run.runId);
  expect(summary?.events.some(event => event.kind === 'node-provider-switched' && /switched from Vercel AI Gateway to Codex after Vercel AI Gateway ran out/.test(event.message))).toBe(true);
  expect(summary?.exhaustedProviders).toEqual(['vercel-gateway']);
});

test('with "Switch AI automatically" the stage moves to another AI without asking', async () => {
  const { page, seeded } = await launch(false, 'error', { withCodex: true });
  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Auto switch', undefined, undefined, undefined, { providerLimitPolicy: 'switch' }),
    seeded
  );
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(summary => summary?.stages.find(stage => stage.nodeId === 'review')?.provider), run.runId), { timeout: 60000 })
    .toBe('codex-cli');
  const summary = await page.evaluate(id => window.praxis.workflows.getRun(id), run.runId);
  expect(summary?.providerLimitPolicy).toBe('switch');
  expect(summary?.events.some(event => /switched from Vercel AI Gateway to Codex automatically/.test(event.message))).toBe(true);
});

test('with "Stop the run" the run ends saying which AI ran out, and can still carry on with another AI', async () => {
  const { page, seeded } = await launch(false, 'error', { withCodex: true });
  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Stop on limit', undefined, undefined, undefined, { providerLimitPolicy: 'stop' }),
    seeded
  );
  await expect.poll(() => runStatus(page, run.runId), { timeout: 60000 }).toBe('failed');
  const summary = await page.evaluate(id => window.praxis.workflows.getRun(id), run.runId);
  expect(summary?.events.at(-1)?.message).toMatch(/The run could not be completed: Vercel AI Gateway ran out of credits or hit its usage limit at /);

  await page.reload();
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  await page.getByTestId('project-workflow-run-row').filter({ hasText: /Stop on limit/ }).getByRole('button').first().click();
  const notice = page.getByTestId('wf-run-limit');
  await expect(notice).toContainText('The run could not be completed');
  await expect(notice.getByTestId('wf-limit-stop')).toHaveCount(0);
  await notice.getByTestId('wf-limit-switch').click();
  await expect.poll(() => runStatus(page, run.runId), { timeout: 30000 }).not.toBe('failed');
});

const WRITE_CALL = { name: 'write_file', arguments: { path: 'note.txt', content: 'written by the stage' } };

test('a run in Ask mode stops the stage for a tool permission; the same run in Auto-approve mode does not', async () => {
  // ── Ask (the default): the write_file request waits for a person.
  const asked = await launch(false, 'complete', { toolMode: 'full', toolCall: WRITE_CALL });
  const askRun = await asked.page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Ask me'),
    asked.seeded
  );
  expect(askRun.permissionMode).toBe('ask');

  const stageKey = await asked.page.evaluate(async id => {
    for (let i = 0; i < 100; i += 1) {
      const found = (await window.praxis.ai.listSessions()).find(
        session => session.workflowRunId === id && session.workflowNodeId === 'review'
      );
      if (found?.state === 'awaiting_approval') return found.issueKey;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return undefined;
  }, askRun.runId);
  expect(stageKey, 'the stage session should be waiting on a permission').toBeDefined();
  expect(await runStatus(asked.page, askRun.runId)).toBe('running');

  // The run panel says which mode it is in.
  await asked.page.reload();
  const runsGroup = asked.page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  await asked.page.getByTestId('project-workflow-run-row').first().getByRole('button').first().click();
  await expect(asked.page.getByTestId('wf-run-mode')).toHaveAttribute('data-mode', 'ask');

  // Allowing it lets the stage finish and the run reach approval.
  await asked.page.evaluate(key => window.praxis.ai.respondToPermission(key as string, 'allow'), stageKey);
  await expect.poll(() => runStatus(asked.page, askRun.runId), { timeout: 30000 }).toBe('awaiting-approval');
  await closeTestApp(app!);
  await mock!.close();
  app = undefined;
  mock = undefined;

  // ── Auto-approve: the same request is allowed without stopping.
  const auto = await launch(false, 'complete', { toolMode: 'full', toolCall: WRITE_CALL });
  const autoRun = await auto.page.evaluate(
    async ids =>
      window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Do not ask', undefined, undefined, undefined, {
        permissionMode: 'auto'
      }),
    auto.seeded
  );
  expect(autoRun.permissionMode).toBe('auto');

  // No one answers anything; the run gets to the human approval on its own.
  await expect.poll(() => runStatus(auto.page, autoRun.runId), { timeout: 60000 }).toBe('awaiting-approval');

  const record = await auto.page.evaluate(async id => {
    const session = (await window.praxis.ai.listSessions()).find(
      candidate => candidate.workflowRunId === id && candidate.workflowNodeId === 'review'
    );
    return {
      autoApprove: session?.autoApprovePermissions,
      asked: session?.events?.some(event => event.type === 'permission_requested') ?? false
    };
  }, autoRun.runId);
  expect(record.autoApprove).toBe(true);
  expect(record.asked).toBe(false);

  // Auto-approve never approves the run itself: a person still has to.
  expect(await runStatus(auto.page, autoRun.runId)).toBe('awaiting-approval');
});

test('auto-approve does not widen a stage: a read-only stage still cannot write', async () => {
  const { page, seeded } = await launch(false, 'complete', { toolMode: 'read-only', toolCall: WRITE_CALL });
  const run = await page.evaluate(
    async ids =>
      window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Read only', undefined, undefined, undefined, {
        permissionMode: 'auto'
      }),
    seeded
  );
  await expect.poll(() => runStatus(page, run.runId), { timeout: 60000 }).toBe('awaiting-approval');

  const outcome = await page.evaluate(async id => {
    const session = (await window.praxis.ai.listSessions()).find(
      candidate => candidate.workflowRunId === id && candidate.workflowNodeId === 'review'
    );
    return { toolMode: session?.toolMode, cwd: session?.worktreePath ?? session?.workingDirectory };
  }, run.runId);
  expect(outcome.toolMode).toBe('read-only');
  // The file the model asked to write must not exist in the run's worktree.
  const exists = outcome.cwd ? fs.existsSync(path.join(outcome.cwd, 'note.txt')) : false;
  expect(exists).toBe(false);
});

test('a terminal run can be archived, removing it from the sidebar and listing it in the workflow runs browser', async () => {
  const { page, seeded } = await launch();
  const run = await page.evaluate(
    async ids =>
      window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Archive test run'),
    seeded
  );
  await expect.poll(() => runStatus(page, run.runId), { timeout: 30000 }).toBe('awaiting-approval');

  // Cancel the run so it is terminal
  await page.evaluate(async id => window.praxis.workflows.cancelRun(id, 'cancel for test'), run.runId);
  await expect.poll(() => runStatus(page, run.runId)).toBe('cancelled');

  await page.reload();

  // Open the Workflows > Runs tree in the sidebar
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  const runRow = page.getByTestId('project-workflow-run-row').filter({ hasText: /Workspace review/ });
  await expect(runRow).toHaveCount(1);

  // Archive button on the sidebar run row
  await runRow.hover();
  const archiveBtn = page.getByTestId(`project-run-archive-${run.runId}`);
  await expect(archiveBtn).toBeVisible();
  await archiveBtn.click();

  // It is now removed from the active runs tree
  await expect(runRow).toHaveCount(0);

  // Clicking the Runs header opens the workflow runs browser
  await runsGroup.click();
  await expect(page.getByTestId('wf-runs-browser')).toBeVisible();

  // In the runs browser, toggle open the Archived group
  const archivedToggle = page.getByTestId('wf-runs-archived-toggle');
  await expect(archivedToggle).toBeVisible();
  await archivedToggle.click();

  const archivedCard = page.getByTestId(`wf-run-card-${run.runId}`);
  await expect(archivedCard).toBeVisible();

  // Unarchive / restore the run
  const restoreBtn = page.getByTestId(`wf-run-restore-${run.runId}`);
  await expect(restoreBtn).toBeVisible();
  await restoreBtn.click();

  // The run appears back in the active list and sidebar tree
  await expect(page.getByTestId('project-workflow-run-row').filter({ hasText: /Workspace review/ })).toHaveCount(1);
});
