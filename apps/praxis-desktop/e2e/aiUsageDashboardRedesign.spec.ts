import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('AI Usage & Provider Fleet Dashboard renders pixel-perfect with full functionality', async () => {
  app = await launchTestApp();
  const win = app.window;
  // Account limits must not depend on a signed-in Codex installation on the runner.
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('aiUsage:providerSnapshots');
    ipcMain.handle('aiUsage:providerSnapshots', () => ({
      checkedAt: new Date().toISOString(),
      snapshots: [
        {
          provider: 'codex-cli', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 20 },
            { period: 'week', usedPercent: 30 }
          ]
        },
        {
          provider: 'claude-code-cli', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 15 },
            { period: 'week', usedPercent: 25 }
          ]
        },
        {
          provider: 'gemini', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 10 },
            { period: 'week', usedPercent: 20 }
          ]
        },
        {
          provider: 'vercel-gateway', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 5 },
            { period: 'week', usedPercent: 15 }
          ]
        },
        {
          provider: 'z-ai', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 40 },
            { period: 'week', usedPercent: 50 }
          ]
        },
        {
          provider: 'custom:ollama', fetchedAt: new Date().toISOString(),
          windows: [
            { period: 'rolling', usedPercent: 0 },
            { period: 'week', usedPercent: 0 }
          ]
        }
      ]
    }));
  });

  // Open Settings -> AI Usage
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill('ai usage');
  await palette.getByRole('option', { name: /AI Usage/ }).first().click();

  const settingsDialog = win.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();

  // 1. Verify executive metric highlights strip
  await expect(win.getByTestId('ai-usage-stat-total-cost')).toBeVisible();
  await expect(win.getByTestId('ai-usage-delta')).toBeVisible();

  // 2. Verify fleet section
  const fleetSection = win.getByTestId('ai-usage-budgets-section');
  await expect(fleetSection).toBeVisible();

  // 3. Verify provider cards exist
  const codexCard = win.getByTestId('ai-usage-budgets-card-codex-cli');
  await expect(codexCard).toBeVisible();
  await expect(codexCard).toContainText('OpenAI Codex');
  await expect(codexCard).toContainText('5-Hour Rolling Limit');
  await expect(codexCard).toContainText('Weekly Quota Limit');
  await expect(codexCard).toContainText('Rate Limit:');
  await expect(codexCard).toContainText('MTD Spend:');

  // Verify other core providers
  await expect(win.getByTestId('ai-usage-budgets-card-claude-code-cli')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-gemini')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-vercel-gateway')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-z-ai')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-custom:ollama')).toBeVisible();

  // Take screenshot in Dark Theme
  await win.screenshot({ path: test.info().outputPath('ai-usage-fleet-dark.png'), fullPage: true });

  // 4. Test Search Filtering
  const searchInput = win.locator('.ai-fleet-search-input');
  await searchInput.fill('gemini');
  await expect(win.getByTestId('ai-usage-budgets-card-gemini')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-codex-cli')).toHaveCount(0);
  await searchInput.fill('');

  // 5. Test Category Tabs
  await fleetSection.getByRole('button', { name: 'CLI Tools' }).click();
  await expect(win.getByTestId('ai-usage-budgets-card-codex-cli')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-claude-code-cli')).toBeVisible();
  await expect(win.getByTestId('ai-usage-budgets-card-gemini')).toHaveCount(0);

  // Return to All
  await fleetSection.getByRole('button', { name: 'All', exact: true }).click();
  await expect(win.getByTestId('ai-usage-budgets-card-gemini')).toBeVisible();

  // 6. Test Per-Page Density Selector
  const perPage2Btn = win.getByRole('button', { name: '2', exact: true });
  await perPage2Btn.click();
  await expect(win.locator('.ai-provider-card')).toHaveCount(2);

  const perPage4Btn = win.getByRole('button', { name: '4', exact: true });
  await perPage4Btn.click();
  await expect(win.locator('.ai-provider-card')).toHaveCount(4);

  // Pagination Next
  const nextBtn = win.getByRole('button', { name: /Next 4 providers/ });
  await nextBtn.click();
  await expect(win.locator('.ai-carousel-page-status')).toContainText('Page 2 of 2');

  const prevBtn = win.getByRole('button', { name: '‹ Previous' });
  await prevBtn.click();
  await expect(win.locator('.ai-carousel-page-status')).toContainText('Page 1 of 2');

  // Reset to 6 max
  await win.getByRole('button', { name: '6 max' }).click();
  await expect(win.locator('.ai-provider-card')).toHaveCount(6);

  // 7. Switch to Light Theme and capture screenshot
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'light');
    document.documentElement.setAttribute('data-theme', 'praxis-light');
  });
  await win.waitForTimeout(200);
  await win.locator('.ai-fleet-carousel-dock').scrollIntoViewIfNeeded();
  await win.screenshot({ path: test.info().outputPath('ai-usage-fleet-light.png'), fullPage: false });
});
