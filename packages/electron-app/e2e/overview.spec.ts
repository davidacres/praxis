import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => { app = await launchTestApp(); });
test.afterEach(async () => { await closeTestApp(app); });

test('renders the workspace overview dashboard', async () => {
  const page = app.window;
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await expect(page.getByText('Workspace overview')).toBeVisible();
  await expect(page.getByText('Active AI sessions')).toBeVisible();
  await expect(page.getByText('Recent projects')).toBeVisible();
  await expect(page.getByText('Delivery worktrees')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace health' })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/overview-dashboard.png', fullPage: true });
});
