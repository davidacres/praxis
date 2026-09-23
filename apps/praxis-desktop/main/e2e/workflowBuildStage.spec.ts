import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * A run's worktree has no build output (it is gitignored), just as it has no `node_modules`.
 *
 * The visible symptom in FX-BF-036: QA's `npm test` ends by running the desktop app's e2e suite, which
 * loads a *pre-built* renderer. Nothing had built it, so the app opened a window with nothing in it —
 * nothing like "you forgot to build". `check.js` stands in for that: it needs `dist/index.html`, which
 * only `npm run build` produces. The Build stage is the one the Governed delivery template carries.
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

function createRepository(hasBuildScript: boolean): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-build-'));
  tempDirs.push(repo);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: hasBuildScript ? { build: 'node build.js' } : {} }, null, 2)
  );
  fs.writeFileSync(path.join(repo, 'build.js'), "require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/index.html', '<h1>the app</h1>'); console.log('built');\n");
  // The stand-in for "the app loads the built renderer": fails unless the build has been run.
  fs.writeFileSync(path.join(repo, 'check.js'), "if (!require('fs').existsSync('dist/index.html')) { console.error('window is blank: dist/index.html was never built'); process.exit(1); } console.log('app rendered');\n");
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  sh(repo, 'git', 'init', '--initial-branch=main');
  sh(repo, 'git', 'config', 'user.email', 'e2e@example.com');
  sh(repo, 'git', 'config', 'user.name', 'E2E');
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-m', 'initial');
  return repo;
}

async function seed(page: Page, repo: string, withBuild: boolean): Promise<{ projectId: string; workflowId: string }> {
  return page.evaluate(
    async ({ repoPath, build }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Build Delivery', key: 'BLD', type: 'software', purpose: '', brief: {},
          startingPoint: 'existing-folder', folderPath: repoPath,
          workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
          starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
          defaultAiToolMode: 'read-only'
        },
        workspace.id
      );
      const now = new Date().toISOString();
      const workflowId = `build-${project.id}`;
      // Same command and optional log as the Governed delivery template's Build stage.
      const buildNode = {
        type: 'check', id: 'build', name: 'Build', x: 0, y: 0, inputs: [], command: 'npm', args: ['run', 'build', '--if-present'],
        successExitCodes: [0], timeoutMs: 120000, outputs: [{ id: 'build-log', kind: 'log', required: false }]
      };
      const qaNode = {
        type: 'check', id: 'qa', name: 'QA', x: 200, y: 0, inputs: [], command: 'node', args: ['check.js'],
        successExitCodes: [0], outputs: [{ id: 'qa-log', kind: 'log', required: true }], satisfiesGate: 'qa'
      };
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1, id: workflowId, name: build ? 'With build' : 'Without build', scope: 'project', projectId: project.id, version: 1,
        entryNodeId: build ? 'build' : 'qa', createdAt: now, updatedAt: now,
        nodes: [...(build ? [buildNode] : []), qaNode, { type: 'approval', id: 'approve', name: 'Approve', x: 400, y: 0, inputs: ['qa-log'], prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false }],
        edges: [...(build ? [{ id: 'e1', from: 'build', to: 'qa', on: 'success', required: true }] : []), { id: 'e2', from: 'qa', to: 'approve', on: 'success', required: true }]
      } as never);
      return { projectId: project.id, workflowId };
    },
    { repoPath: repo, build: withBuild }
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

async function start(page: Page, repo: string, withBuild: boolean): Promise<string> {
  const { projectId, workflowId } = await seed(page, repo, withBuild);
  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Build test'), { projectId, workflowId });
  return run.runId;
}

test('without a build stage the built product is missing in a fresh worktree, so what needs it fails', async () => {
  const repo = createRepository(true);
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const runId = await start(app.window, repo, false);
  await expect.poll(async () => (await stage(app!.window, runId, 'qa')).status, { timeout: 30000 }).toBe('failed');
  expect((await stage(app.window, runId, 'qa')).error).toContain('window is blank');
});

test('a governed run refuses a dirty product checkout instead of testing an older committed snapshot', async () => {
  const repo = createRepository(true);
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const ids = await seed(app.window, repo, true);
  fs.appendFileSync(path.join(repo, 'build.js'), "console.log('uncommitted product change');\n");

  const message = await app.window.evaluate(async input => {
    try {
      await window.praxis.workflows.startRun(input.projectId, input.workflowId, 'Dirty base test');
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, ids);

  expect(message).toContain('1 uncommitted file in this project is not in the last commit (build.js)');
  expect(message).toContain('Commit or stash them and try again');
  expect(await app.window.evaluate(projectId => window.praxis.workflows.listRuns(projectId), ids.projectId)).toEqual([]);
  expect(sh(repo, 'git', 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});

test('a build stage produces the output in the run\'s worktree, so QA passes — and the main checkout gets none', async () => {
  const repo = createRepository(true);
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const runId = await start(app.window, repo, true);
  await expect.poll(async () => (await stage(app!.window, runId, 'qa')).status, { timeout: 30000 }).toBe('awaiting-approval');
  expect((await stage(app.window, runId, 'build')).outcome).toBe('succeeded');
  expect((await stage(app.window, runId, 'qa')).outcome).toBe('succeeded');
  const worktree = sh(repo, 'git', 'worktree', 'list', '--porcelain').match(/worktree (.*WF-[^\n]*)/)?.[1] as string;
  expect(fs.existsSync(path.join(worktree, 'dist', 'index.html'))).toBe(true);
  expect(fs.existsSync(path.join(repo, 'dist'))).toBe(false);
});

test('a project with no build script is not failed by the build stage having nothing to say', async () => {
  // `check.js` needs dist/, which this project never builds — so give it a QA that does not, and prove the
  // build stage itself is a clean no-op (exit 0, empty output, optional log).
  const repo = createRepository(false);
  fs.writeFileSync(path.join(repo, 'check.js'), "console.log('no build needed');\n");
  sh(repo, 'git', 'commit', '-am', 'qa needs no build');
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const runId = await start(app.window, repo, true);
  await expect.poll(async () => (await stage(app!.window, runId, 'qa')).status, { timeout: 30000 }).toBe('awaiting-approval');
  const build = await stage(app.window, runId, 'build');
  expect(build.outcome).toBe('succeeded');
  expect(build.error).toBeUndefined();
});
