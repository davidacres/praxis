import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * A check that could not run is not a check that failed.
 *
 * Reproduces the real FX-BF-036 failure: the Governed delivery security scan is
 * `npm audit`, the user's default registry is GitHub Packages, which has no audit
 * endpoint, so npm exits 1 without having looked at anything. That must pause the
 * run (siblings carry on, Resume works) — while a genuine finding must still fail
 * the run and stop whatever it left running.
 *
 * A fake `npm` on PATH answers like the registry does, switched by a mode file.
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const FAKE_NPM = `#!/bin/sh
mode=$(cat "$FAKE_NPM_MODE_FILE" 2>/dev/null || echo unsupported)
case "$mode" in
  unsupported)
    printf 'npm warn audit 404 Not Found - POST https://npm.pkg.github.com/-/npm/v1/security/advisories/bulk\\n404 page not found\\n\\nnpm error audit endpoint returned an error\\n' >&2
    exit 1 ;;
  vulnerable)
    printf '# npm audit report\\n\\nlodash <4.17.21\\nSeverity: high\\n\\n2 high severity vulnerabilities\\n'
    exit 1 ;;
  *)
    echo 'found 0 vulnerabilities'
    exit 0 ;;
esac
`;

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-env-repo-'));
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

async function launch(mode: 'unsupported' | 'vulnerable'): Promise<{ page: Page; projectId: string; workflowId: string; modeFile: string }> {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-fake-npm-'));
  tempDirs.push(binDir);
  const modeFile = path.join(binDir, 'mode');
  fs.writeFileSync(modeFile, mode);
  fs.writeFileSync(path.join(binDir, 'npm'), FAKE_NPM, { mode: 0o755 });
  const repo = createRepository();

  app = await launchTestApp(undefined, undefined, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_NPM_MODE_FILE: modeFile
  }, { openNewSession: false });
  const page = app.window;

  const seeded = await page.evaluate(async ({ repoPath, npmPath }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Env Delivery', key: 'ENVD', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `env-${project.id}`;
    // prep → (security ∥ qa) → join → approve. QA is slow, so it is still running when security settles.
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: 'Env delivery', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'prep', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'prep', name: 'Prep', x: 0, y: 0, inputs: [], command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'prep-log', kind: 'log', required: true }] },
        { type: 'check', id: 'security', name: 'Security scan', x: 200, y: -80, inputs: ['prep-log'], command: npmPath,
          args: ['audit', '--audit-level=high'], successExitCodes: [0],
          outputs: [{ id: 'security-report', kind: 'report', required: true }], satisfiesGate: 'security' },
        { type: 'check', id: 'qa', name: 'QA', x: 200, y: 80, inputs: ['prep-log'], command: 'node',
          args: ['-e', "setTimeout(() => { console.log('qa ok'); process.exit(0); }, 4000)"], successExitCodes: [0],
          outputs: [{ id: 'qa-results', kind: 'log', required: true }], satisfiesGate: 'qa' },
        { type: 'join', id: 'gates', name: 'Gates', x: 400, y: 0, inputs: [], mode: 'all' },
        { type: 'approval', id: 'approve', name: 'Approve', x: 600, y: 0, inputs: [], prompt: 'Ship?', requiredGates: ['qa', 'security'], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'prep', to: 'security', on: 'success', required: true },
        { id: 'e2', from: 'prep', to: 'qa', on: 'success', required: true },
        { id: 'e3', from: 'security', to: 'gates', on: 'success', required: true },
        { id: 'e4', from: 'qa', to: 'gates', on: 'success', required: true },
        { id: 'e5', from: 'gates', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    return { projectId: project.id, workflowId };
  }, { repoPath: repo, npmPath: path.join(binDir, 'npm') });
  return { page, modeFile, ...seeded };
}

const stage = (page: Page, runId: string, nodeId: string) =>
  page.evaluate(
    async ({ runId, nodeId }) => {
      const run = await window.praxis.workflows.getRun(runId);
      const row = run?.stages.find(candidate => candidate.nodeId === nodeId);
      return { status: run?.status, paused: run?.paused, pauseReason: run?.pauseReason, outcome: row?.outcome, lane: row?.lane, pause: row?.pause, error: row?.lastError, explanation: run?.explanation };
    },
    { runId, nodeId }
  );

