import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockAddonRegistry, type MockAddonRegistry } from './mockAddonRegistry';

/**
 * The repo's own `addons/workflows/security-review` package, served through the
 * mock registry exactly as published: it installs from Settings › Workflow
 * templates and becomes a template in a project's New Workflow dialog.
 */

test.slow();

const ADDON_DIR = path.resolve(__dirname, '../../../../addons/workflows/security-review');
const OWNER = 'acme';

let app: TestApp | undefined;
let registry: MockAddonRegistry | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (registry) await registry.close();
  app = undefined;
  registry = undefined;
});

test('the Security Review add-on installs and creates a workflow from its template', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ADDON_DIR, 'package.json'), 'utf8'));
  registry = await startMockAddonRegistry({
    owner: OWNER,
    addons: [
      {
        packageName: 'praxis-addon-security-review',
        version: pkg.version,
        manifest: pkg.praxis,
        payload: { 'template.json': fs.readFileSync(path.join(ADDON_DIR, 'addon', 'template.json'), 'utf8') }
      }
    ]
  });
  app = await launchTestApp(
    {
      marketplace: {
        enabled: true,
        owner: OWNER,
        ownerType: 'user',
        packageNamePrefix: 'praxis-addon-',
        apiBaseUrl: registry.baseUrl,
        registryBaseUrl: registry.baseUrl,
        checkOnLaunch: false
      }
    },
    undefined,
    { PRAXIS_MARKETPLACE_TOKEN: 'e2e-token' },
    { openNewSession: false }
  );
  const page = app.window;

  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Audit Project',
        key: 'AUDIT',
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
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await page.reload();

  // Install from Settings › Workflow templates.
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.locator('[data-testid="settings-nav-workflow-templates"]').click();
  const listing = page.locator('[data-testid="workflow-template-marketplace-security-review"]');
  await expect(listing).toContainText('Security Review');
  await listing.getByRole('button', { name: 'Install' }).click();
  await expect(page.locator('[data-testid="workflow-template-installed-security-review"]')).toContainText('v1.0.0');
  await page.keyboard.press('Escape');

  // It is now a template in the project's New Workflow dialog.
  await page.getByRole('button', { name: 'New workflow in Audit Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByRole('listitem').filter({ hasText: 'Security Review' }).click();
  await dialog.getByRole('button', { name: /^Use/ }).click();
  await expect(dialog).toBeHidden();

  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await expect(canvas.getByRole('button', { name: /^Repository inventory \(check\), entry stage/ })).toBeVisible();
  for (const stage of ['Attack surface', 'SAST (Semgrep)', 'Secrets (Gitleaks)', 'Dependency vulnerabilities', 'Security review', 'Create remediation plan?', 'Remediation plan']) {
    await expect(canvas.getByRole('button', { name: new RegExp(`^${stage.replace(/[()?]/g, '\\$&')} \\(`) })).toBeVisible();
  }
  await page.screenshot({ path: path.resolve(__dirname, '../../../../.praxis/session-artifacts/security-review-workflow.png') });
});
