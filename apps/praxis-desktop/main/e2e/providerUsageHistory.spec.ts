import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';

test('provider history stays separate, handles keys, coverage, zero and unavailable summaries', async () => {
  const app = await launchTestApp({ ai: { providers: { openai: { added: true }, anthropic: { added: true } } } });
  try {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('aiUsage:providerHistory');
      ipcMain.removeHandler('aiUsage:setProviderUsageKey');
      const keys: Record<string, string> = {};
      ipcMain.handle('aiUsage:setProviderUsageKey', (_event, provider, key) => {
        if (key === 'reject-key') throw new Error('Test keychain rejected save');
        keys[provider] = key;
      });
      ipcMain.handle('aiUsage:providerHistory', (_event, provider) => ({
        provider, fetchedAt: '2026-10-13T12:00:00Z', source: provider === 'claude-code-cli' ? 'local-cli' : 'provider-api',
        totalTokens: provider === 'anthropic' ? 0 : 123456,
        requestedFrom: provider === 'openai' ? '2020-01-01T00:00:00Z' : undefined,
        requestedTo: provider === 'openai' ? '2026-10-13T12:00:00Z' : undefined,
        firstUsageAt: provider === 'openai' ? '2024-02-01T00:00:00Z' : undefined,
        note: provider === 'claude-code-cli' ? 'Local statistics on this device only.' : 'Provider retention can limit coverage.',
        unavailableReason: provider === 'codex-cli' ? 'No cumulative token summary is available from this CLI.' : (provider === 'openai' || provider === 'anthropic') && !keys[provider] ? 'Add an organization Admin API key.' : undefined
      }));
    });
    const win = app.window;
    await win.keyboard.press('ControlOrMeta+k');
    const palette = win.getByRole('dialog', { name: 'Go to' });
    await palette.getByRole('textbox').fill('ai usage');
    await palette.getByRole('option', { name: /AI Usage/ }).first().click();
    const ledgerBefore = await win.evaluate(() => window.praxis.aiUsage.listEvents());
    const section = win.getByTestId('provider-history-section');
    await expect(section).toBeVisible();
    const openai = win.getByTestId('provider-history-openai');
    await openai.getByRole('button', { name: 'Fetch history', exact: true }).click();
    await expect(openai).toContainText('Add an organization Admin API key.');
    await expect(section.locator('input[type="password"]')).toHaveCount(0);
    await expect(openai).toContainText('Settings → AI Provider → OpenAI');
    await win.getByTestId('settings-nav-ai').click();
    await win.getByTestId('ai-provider-row-openai').locator('.ai-provider-head').click();
    const openaiDetails = win.getByTestId('ai-provider-body-openai');
    const key = openaiDetails.getByTestId('ai-usage-admin-key-input');
    await key.fill('test-admin');
    await openaiDetails.getByTestId('ai-usage-admin-key-save').click();
    await expect(key).toHaveValue('');
    await expect(openaiDetails).toContainText('Usage Admin API key saved.');
    await expect(openaiDetails.getByTestId('ai-api-key-input')).toHaveValue('');
    const modelKeyWidth = await openaiDetails.getByTestId('ai-api-key-input').evaluate(el => el.getBoundingClientRect().width);
    const adminKeyWidth = await key.evaluate(el => el.getBoundingClientRect().width);
    expect(adminKeyWidth, 'Admin key controls should fill the provider detail row').toBeGreaterThan(modelKeyWidth);
    const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await openaiDetails.screenshot({ path: path.join(artifacts, 'openai-history-key-details.png') });
    await key.fill('unsaved-openai-key');
    await win.getByTestId('ai-provider-row-anthropic').locator('.ai-provider-head').click();
    const anthropicDetails = win.getByTestId('ai-provider-body-anthropic');
    const anthropicKey = anthropicDetails.getByTestId('ai-usage-admin-key-input');
    await expect(anthropicKey).toHaveValue('');
    await anthropicKey.fill('reject-key');
    await anthropicDetails.getByTestId('ai-usage-admin-key-save').click();
    await expect(anthropicDetails).toContainText('Test keychain rejected save');
    await expect(anthropicKey).toHaveValue('reject-key');
    await anthropicKey.fill('test-anthropic-admin');
    await anthropicDetails.getByTestId('ai-usage-admin-key-save').click();
    await expect(anthropicKey).toHaveValue('');
    await expect(anthropicDetails).toContainText('Usage Admin API key saved.');
    await anthropicDetails.screenshot({ path: path.join(artifacts, 'anthropic-history-key-details.png') });
    await win.getByTestId('settings-nav-ai-usage').click();
    await openai.getByRole('button', { name: 'Fetch history', exact: true }).click();
    await expect(openai).toContainText('123,456 tokens');
    await expect(openai).toContainText('First returned usage:');
    await win.getByTestId('provider-history-anthropic').getByRole('button', { name: 'Fetch history' }).click();
    await expect(win.getByTestId('provider-history-total-anthropic')).toHaveText('0 tokens');
    await win.getByTestId('provider-history-codex-cli').getByRole('button', { name: 'Fetch history' }).click();
    await expect(win.getByTestId('provider-history-codex-cli')).toContainText('No cumulative token summary');
    await win.getByTestId('provider-history-claude-code-cli').getByRole('button', { name: 'Fetch history' }).click();
    await expect(win.getByTestId('provider-history-claude-code-cli')).toContainText('Local statistics on this device only.');
    await expect(win.getByText('Tokens recorded by Praxis', { exact: true })).toBeVisible();
    expect(await win.evaluate(() => window.praxis.aiUsage.listEvents())).toEqual(ledgerBefore);
    await win.getByTestId('settings-nav-ai').click();
    await win.getByTestId('ai-provider-row-anthropic').locator('.ai-provider-head').click();
    await win.getByTestId('ai-provider-body-anthropic').getByTestId('ai-usage-admin-key-clear').click();
    await win.getByTestId('settings-nav-ai-usage').click();
    await win.getByTestId('provider-history-anthropic').getByRole('button', { name: 'Fetch history' }).click();
    await expect(win.getByTestId('provider-history-anthropic')).toContainText('Add an organization Admin API key.');
    await openai.getByRole('button', { name: 'Fetch history' }).click();
    await expect(win.getByTestId('provider-history-total-openai')).toHaveText('123,456 tokens');
    // Rendered-build evidence retained for handoff; the test performs the actual interactions.
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.setAttribute('data-theme', 'praxis-dark'); });
    await section.screenshot({ path: path.join(artifacts, 'provider-history-dark.png') });
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'light'); document.documentElement.setAttribute('data-theme', 'praxis-light'); });
    await section.screenshot({ path: path.join(artifacts, 'provider-history-light.png') });
    await win.setViewportSize({ width: 1200, height: 900 });
    await win.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
    await expect(openai.getByRole('button', { name: 'Refresh history' })).toBeVisible();
    await openai.screenshot({ path: path.join(artifacts, 'provider-history-narrow.png') });
    const overflowing = await section.evaluate(el => [...el.querySelectorAll('*')]
      .filter(n => n.scrollWidth > n.clientWidth + 1)
      .map(n => ({ tag: n.tagName, cls: n.className, width: n.clientWidth, scroll: n.scrollWidth })));
    expect(overflowing).toEqual([]);
  } finally { await closeTestApp(app); }
});