test('a registry that cannot audit pauses the run instead of failing it; siblings finish and Resume completes it', async () => {
  const { page, projectId, workflowId, modeFile } = await launch('unsupported');
  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Audit me'), { projectId, workflowId });

  // Security could not run: paused for the environment, not failed.
  await expect.poll(async () => await stage(page, run.runId, 'security'), { timeout: 30000 }).toMatchObject({ pause: 'environment' });
  const security = await stage(page, run.runId, 'security');
  expect(security.status).toBe('running');
  expect(security.lane).toBe('paused');
  expect(security.error).toContain('does not support security audits');
  expect(security.error).toContain('npm.pkg.github.com');
  expect(security.error).toContain('--registry=https://registry.npmjs.org/');

  // QA — still running when security settled — is left to finish, not cancelled.
  await expect.poll(async () => (await stage(page, run.runId, 'qa')).outcome, { timeout: 30000 }).not.toBe('running');
  expect(await stage(page, run.runId, 'qa'), 'QA should have been left to finish').toMatchObject({ outcome: 'succeeded' });
  const paused = await stage(page, run.runId, 'security');
  expect(paused.status).toBe('running');
  expect(paused.paused).toBe(true);
  expect(paused.pauseReason).toBe('environment');
  expect(paused.explanation).toMatch(/could not run in this environment/);

  // The UI says so, and offers Resume.
  await page.reload();
  const row = page.getByTestId('project-workflow-run-row').first();
  await expect(row).toHaveAttribute('data-run-status', 'paused');
  const toggle = row.getByRole('button').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await row.getByTestId('automation-run-open').click();
  await expect(page.getByTestId('wf-run-limit')).toContainText('could not run in this environment');
  await expect(page.getByTestId('wf-vpipe-step-security')).toHaveAttribute('data-lane', 'paused');
  await expect(page.getByTestId('wf-vpipe-step-security')).toContainText('could not run');
  // The centre shows the paused step (a check has no conversation) once, and the gate is pending — not "failed".
  await expect(page.getByTestId('wf-run-bar-stage')).toHaveText('Security scan');
  await expect(page.getByTestId('wf-run-nosession')).toContainText('Security scan');
  await expect(page.getByTestId('wf-run-nosession').getByText(/could not run in this environment/)).toHaveCount(1);
  const securityGate = page.getByTestId('wf-run-panel').getByRole('row', { name: /^security/i });
  await expect(securityGate).toContainText('pending');
  await expect(securityGate).not.toContainText('failed');
  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'workflow-run-paused-environment.png'), fullPage: true });

  // The user fixes the registry; Resume re-runs only the paused stage and the run carries on.
  fs.writeFileSync(modeFile, 'ok');
  await page.getByTestId('wf-run-resume').click();
  await expect.poll(async () => (await stage(page, run.runId, 'security')).outcome, { timeout: 30000 }).toBe('succeeded');
  await expect.poll(async () => (await stage(page, run.runId, 'security')).status, { timeout: 30000 }).toBe('awaiting-approval');
  await expect(page.getByTestId('wf-run-limit')).toHaveCount(0);
});

test('a genuine audit finding still fails the run, and the sibling it left running is stopped and recorded', async () => {
  const { page, projectId, workflowId } = await launch('vulnerable');
  const run = await page.evaluate(async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Real finding'), { projectId, workflowId });

  await expect.poll(async () => (await stage(page, run.runId, 'security')).status, { timeout: 30000 }).toBe('failed');
  const security = await stage(page, run.runId, 'security');
  expect(security.pause).toBeUndefined();
  expect(security.lane).toBe('failed');

  // QA was still running when the run failed: stopped and recorded — not left "running".
  await expect.poll(async () => (await stage(page, run.runId, 'qa')).outcome).toBe('cancelled');
  const stuck = await page.evaluate(async id => {
    const summary = await window.praxis.workflows.getRun(id);
    return summary?.stages.filter(row => row.outcome === 'running').map(row => row.nodeId);
  }, run.runId);
  expect(stuck).toEqual([]);
});
