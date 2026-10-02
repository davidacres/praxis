import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp as launchApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/**
 * FX-BE-022 — the run monitor and the governed delivery pipeline end to end.
 *
 * Drives the built-in Governed delivery template through a run: the parallel
 * review / QA / security branches converge at the join, approval stays
 * unavailable until every required gate resolves, a run can be cancelled, and a
 * run's completed stages survive an app restart without being re-run.
 *
 * Stages are advanced explicitly from the monitor (FX-BF-011 will drive them
 * from real agent sessions); that is exactly the seam this test exercises.
 */

// Each test boots a full Electron app; the default 30s is tight under
// suite-wide parallelism.
test.slow();

// These workflows advance agent stages manually. Satisfy runtime preflight
// with an isolated test key; no model request is made by those stages.
const launchTestApp: typeof launchApp = (seed, reuse, env, options) => launchApp(seed, reuse, {
  AI_GATEWAY_API_KEY: 'e2e-manual-workflow', AI_GATEWAY_URL: 'http://127.0.0.1:1', VERCEL_OIDC_TOKEN: undefined, ...env
}, options);

let app: TestApp;

async function seedProject(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Delivery Project',
        key: 'DELIV',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'backlog', name: 'Backlog' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    // Instantiate the built-in template as this project's workflow up front.
    await window.praxis.workflows.instantiate(project.id, 'governed-delivery');
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await page.reload();
}

/** The run workspace's right pane: status, pipeline, stage detail, gates, timeline. */
function runPanel(page: Page) {
  return page.getByTestId('wf-run-panel');
}

/** Starts a run from its workflow row and lands on its workspace. */
async function startRun(page: Page, task: string, options: { ticket?: string } = {}): Promise<void> {
  await page.getByRole('button', { name: /^Start a run of / }).first().click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Run task').fill(task);
  if (options.ticket) {
    const ticketField = page.getByTestId('wf-runstart-issue');
    await expect(ticketField).toBeVisible({ timeout: 10000 });
    await chooseOption(ticketField, options.ticket);
  }
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(runPanel(page)).toBeVisible();
}

/** Opens an existing workflow run from the project's Sessions group. */
async function openRun(page: Page, name: RegExp = /./): Promise<void> {
  const row = page.getByTestId('project-workflow-run-row').filter({ hasText: name }).first();
  const toggle = row.getByRole('button').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await row.getByTestId('automation-run-open').click();
  await expect(runPanel(page)).toBeVisible();
}

/** Selects a stage in the pipeline, then marks it done from its detail. */
async function markDone(page: Page, stageName: string): Promise<void> {
  await runPanel(page)
    .getByRole('button', { name: new RegExp(`^${stageName} `) })
    .click();
  await runPanel(page).getByRole('button', { name: 'Mark done' }).click();
}

/** The detail text for a stage, selected via the pipeline. */
async function stageDetail(page: Page, stageName: string) {
  await runPanel(page)
    .getByRole('button', { name: new RegExp(`^${stageName} `) })
    .click();
  return runPanel(page);
}

test.afterEach(async () => {
  await closeTestApp(app);
});

test('runs the governed pipeline: parallel branches converge, then approval unlocks', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page);

  // Start a run of the project's Governed delivery workflow.
  await startRun(page, 'Ship the widget');

  const runDetail = runPanel(page);
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  const gatesNode = runDetail.getByRole('button', { name: /^Gates / });
  await expect(runDetail.getByRole('status')).toContainText(/waiting for the next stage|Stage in progress|Plan/i);

  // Plan → Implement → Praxis Test contracts are serial (Implement writes the worktree).
  await markDone(page, 'Plan');
  await markDone(page, 'Implement');
  await markDone(page, 'Praxis Test contracts');

  // Review and Security are ready at once; QA waits for the dependencies to be installed and built.
  await markDone(page, 'Install dependencies');
  await markDone(page, 'Build');
  await markDone(page, 'Review');
  await markDone(page, 'QA');

  // Approval is still blocked — the security branch has not reached the join.
  await expect(approve).toBeDisabled();
  await expect(runDetail.getByRole('button', { name: /^Security scan / })).toBeVisible();
  await expect(gatesNode).not.toHaveAttribute('aria-label', /done/);

  await expect(runPanel(page)).toHaveScreenshot('workflow-run-panel.png');

  await markDone(page, 'Security scan');

  // The join has converged and the run is waiting on a human.
  await expect(gatesNode).toHaveAttribute('aria-label', /done/);
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval');

  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(runDetail.getByRole('status')).toContainText('completed');
});

