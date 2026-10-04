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
  await expect(page.getByText('Recent activity')).toBeVisible();
  await expect(page.getByText('Delivery worktrees')).toHaveCount(0);
  await expect(page.locator('.overview-boards')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Workspace health' })).toBeVisible();
  await page.locator('[data-testid="overview-activity-heatmap"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="overview-activity-heatmap"]').screenshot({ path: 'output/playwright/overview-heatmap.png' });
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await page.locator('[data-testid="theme-card-tm-default-2"]').click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="overview-activity-heatmap"]').screenshot({ path: 'output/playwright/overview-heatmap-dark.png' });
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await page.locator('[data-testid="theme-card-tm-default-1"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tm-default-1');
  const themed = await page.evaluate(() => ({
    pageBackground: getComputedStyle(document.querySelector('[data-testid="overview-page"]')!).backgroundColor,
    panelBackground: getComputedStyle(document.querySelector('.overview-panel')!).backgroundColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  }));
  expect(themed.pageBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(themed.panelBackground).not.toBe(themed.pageBackground);
  expect(themed.accent).toBe('#7c5cff');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'output/playwright/overview-dashboard-tm-default-1.png', fullPage: true });
});
