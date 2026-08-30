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
  await page.locator('[data-testid="titlebar-themes"]').click();
  await page.locator('[data-testid="theme-card-github-light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'github-light');
  const themed = await page.evaluate(() => ({
    pageBackground: getComputedStyle(document.querySelector('[data-testid="overview-page"]')!).backgroundColor,
    panelBackground: getComputedStyle(document.querySelector('.overview-panel')!).backgroundColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  }));
  expect(themed.pageBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(themed.panelBackground).not.toBe(themed.pageBackground);
  expect(themed.accent).toBe('#0969da');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'output/playwright/overview-dashboard-github-light.png', fullPage: true });
});
