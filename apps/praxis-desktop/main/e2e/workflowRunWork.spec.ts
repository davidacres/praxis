import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * Deleting a run must never silently decide the fate of the work it produced.
 *
 * A governed run's output is commits on its own `WF-<run8>-<slug>` branch, checked out in a worktree
 * while the run is live. Deleting the run record keeps that branch unless the person opts in to
 * deleting it too — and the confirm says what is at stake first. Uncommitted changes in the worktree
 * are kept as a commit on the branch rather than discarded with the checkout.
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const gitOut = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-work-repo-'));
  tempDirs.push(root);
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('branch', 'feature/unrelated');
  return root;
}

/** A run that commits a file to its branch, leaves another uncommitted, and stops at a human approval. */
async function startRunWithWork(): Promise<{ page: Page; repo: string; runId: string }> {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const seeded = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Work Delivery', key: 'WORK', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `work-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: 'Work delivery', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'commit', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'commit', name: 'Commit', x: 0, y: 0, inputs: [], command: 'sh',
          args: ['-c', "echo delivered > delivered.txt && git add delivered.txt && git commit -q -m 'feat: delivered by the run' && echo committed"],
          successExitCodes: [0], outputs: [{ id: 'commit-log', kind: 'log', required: true }] },
        { type: 'check', id: 'wip', name: 'Half done', x: 200, y: 0, inputs: ['commit-log'], command: 'sh',
          args: ['-c', 'echo half-done > wip.txt && echo wrote'], successExitCodes: [0], outputs: [{ id: 'wip-log', kind: 'log', required: true }] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 400, y: 0, inputs: ['wip-log'], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'commit', to: 'wip', on: 'success', required: true },
        { id: 'e2', from: 'wip', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    const run = await window.praxis.workflows.startRun(project.id, workflowId, 'Deliver');
    return { runId: run.runId };
  }, repo);
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), seeded.runId), { timeout: 30000 })
    .toBe('awaiting-approval');
  return { page, repo, runId: seeded.runId };
}

const runBranches = (repo: string): string[] =>
  gitOut(repo, 'branch', '--format=%(refname:short)', '--list', 'WF-*').split('\n').filter(Boolean);

async function openDeleteDialog(page: Page, runId: string): Promise<void> {
  await page.reload();
  const runsGroup = page.getByTestId('project-workflow-runs-nav-item');
  if ((await runsGroup.getAttribute('aria-expanded')) === 'false') await runsGroup.click();
  const row = page.getByTestId('project-workflow-run-row').first();
  await row.hover();
  await page.getByTestId(`project-run-delete-${runId}`).click();
  await expect(page.getByRole('dialog', { name: 'Delete this run?' })).toBeVisible();
}

test('the delete confirm says what work the run has, and deleting the run keeps its branch by default', async () => {
  const { page, repo, runId } = await startRunWithWork();
  const [branch] = runBranches(repo);
  expect(branch).toMatch(/^WF-[0-9A-F]{8}/);
  expect(fs.existsSync(gitOut(repo, 'worktree', 'list', '--porcelain').match(/worktree (.*WF-[^\n]*)/)?.[1] ?? '/nope')).toBe(true);

  await openDeleteDialog(page, runId);
  const dialog = page.getByRole('dialog', { name: 'Delete this run?' });
  // It names the branch, the commit that exists nowhere else, and the uncommitted file at risk.
  await expect(dialog).toContainText('This run produced work in your repository');
  await expect(dialog.getByTestId('app-dialog-details')).toContainText(branch);
  await expect(dialog.getByTestId('app-dialog-details')).toContainText('1 commit that exists on no other branch');
  await expect(dialog.getByTestId('app-dialog-details')).toContainText('feat: delivered by the run');
  await expect(dialog.getByTestId('app-dialog-details')).toContainText('1 uncommitted file');
  // The destructive extra is offered, unchecked, and says what it costs.
  const option = dialog.getByTestId('app-dialog-option');
  await expect(option).toContainText(`Also delete branch ${branch}`);
  await expect(option).toContainText('Permanently deletes 1 commit that exists nowhere else');
  await expect(option.getByRole('checkbox')).not.toBeChecked();
  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'workflow-run-delete-work.png'), fullPage: true });

  await dialog.getByRole('button', { name: 'Delete run', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId)).toBeUndefined();

  // The run is gone; its work is not.
  expect(runBranches(repo)).toEqual([branch]);
  expect(gitOut(repo, 'log', '--format=%s', branch)).toContain('feat: delivered by the run');
  // The uncommitted file was kept as a commit on the branch instead of being discarded with the checkout.
  expect(gitOut(repo, 'log', '-1', '--format=%s', branch)).toMatch(/^WIP: changes left uncommitted/);
  expect(gitOut(repo, 'show', `${branch}:wip.txt`).trim()).toBe('half-done');
  // The checkout itself is gone, and nothing unrelated was touched.
  expect(gitOut(repo, 'worktree', 'list', '--porcelain')).not.toContain(branch);
  expect(gitOut(repo, 'branch', '--format=%(refname:short)').split('\n')).toContain('feature/unrelated');
});

test('ticking the option deletes the run\'s branch and worktree too — and only those', async () => {
  const { page, repo, runId } = await startRunWithWork();
  const [branch] = runBranches(repo);
  const worktree = gitOut(repo, 'worktree', 'list', '--porcelain').match(/worktree (.*WF-[^\n]*)/)?.[1] as string;
  expect(fs.existsSync(worktree)).toBe(true);

  await openDeleteDialog(page, runId);
  const dialog = page.getByRole('dialog', { name: 'Delete this run?' });
  await dialog.getByTestId('app-dialog-option').getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Delete run', exact: true }).click();
  await expect.poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId)).toBeUndefined();

  expect(runBranches(repo)).toEqual([]);
  expect(fs.existsSync(worktree)).toBe(false);
  expect(gitOut(repo, 'worktree', 'list', '--porcelain')).not.toContain('WF-');
  const remaining = gitOut(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
  expect(remaining).toEqual(['feature/unrelated', 'main']);
  // The commit really is gone from the repository's branches (it was the only place it lived).
  expect(gitOut(repo, 'log', '--all', '--format=%s')).not.toContain('feat: delivered by the run');
});

test('cancelling the confirm deletes nothing', async () => {
  const { page, repo, runId } = await startRunWithWork();
  const [branch] = runBranches(repo);
  await openDeleteDialog(page, runId);
  await page.getByRole('dialog', { name: 'Delete this run?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this run?' })).toHaveCount(0);
  expect(await page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId)).toBe('awaiting-approval');
  expect(runBranches(repo)).toEqual([branch]);
});
