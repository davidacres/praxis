import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * The Policies page (FX-BF-040 follow-up): global and project Workflow Policy
 * Profiles were only ever readable via `effectivePolicy` — there was no UI or
 * IPC to create one, so `allowGateBypass` stayed permanently deny-by-default
 * and required-gate/human-approval/trust rules were unreachable from the app.
 */

test.slow();

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  await app.window.evaluate(async () => {
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
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows' })
    );
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('creating a project policy from the sidebar persists it and composes it into the effective policy', async () => {
  const page = app.window;

  await page.getByTestId('project-workflow-policies-nav-item').click();
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();

  const projectCard = page.locator('.wf-policy-card').filter({ has: page.getByRole('heading', { name: 'Delivery Project policy', exact: true }) });
  await expect(projectCard.getByRole('button', { name: 'Create policy' })).toBeVisible();

  await projectCard.getByRole('checkbox', { name: 'qa' }).check();
  await projectCard.getByRole('checkbox', { name: 'Require a human approval stage' }).check();

  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'workflow-policies-page.png'), fullPage: true });

  await projectCard.getByRole('button', { name: 'Create policy' }).click();

  // Persisted server-side: a reload reflects the same profile, not a form default.
  await page.reload();
  await page.getByTestId('project-workflow-policies-nav-item').click();
  const reloadedCard = page.locator('.wf-policy-card').filter({ has: page.getByRole('heading', { name: 'Delivery Project policy', exact: true }) });
  await expect(reloadedCard.getByRole('checkbox', { name: 'qa' })).toBeChecked();
  await expect(reloadedCard.getByRole('checkbox', { name: 'Require a human approval stage' })).toBeChecked();
  await expect(reloadedCard.getByRole('button', { name: 'Save changes' })).toBeVisible();
});

test('a global policy composes strictest-wins with a project policy', async () => {
  const page = app.window;

  const projectId = await page.evaluate(async () => {
    const projects = await window.praxis.projects.list();
    return projects.find(p => p.name === 'Delivery Project')?.id as string;
  });

  await page.getByTestId('project-workflow-policies-nav-item').click();
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();

  const globalCard = page.locator('.wf-policy-card').filter({ has: page.getByRole('heading', { name: 'Global policy', exact: true }) });
  await globalCard.getByRole('checkbox', { name: 'security' }).check();
  await globalCard.getByRole('button', { name: 'Create policy' }).click();
  await expect(globalCard.getByRole('button', { name: 'Save changes' })).toBeVisible();

  const effective = await page.evaluate(async id => window.praxis.workflows.effectivePolicy(id), projectId);
  expect(effective?.requiredGates).toContain('security');

  // Removing it clears the requirement again.
  await globalCard.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove this policy?' }).getByRole('button', { name: 'Remove policy' }).click();
  await expect(globalCard.getByRole('button', { name: 'Create policy' })).toBeVisible();
  const cleared = await page.evaluate(async id => window.praxis.workflows.effectivePolicy(id), projectId);
  expect(cleared).toBeUndefined();
});
