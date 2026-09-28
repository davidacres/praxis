import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * A failed pipeline step can be retried by hand, even after its `maxAttempts`
 * budget is spent and the run has settled as failed.
 *
 * The check stage passes only once a marker file exists, so the first attempt
 * fails, the run fails (maxAttempts defaults to 1), and the retry — driven from
 * the icon button on the step in the pipeline — succeeds after the marker is
 * created. Everything is the production path; no model is involved.
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-retry-repo-'));
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

async function seed(page: Page, repo: string, marker: string): Promise<{ projectId: string; workflowId: string }> {
  return page.evaluate(
    async ({ repoPath, markerPath }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Retry Delivery',
          key: 'RTY',
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
      const workflowId = `retry-${project.id}`;
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1,
        id: workflowId,
        name: 'Retry check',
        scope: 'project',
        projectId: project.id,
        version: 1,
        entryNodeId: 'verify',
        createdAt: now,
        updatedAt: now,
        nodes: [
          {
            type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
            command: 'test', args: ['-f', markerPath], successExitCodes: [0], timeoutMs: 30000,
            outputs: [{ id: 'verify-log', kind: 'log', required: false }],
            satisfiesGate: 'qa'
          },
          {
            type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: [],
            prompt: 'Ship?', requiredGates: [], allowBypass: false
          }
        ],
        edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
      } as never);
      localStorage.setItem(
        `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
        JSON.stringify({ projectId: project.id, feature: 'workflows' })
      );
      return { projectId: project.id, workflowId };
    },
    { repoPath: repo, markerPath: marker }
  );
}

test('a failed step on a failed run has a retry icon button that reopens the run', async () => {
  const repo = createRepository();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-retry-marker-')), 'ready');
  tempDirs.push(path.dirname(marker));
  app = await launchTestApp({}, undefined, {}, { openNewSession: false });
  const page = app.window;
  const seeded = await seed(page, repo, marker);

  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Retry me'),
    seeded
  );
  const status = () => page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.status), run.runId);

  // One attempt, no marker: the stage fails and the whole run settles as failed.
  await expect.poll(status, { timeout: 60000 }).toBe('failed');

  await page.reload();
  const sidebarRun = page.getByTestId('project-workflow-run-row').first();
  const sidebarToggle = sidebarRun.getByRole('button').first();
  if ((await sidebarToggle.getAttribute('aria-expanded')) === 'false') await sidebarToggle.click();
  await sidebarRun.getByTestId('automation-inline-open-run').click();

  const step = page.getByTestId('wf-vpipe-step-verify');
  await expect(step).toHaveAttribute('data-lane', 'failed');
  const retry = page.getByTestId('wf-vpipe-retry-verify');
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAccessibleName('Retry Verify');
  // Only the failed step carries one.
  await expect(page.getByTestId('wf-vpipe-retry-approve')).toHaveCount(0);

  // The icon sits at the right of its step, inside it.
  const stepBox = (await step.boundingBox())!;
  const retryBox = (await retry.boundingBox())!;
  expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(stepBox.x + stepBox.width);
  expect(retryBox.x).toBeGreaterThan(stepBox.x + stepBox.width / 2);
  await page.screenshot({
    path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'workflow-run-retry-icon.png'),
    fullPage: true
  });

  // Fix the cause, then retry from the icon: the run reopens and this time passes.
  fs.writeFileSync(marker, 'ok');
  await retry.click();
  await expect.poll(status, { timeout: 60000 }).toBe('awaiting-approval');
  await expect(page.getByTestId('wf-vpipe-step-verify')).toHaveAttribute('data-lane', 'done');
  await expect(page.getByTestId('wf-vpipe-retry-verify')).toHaveCount(0);
});
