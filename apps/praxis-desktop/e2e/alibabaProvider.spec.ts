import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

const shots = path.resolve(process.cwd(), 'output', 'playwright');

test('Alibaba Model Studio presets carry paired base URLs, key help and the Alibaba Cloud mark', async () => {
  const mock = await startMockOpenAiCompatibleServer({ apiPath: '/compatible-mode/v1', models: ['qwen3-coder-plus'] });
  const app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key' });
  try {
    const win = app.window;
    await win.getByTestId('new-session-view').waitFor();
    await win.getByTestId('titlebar-settings').click();
    await win.getByTestId('settings-nav-ai').click();
    await win.getByTestId('ai-add-provider').click();
    await win.getByTestId('add-provider-search').fill('alibaba');

    const payg = win.getByTestId('add-provider-tile-preset-alibaba-model-studio');
    const plan = win.getByTestId('add-provider-tile-preset-alibaba-token-plan');
    await expect(payg).toBeVisible();
    await expect(plan).toBeVisible();
    // Catalog tiles label themselves with the provider name, so the mark beside
    // it is decorative rather than announced.
    await expect(payg.locator('svg.provider-brand-logo')).toHaveAttribute('aria-hidden', 'true');
    await expect(plan.locator('svg.provider-brand-logo')).toHaveAttribute('aria-hidden', 'true');
    await expect(payg).toContainText('Alibaba');
    await expect(plan).toContainText('Alibaba');
    fs.mkdirSync(shots, { recursive: true });
    await win.getByTestId('add-provider-dialog').screenshot({ path: path.join(shots, 'alibaba-provider-tiles.png') });

    // The Token Plan preset pairs the sk-sp- plan key with the plan's own host.
    await plan.click();
    const form = win.getByTestId('custom-endpoint-form-new');
    await expect(form.getByTestId('custom-endpoint-url')).toHaveValue('https://token-plan.ap-southeast-1.maas.aliyuncs.com');
    await expect(form.getByTestId('alibaba-setup-help')).toContainText('sk-sp-');
    await expect(form.getByRole('link', { name: 'Getting an API key' })).toHaveAttribute('href', 'https://docs.modelstudio.console.alibabacloud.com/en/model-studio/get-api-key');
    await form.screenshot({ path: path.join(shots, 'alibaba-token-plan-form.png') });

    await form.getByTestId('custom-endpoint-url').fill(mock.baseUrl);
    await form.getByTestId('custom-endpoint-key').fill('sk-sp-e2e-plan-key');
    await form.getByTestId('custom-endpoint-test').click();
    for (const step of ['models', 'chat', 'streaming', 'tools']) {
      await expect(form.getByTestId(`custom-endpoint-probe-${step}`)).toHaveAttribute('data-status', 'pass');
    }
    await form.getByTestId('custom-endpoint-save').click();

    const id = 'custom:alibaba-model-studio-token-plan';
    const row = win.getByTestId(`ai-provider-row-${id}`);
    await expect(row).toBeVisible();
    // The rail names the provider in text, so its mark stays decorative.
    await expect(row.locator('svg.provider-brand-logo')).toHaveAttribute('aria-hidden', 'true');
    await expect(row).toContainText('Alibaba Model Studio');
    await row.screenshot({ path: path.join(shots, 'alibaba-provider-row.png') });
    const saved = await win.evaluate(async () => window.praxis.settings.get());
    expect(saved.ai.customProviders?.find(p => p.id === id)).toMatchObject({
      presetId: 'alibaba-token-plan', apiPath: '/compatible-mode/v1', auth: { kind: 'bearer' }
    });
    expect(JSON.stringify(saved)).not.toContain('sk-sp-e2e-plan-key');

    // The pay-as-you-go preset points at the international DashScope host instead.
    await win.getByTestId('ai-add-provider').click();
    await win.getByTestId('add-provider-search').fill('alibaba');
    await win.getByTestId('add-provider-tile-preset-alibaba-model-studio').click();
    const paygForm = win.getByTestId('custom-endpoint-form-new');
    await expect(paygForm.getByTestId('custom-endpoint-url')).toHaveValue('https://dashscope-intl.aliyuncs.com');
    await expect(paygForm.getByTestId('alibaba-setup-help')).toContainText('pay-as-you-go');
  } finally {
    await closeTestApp(app);
    await mock.close();
  }
});
