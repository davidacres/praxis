import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The composer's usage panel renders the selected provider's account windows
 * through the same QuotaWindow / ConsumptionWindow as the Overview cards, and
 * the collapsed strip carries a meter for the worst quota window.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function openDraftComposer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    await window.praxis.projects.create({
      name: 'Usage project',
      key: 'USAGE',
      type: 'product',
      purpose: '',
      brief: {},
      startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Usage ticket', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
  });
  await page.reload();
  await page.getByTestId('project-session-new').first().click();
}

test('composer usage panel draws provider quota windows as bars with a collapsed meter', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'usage-quota-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await app.electronApp.evaluate(({ ipcMain }, reset) => {
    ipcMain.removeHandler('aiUsage:providerSnapshot');
    ipcMain.handle('aiUsage:providerSnapshot', (_event, provider: string) => ({
      provider,
      checkedAt: new Date().toISOString(),
      windows: [
        { period: 'hour', label: '5-hour window', usedPercent: 82, resetsAt: reset },
        { period: 'week', label: 'Weekly', usedPercent: 41 }
      ]
    }));
  }, resetsAt);
  await openDraftComposer(page);

  const draft = page.getByTestId('new-session-view');
  const summary = draft.getByTestId('session-usage-summary');
  await expect(summary.getByTestId('session-usage-meter')).toContainText('82%');
  await expect(summary.getByTestId('session-usage-meter')).toHaveClass(/is-warn/);

  await summary.locator('summary').click();
  const quotas = draft.getByTestId('session-usage-provider-card');
  await expect(quotas.getByTestId('session-usage-card-vercel-gateway')).toBeVisible();
  await expect(quotas.locator('svg, img').first()).toBeVisible();
  await expect(quotas.getByTestId('session-usage-status-vercel-gateway')).toContainText('Near limit');
  await expect(quotas.getByTestId('session-usage-percent-hour')).toHaveText('82%');
  await expect(quotas.getByTestId('session-usage-reset-hour')).toContainText('⏱');
  await expect(quotas.getByRole('progressbar')).toHaveCount(2);
  await expect(draft.getByTestId('session-usage-models-toggle')).toHaveAttribute('aria-expanded', 'false');

  const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'composer-usage-quota.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await draft.locator('.session-usage-wrapper').screenshot({ path: shot });
});
