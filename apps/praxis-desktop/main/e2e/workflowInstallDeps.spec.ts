import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * A run's worktree starts with no `node_modules` (it is gitignored). A check that needs a dependency
 * therefore fails in a fresh worktree however good the change is — this is the FX-BF-036 QA failure:
 * a workspace package with its own nested dependencies could not compile. The Governed delivery
 * template carries an `Install dependencies` stage for exactly this; this proves the stage does what
 * the template relies on, on a real repository, with no network (the dependency is a local tarball).
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const sh = (cwd: string, cmd: string, ...args: string[]): string => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repo whose `check.js` requires a dependency that only exists once `npm ci` has run. */
function createRepository(): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-deps-'));
  tempDirs.push(scratch);

  // The dependency: packed offline into a tarball the lockfile can point at.
  const depSrc = path.join(scratch, 'dep-src');
  fs.mkdirSync(depSrc);
  fs.writeFileSync(path.join(depSrc, 'package.json'), JSON.stringify({ name: 'praxis-fixture-dep', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(depSrc, 'index.js'), "module.exports = () => 'dependency loaded';\n");
  sh(depSrc, 'npm', 'pack', '--pack-destination', scratch);

  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(scratch, 'praxis-fixture-dep-1.0.0.tgz'), path.join(repo, 'vendor', 'praxis-fixture-dep-1.0.0.tgz'));
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, dependencies: { 'praxis-fixture-dep': 'file:vendor/praxis-fixture-dep-1.0.0.tgz' } }, null, 2)
  );
  fs.writeFileSync(path.join(repo, 'check.js'), "console.log(require('praxis-fixture-dep')());\n");
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  sh(repo, 'git', 'init', '--initial-branch=main');
  sh(repo, 'git', 'config', 'user.email', 'e2e@example.com');
  sh(repo, 'git', 'config', 'user.name', 'E2E');
  sh(repo, 'npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund');
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', 'initial');
  return repo;
}

async function seed(page: Page, repo: string, withInstall: boolean): Promise<{ projectId: string; workflowId: string }> {
  return page.evaluate(
    async ({ repoPath, install }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Deps Delivery', key: 'DEPS', type: 'software', purpose: '', brief: {},
          startingPoint: 'existing-folder', folderPath: repoPath,
          workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
          starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
          defaultAiToolMode: 'read-only'
        },
        workspace.id
      );
      const now = new Date().toISOString();
      const workflowId = `deps-${project.id}`;
      // The install stage is the one the Governed delivery template uses (same command, same registry flag).
      const installNode = {
        type: 'check', id: 'install', name: 'Install dependencies', x: 0, y: 0, inputs: [], command: 'npm',
        args: ['ci', '--registry=https://registry.npmjs.org/'], successExitCodes: [0], timeoutMs: 120000,
        outputs: [{ id: 'install-log', kind: 'log', required: true }]
      };
      const qaNode = {
        type: 'check', id: 'qa', name: 'QA', x: 200, y: 0, inputs: install ? ['install-log'] : [], command: 'node', args: ['check.js'],
        successExitCodes: [0], outputs: [{ id: 'qa-log', kind: 'log', required: true }], satisfiesGate: 'qa'
      };
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1, id: workflowId, name: install ? 'With install' : 'Without install', scope: 'project', projectId: project.id, version: 1,
        entryNodeId: install ? 'install' : 'qa', createdAt: now, updatedAt: now,
        nodes: [
          ...(install ? [installNode] : []),
          qaNode,
          { type: 'approval', id: 'approve', name: 'Approve', x: 400, y: 0, inputs: ['qa-log'], prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false }
        ],
        edges: [...(install ? [{ id: 'e1', from: 'install', to: 'qa', on: 'success', required: true }] : []), { id: 'e2', from: 'qa', to: 'approve', on: 'success', required: true }]
      } as never);
      return { projectId: project.id, workflowId };
    },
    { repoPath: repo, install: withInstall }
  );
}

const stage = (page: Page, runId: string, nodeId: string) =>
  page.evaluate(
    async ({ runId, nodeId }) => {
      const run = await window.praxis.workflows.getRun(runId);
      const row = run?.stages.find(candidate => candidate.nodeId === nodeId);
      return { status: run?.status, outcome: row?.outcome, error: row?.lastError };
    },
    { runId, nodeId }
  );

test('without an install stage a fresh run worktree cannot load the dependency, so QA fails — however good the change is', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, workflowId } = await seed(page, repo, false);

  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'No install'), { projectId, workflowId });
  await expect.poll(async () => (await stage(page, run.runId, 'qa')).status, { timeout: 30000 }).toBe('failed');
  const qa = await stage(page, run.runId, 'qa');
  expect(qa.outcome).toBe('failed');
  expect(qa.error).toMatch(/Cannot find module 'praxis-fixture-dep'/);
});

test('an install stage gives the worktree its own dependencies, QA passes, and the main checkout is left untouched', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, workflowId } = await seed(page, repo, true);

  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'With install'), { projectId, workflowId });
  await expect.poll(async () => (await stage(page, run.runId, 'qa')).status, { timeout: 60000 }).toBe('awaiting-approval');
  expect((await stage(page, run.runId, 'install')).outcome).toBe('succeeded');
  expect((await stage(page, run.runId, 'qa')).outcome).toBe('succeeded');

  // Installed into the run's own worktree — isolated, not linked back to the user's checkout.
  const worktree = sh(repo, 'git', 'worktree', 'list', '--porcelain').match(/worktree (.*WF-[^\n]*)/)?.[1] as string;
  expect(worktree).toBeTruthy();
  expect(fs.existsSync(path.join(worktree, 'node_modules', 'praxis-fixture-dep'))).toBe(true);
  expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
});
