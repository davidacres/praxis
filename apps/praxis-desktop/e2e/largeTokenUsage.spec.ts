import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp } from './launchTestApp';

test('AI Usage displays million, billion and trillion token totals with compact units', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-e2e-'));
  const counts = [2_500_000, 1_200_000_000, 3_200_000_000_000];
  const ledger = counts.map((totalTokens, index) => ({
    id: `large-${index}`, timestamp: new Date().toISOString(), source: 'session',
    provider: 'openai', model: ['million-model', 'billion-model', 'trillion-model'][index],
    totalTokens, inputTokens: totalTokens, outputTokens: 0
  }));
  fs.writeFileSync(path.join(userDataDir, 'ai-usage-log.json'), JSON.stringify({ 'praxis.aiUsageLog.v1': ledger }));
  const app = await launchTestApp({}, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') });
  try {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('aiUsage:providerHistory');
      const totals = [999_999, 1_000_000, 2_500_000, 1_000_000_000, 1_200_000_000, 1_000_000_000_000, 3_200_000_000_000, 999_950_000];
      ipcMain.handle('aiUsage:providerHistory', (_event, provider) => ({
        provider, fetchedAt: new Date().toISOString(), source: 'provider-api',
        totalTokens: totals.shift(), note: 'Mocked provider history for formatting verification.'
      }));
    });
    const win = app.window;
    await win.keyboard.press('ControlOrMeta+k');
    const palette = win.getByRole('dialog', { name: 'Go to' });
    await palette.getByRole('textbox').fill('ai usage');
    await palette.getByRole('option', { name: /AI Usage/ }).first().click();
    await expect(win.locator('.ai-usage-stat-card').filter({ hasText: 'Tokens recorded by Praxis' }).locator('strong')).toHaveText('3.2 Ttok');
    await expect(win.locator('.ai-usage-stat-card').filter({ hasText: 'Tokens this week' }).locator('strong')).toHaveText('3.2 Ttok');
    for (const [model, value] of [['million-model', '2.5 Mtok'], ['billion-model', '1.2 Btok'], ['trillion-model', '3.2 Ttok']]) {
      await expect(win.getByTestId('ai-usage-model-row').filter({ hasText: model }).locator('.usage-model-tokens')).toHaveText(value);
    }
    await win.getByTestId('ai-usage-table-toggle').click();
    await expect(win.getByTestId('ai-usage-table').locator('tbody tr').first()).toContainText('3.2 Ttok');
    const openai = win.getByTestId('provider-history-openai');
    const expected = ['999,999 tokens', '1 Mtok', '2.5 Mtok', '1 Btok', '1.2 Btok', '1 Ttok', '3.2 Ttok', '1 Btok'];
    for (const value of expected) {
      await openai.getByRole('button', { name: /Fetch history|Refresh history/, exact: true }).click();
      await expect(win.getByTestId('provider-history-total-openai')).toHaveText(value);
    }
    const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await win.locator('.ai-usage-stats-grid').screenshot({ path: path.join(artifacts, 'large-token-totals.png') });
    await win.getByTestId('ai-usage-model-row').first().locator('..').screenshot({ path: path.join(artifacts, 'large-token-models.png') });
  } finally { await closeTestApp(app); }
});