test('a run can be cancelled from the monitor', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page);
  await startRun(page, 'Abandon this one');

  await markDone(page, 'Plan');
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();

  await expect(runPanel(page).getByRole('status')).toContainText('cancelled');
});

test('completed stages are not re-run after an app restart', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  let page = app.window;
  await seedProject(page);
  await startRun(page, 'Survive a restart');
  await markDone(page, 'Plan');
  await markDone(page, 'Implement');

  await expect(await stageDetail(page, 'Implement')).toContainText('succeeded');

  // Relaunch into the same profile and return to the run monitor via the sidebar.
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  page = app.window;
  await openRun(page, /Governed delivery/);

  // The two completed stages are still done, each with a single attempt.
  const restoredImplement = await stageDetail(page, 'Implement');
  await expect(restoredImplement).toContainText('succeeded');
  await expect(restoredImplement).toContainText('(1/2)');
});

/** A throwaway git repository the run can branch a worktree from. */
function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

test('a deterministic check runs on its own in the run worktree and unblocks approval', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Checked Delivery',
        key: 'CHKD',
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

    // A check-only workflow: `git --version` always exits 0 and needs nothing
    // installed, so this asserts the orchestrator, not the toolchain.
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: `checks-${project.id}`,
      name: 'Checks only',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
        }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, `checks-${project.id}`, 'Automated');
    return { runId: summary.runId, projectId: project.id };
  }, repo);

  // No manual advancement: poll until the orchestrator has driven the check.
  await expect
    .poll(
      async () =>
        page.evaluate(async runId => (await window.praxis.workflows.getRun(runId))?.status, started.runId),
      { timeout: 20000 }
    )
    .toBe('awaiting-approval');

  const detail = await page.evaluate(
    async runId => {
      const summary = await window.praxis.workflows.getRun(runId);
      const stage = summary?.stages.find(row => row.nodeId === 'verify');
      return {
        outcome: stage?.outcome,
        artifacts: stage?.artifacts.map(artifact => artifact.contractId),
        gate: summary?.gates.find(gate => gate.gate === 'qa')?.state
      };
    },
    started.runId
  );

  expect(detail.outcome).toBe('succeeded');
  expect(detail.artifacts).toEqual(['verify-log']);
  expect(detail.gate).toBe('passed');

  // The run branched a worktree off the fixture repository.
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
  expect(worktrees.split('\n').length).toBeGreaterThan(1);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('a gate the workflow allows bypassing, but no policy has granted, explains why in the run monitor', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Bypass Delivery',
        key: 'BYPS',
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

    const now = new Date().toISOString();
    const workflowId = `bypass-${project.id}`;
    // "always" (not "success") so Approve is reachable even though Verify
    // fails — this is the shape a workflow author uses when they want a gate
    // that can still be bypassed instead of dead-ending the run.
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: workflowId,
      name: 'Bypassable delivery',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'node', args: ['-e', 'process.exit(1)'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: ['qa'], allowBypass: true
        }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'always', required: true }]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, workflowId, 'Automated');
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows' })
    );
    return { runId: summary.runId, projectId: project.id };
  }, repo);

  await expect
    .poll(
      async () => page.evaluate(async runId => (await window.praxis.workflows.getRun(runId))?.status, started.runId),
      { timeout: 20000 }
    )
    .toBe('awaiting-approval');

  await page.reload();
  await openRun(page, /Bypassable delivery/);

  const runDetail = runPanel(page);
  // No policy exists in this profile, so the workflow's own permission is
  // not enough — the button must not appear, and the reason must be stated
  // rather than the option silently missing.
  await expect(runDetail.getByTestId('wf-bypass-qa')).toHaveCount(0);
  await expect(runDetail.getByTestId('wf-bypass-blocked-qa')).toContainText(/no project or global policy/);

  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'workflow-gates-bypass.png'), fullPage: true });

  // The hint links straight to the page that can actually grant the permission.
  await runDetail.getByRole('button', { name: 'Open policies' }).click();
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();

  // Granting a project policy that allows bypass closes the loop: the same
  // gate now offers the real button instead of the blocked explanation.
  await page.evaluate(async projectId => {
    const now = new Date().toISOString();
    await window.praxis.workflows.savePolicy({
      schemaVersion: 1,
      id: `policy-project-${projectId}`,
      name: 'Bypass Delivery policy',
      scope: 'project',
      projectId,
      requiredGates: [],
      requireHumanApproval: false,
      allowGateBypass: true,
      requireTrustedAgents: false,
      maxAttemptsPerNode: 3,
      createdAt: now,
      updatedAt: now
    });
  }, started.projectId);

  await page.reload();
  await openRun(page, /Bypassable delivery/);
  const runDetailAfterPolicy = runPanel(page);
  await expect(runDetailAfterPolicy.getByTestId('wf-bypass-qa')).toBeVisible();
  await expect(runDetailAfterPolicy.getByTestId('wf-bypass-blocked-qa')).toHaveCount(0);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('approving one of two simultaneously-awaiting approval nodes never touches the other', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Dual Approval Delivery',
        key: 'DUAL',
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

    // Two independent approval branches off one check, so both can await a
    // human at once — the exact shape that "always approve the first
    // approval node in the definition" got wrong.
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: `dual-approval-${project.id}`,
      name: 'Dual approval',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve-a', name: 'Approve A', x: 200, y: -80, inputs: ['verify-log'],
          prompt: 'Ship A?', requiredGates: [], allowBypass: false
        },
        {
          type: 'approval', id: 'approve-b', name: 'Approve B', x: 200, y: 80, inputs: ['verify-log'],
          prompt: 'Ship B?', requiredGates: [], allowBypass: false
        }
      ],
      edges: [
        { id: 'e1', from: 'verify', to: 'approve-a', on: 'success', required: true },
        { id: 'e2', from: 'verify', to: 'approve-b', on: 'success', required: true }
      ]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, `dual-approval-${project.id}`, 'Automated');
    return { runId: summary.runId, projectId: project.id };
  }, repo);

  // Both branches are independent, so both come up for approval at once.
  await expect
    .poll(
      async () =>
        page.evaluate(async runId => {
          const summary = await window.praxis.workflows.getRun(runId);
          return summary?.actions.filter(action => action.kind === 'approve').map(action => action.nodeId).sort();
        }, started.runId),
      { timeout: 20000 }
    )
    .toEqual(['approve-a', 'approve-b']);

  // Approving "B" explicitly must settle only "B" — not silently resolve to
  // whichever approval happens to come first in the workflow definition.
  await page.evaluate(
    async runId => window.praxis.workflows.approveRun(runId, 'e2e', undefined, 'approve-b'),
    started.runId
  );

  const afterB = await page.evaluate(async runId => {
    const summary = await window.praxis.workflows.getRun(runId);
    return {
      status: summary?.status,
      a: summary?.stages.find(row => row.nodeId === 'approve-a')?.outcome,
      b: summary?.stages.find(row => row.nodeId === 'approve-b')?.outcome
    };
  }, started.runId);
  expect(afterB.a).toBe('pending');
  expect(afterB.b).toBe('succeeded');
  expect(afterB.status).not.toBe('succeeded');

  // With only "A" left awaiting, an approval with no explicit target resolves
  // to it rather than refusing or guessing.
  await page.evaluate(async runId => window.praxis.workflows.approveRun(runId, 'e2e'), started.runId);

  const afterA = await page.evaluate(async runId => {
    const summary = await window.praxis.workflows.getRun(runId);
    return { status: summary?.status, a: summary?.stages.find(row => row.nodeId === 'approve-a')?.outcome };
  }, started.runId);
  expect(afterA.a).toBe('succeeded');
  expect(afterA.status).toBe('succeeded');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('the run monitor shows one Approve button per simultaneously-awaiting approval node, each targeting its own', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Dual Approval UI',
        key: 'DUIU',
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

    const now = new Date().toISOString();
    const workflowId = `dual-ui-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: workflowId,
      name: 'Dual approval UI',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'security-approval', name: 'Security approval', x: 200, y: -80, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: [], allowBypass: false
        },
        {
          type: 'approval', id: 'release-approval', name: 'Release approval', x: 200, y: 80, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: [], allowBypass: false
        }
      ],
      edges: [
        { id: 'e1', from: 'verify', to: 'security-approval', on: 'success', required: true },
        { id: 'e2', from: 'verify', to: 'release-approval', on: 'success', required: true }
      ]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, workflowId, 'Automated');
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows' })
    );
    return { runId: summary.runId };
  }, repo);

  await expect
    .poll(
      async () =>
        page.evaluate(async runId => {
          const summary = await window.praxis.workflows.getRun(runId);
          return summary?.actions.filter(action => action.kind === 'approve').length ?? 0;
        }, started.runId),
      { timeout: 20000 }
    )
    .toBe(2);

  await page.reload();
  await openRun(page, /Dual approval UI/);

  const runDetail = runPanel(page);
  const securityApprove = runDetail.getByRole('button', { name: /Approve at Security approval/ });
  const releaseApprove = runDetail.getByRole('button', { name: /Approve at Release approval/ });
  await expect(securityApprove).toBeVisible();
  await expect(releaseApprove).toBeVisible();
  // Neither reads as the old, ambiguous plain "Approve" — each names its own stage.
  await expect(runDetail.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'workflow-dual-approve-buttons.png'), fullPage: true });

  await releaseApprove.click();
  await expect(releaseApprove).toHaveCount(0);
  // Only one approval is left awaiting, so its button simplifies back to
  // plain "Approve" — the per-stage label exists only to disambiguate when
  // more than one is in play at once.
  await expect(runDetail.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();

  const afterRelease = await page.evaluate(async runId => {
    const summary = await window.praxis.workflows.getRun(runId);
    return {
      security: summary?.stages.find(row => row.nodeId === 'security-approval')?.outcome,
      release: summary?.stages.find(row => row.nodeId === 'release-approval')?.outcome
    };
  }, started.runId);
  expect(afterRelease.release).toBe('succeeded');
  expect(afterRelease.security).toBe('pending');

  fs.rmSync(repo, { recursive: true, force: true });
});

/** Seeds a folder-backed project with a saved check-only workflow. */
async function seedCheckWorkflow(
  page: Page,
  repoPath: string,
  check: { command: string; args: string[]; successExitCodes?: number[]; timeoutMs?: number }
): Promise<{ projectId: string; workflowId: string }> {
  return page.evaluate(
    async ({ repo, checkSpec }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Auto Delivery',
          key: 'AUTO',
          type: 'software',
          purpose: '',
          brief: {},
          startingPoint: 'existing-folder',
          folderPath: repo,
          workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
          starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
          defaultAiToolMode: 'read-only'
        },
        workspace.id
      );
      const workflowId = `auto-${project.id}`;
      const now = new Date().toISOString();
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1,
        id: workflowId,
        name: 'Auto checks',
        scope: 'project',
        projectId: project.id,
        version: 1,
        entryNodeId: 'verify',
        createdAt: now,
        updatedAt: now,
        nodes: [
          {
            type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
            command: checkSpec.command,
            args: checkSpec.args,
            successExitCodes: checkSpec.successExitCodes ?? [0],
            ...(checkSpec.timeoutMs ? { timeoutMs: checkSpec.timeoutMs } : {}),
            outputs: [{ id: 'verify-log', kind: 'log', required: true }],
            satisfiesGate: 'qa'
          },
          {
            type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
            prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
          }
        ],
        edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
      } as never);
      localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
      return { projectId: project.id, workflowId };
    },
    { repo: repoPath, checkSpec: check }
  );
}

test('the run monitor reflects an unattended run as the orchestrator drives it', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const seeded = await seedCheckWorkflow(page, repo, { command: 'git', args: ['--version'] });
  await page.reload();
  await startRun(page, 'Hands off');

  const runDetail = runPanel(page);
  // No Mark done anywhere: the check runs and the status region updates itself.
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval', { timeout: 20000 });
  await expect(await stageDetail(page, 'Verify')).toContainText('succeeded');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(runDetail.getByRole('status')).toContainText('completed');
  expect(seeded.workflowId).toContain('auto-');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('a run started against a ticket writes its outcome back as a comment once it settles', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const seeded = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Ticketed Delivery',
        key: 'TICK',
        type: 'software',
        purpose: '',
        brief: {},
        // `storage: 'folder'` is what actually backs tickets with markdown
        // (and so with a real addComment) — `startingPoint` only says how the
        // git workspace folder was obtained, a separate axis. Every other
        // project in this file is `storage: 'app'` (the default) because
        // those tests only need the git worktree, never touch ticket data.
        storage: 'folder',
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    const workflowId = `checks-${project.id}`;
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: workflowId,
      name: 'Checks only',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
        }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);
    // The connection this project's own board lives on — read from the
    // connection record, the way the app itself resolves it, not assumed from
    // its id shape.
    const connectionId = (await window.praxis.connection.list()).find(
      connection => connection.settings.projectId === project.id
    )?.id;
    // The board's own id — folder-mode boards don't necessarily reuse
    // `project.defaultBoardId`, so this is resolved the way the sidebar does,
    // from `board.list`, not assumed from a shape.
    const board = (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' })).find(
      candidate => candidate.connectionId === connectionId
    );
    if (!board) throw new Error('Expected the new project to have its own board.');
    // Folder mode requires a parent Feature/Epic under a Task; a top-level
    // Feature needs no parent, which is all this test needs a real ticket for.
    const ticket = await window.praxis.issue.create(
      { projectKey: project.key, issueType: 'Feature', summary: 'Ship the widget', boardId: board.id },
      connectionId
    );
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows' })
    );
    return { projectId: project.id, workflowId, connectionId, ticketKey: ticket.key };
  }, repo);

  // Folder-backed tickets are repository data. A governed run deliberately refuses to branch while
  // they are uncommitted because its worktree would otherwise omit the ticket it was asked to run.
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'seed ticket for governed run'], { cwd: repo });

  await page.reload();
  await startRun(page, 'Ship it', { ticket: seeded.ticketKey });

  // The run picked up the ticket — the board shows it linked immediately,
  // before the run has even settled.
  await expect(page.getByTestId('wf-board-issue-key')).toContainText(seeded.ticketKey);
  await page.screenshot({ path: 'output/playwright/workflow-run-linked-ticket.png' });

  const runDetail = runPanel(page);
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval', { timeout: 20000 });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(runDetail.getByRole('status')).toContainText('completed');

  // Write-back is best-effort and asynchronous (it runs after the settling
  // transition, not as part of it), so poll rather than asserting immediately.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ key, connectionId }) => (await window.praxis.issue.get(key, connectionId)).comments?.length ?? 0,
          { key: seeded.ticketKey, connectionId: seeded.connectionId }
        ),
      { timeout: 10000 }
    )
    .toBeGreaterThan(0);

  const comments = await page.evaluate(
    async ({ key, connectionId }) => (await window.praxis.issue.get(key, connectionId)).comments,
    { key: seeded.ticketKey, connectionId: seeded.connectionId }
  );
  expect(comments?.[0]?.body).toContain('Workflow run succeeded');
  expect(comments?.[0]?.body).toContain('Checks only');
  expect(comments?.[0]?.body).toContain('Verify: succeeded');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('a write-back that fails is visible in the Output tab, not just the main-process console', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const seeded = await seedCheckWorkflow(page, repo, { command: 'git', args: ['--version'] });
  // A ticket that was never created — the IPC itself has no picker to bounce
  // this off of, so it starts the run, settles normally, and only the
  // write-back attempt fails. Real-world equivalent: a ticket deleted between
  // when a run started and when it finished.
  await page.evaluate(
    async ({ projectId, workflowId }) =>
      window.praxis.workflows.startRun(projectId, workflowId, 'Ship it', { issueKey: 'GHOST-404' }),
    seeded
  );
  await page.reload();
  await openRun(page);

  const runDetail = runPanel(page);
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval', { timeout: 20000 });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(runDetail.getByRole('status')).toContainText('completed');

  await page.locator('[aria-label="Toggle panel"]').click();
  await page.locator('[data-testid="panel-tab-output"]').click();
  const output = page.locator('[data-testid="output-log"]');
  await expect(output).toContainText('[workflow]', { timeout: 10000 });
  await expect(output).toContainText('GHOST-404');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('a check that outruns its timeout is failed with a stated reason', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  // `sleep 30` will be killed by the 1s timeout long before it exits.
  await seedCheckWorkflow(page, repo, { command: 'sleep', args: ['30'], timeoutMs: 1000 });
  await page.reload();
  await startRun(page, 'Too slow');

  const verifyNode = runPanel(page).getByRole('button', { name: /^Verify / });
  await expect(verifyNode).toHaveAttribute('aria-label', /failed/, { timeout: 20000 });
  await verifyNode.click();
  await expect(runPanel(page)).toContainText(/timed out/i);
  await expect(runPanel(page)).toContainText(/failed|retried/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('the stage detail panel opens a failed check’s retained log, reachable by keyboard, with an echoed secret redacted', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  await seedCheckWorkflow(page, repo, {
    command: process.execPath,
    args: ['-e', "console.error('missing dependency left-pad, API_KEY=sk_live_abcdef1234567890'); process.exit(1);"]
  });
  await page.reload();
  await startRun(page, 'Broken build');

  const verifyNode = runPanel(page).getByRole('button', { name: /^Verify / });
  await expect(verifyNode).toHaveAttribute('aria-label', /failed/, { timeout: 20000 });
  await verifyNode.click();

  const stageDetail = runPanel(page);
  const viewLogButton = stageDetail.getByRole('button', { name: 'View log' });
  await expect(viewLogButton).toBeVisible();

  // Keyboard-reachable, activated without a click.
  await viewLogButton.focus();
  await expect(viewLogButton).toBeFocused();
  await page.keyboard.press('Enter');

  const evidencePanel = page.getByTestId('wf-evidence-panel');
  await expect(evidencePanel).toContainText('missing dependency left-pad');
  await expect(evidencePanel).toContainText('API_KEY=[REDACTED]');
  await expect(evidencePanel).not.toContainText('sk_live_abcdef1234567890');

  // A second activation (still by keyboard) closes it again.
  await stageDetail.getByRole('button', { name: 'Hide log' }).focus();
  await page.keyboard.press('Enter');
  await expect(evidencePanel).toBeHidden();

  fs.rmSync(repo, { recursive: true, force: true });
});

test('the stage detail panel shows the empty state for a check that produced no output', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  // `sleep 30` under a 1s timeout is killed before it ever prints anything —
  // a real "ran, produced nothing" case, not a stand-in for a spawn failure.
  await seedCheckWorkflow(page, repo, { command: 'sleep', args: ['30'], timeoutMs: 1000 });
  await page.reload();
  await startRun(page, 'Too slow');

  const verifyNode = runPanel(page).getByRole('button', { name: /^Verify / });
  await expect(verifyNode).toHaveAttribute('aria-label', /failed/, { timeout: 20000 });
  await verifyNode.click();
  await runPanel(page).getByRole('button', { name: 'View log' }).click();

  await expect(page.getByTestId('wf-evidence-panel')).toContainText(/produced no output/i);

  fs.rmSync(repo, { recursive: true, force: true });
});
