import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

test('Bifrost preset saves a virtual key and runs a streamed session on its exact endpoint', async () => {
  const mock = await startMockOpenAiCompatibleServer({ apiPath: '/openai', models: ['openai/gpt-4o-mini'] });
  const app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key' });
  try {
    const win = app.window;
    await win.getByTestId('new-session-view').waitFor();
    await win.getByTestId('titlebar-settings').click();
    await win.getByTestId('settings-nav-ai').click();
    await win.getByTestId('ai-add-provider').click();
    const gateways = win.getByRole('region', { name: 'AI gateways', exact: true });
    await expect(gateways.getByTestId('add-provider-tile-preset-bifrost')).toContainText('Local or remote gateway');
    await expect(gateways.getByTestId('add-provider-tile-vercel-gateway')).toBeVisible();
    await expect(win.getByRole('region', { name: 'Local runtimes', exact: true }).getByTestId('add-provider-tile-preset-bifrost')).toHaveCount(0);
    const artifacts = path.resolve(process.cwd(), '../.praxis/session-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await gateways.screenshot({ path: path.join(artifacts, 'bifrost-gateway-category.png') });
    await win.getByTestId('add-provider-search').fill('Bifrost');
    await win.getByTestId('add-provider-tile-preset-bifrost').click();
    const form = win.getByTestId('custom-endpoint-form-new');
    await expect(form.getByTestId('custom-endpoint-url')).toHaveValue('http://localhost:8080');
    await expect(form.getByLabel('Key header name')).toHaveValue('x-bf-vk');
    await expect(form.getByTestId('bifrost-setup-help')).toContainText('local cost estimates');
    await form.getByTestId('custom-endpoint-url').fill(mock.baseUrl);
    await form.getByTestId('custom-endpoint-key').fill('sk-bf-e2e-virtual-key');
    await form.getByTestId('custom-endpoint-test').click();
    for (const step of ['models', 'chat', 'streaming', 'tools']) {
      await expect(form.getByTestId(`custom-endpoint-probe-${step}`)).toHaveAttribute('data-status', 'pass');
    }
    await form.screenshot({ path: path.join(artifacts, 'bifrost-provider-setup.png') });
    await form.getByTestId('custom-endpoint-save').click();
    const id = 'custom:bifrost-ai-gateway';
    await expect(win.getByTestId(`ai-provider-row-${id}`)).toBeVisible();
    const saved = await win.evaluate(async () => window.praxis.settings.get());
    expect(saved.ai.customProviders?.find(p => p.id === id)).toMatchObject({
      presetId: 'bifrost', apiPath: '/openai', auth: { kind: 'header', name: 'x-bf-vk' }
    });
    expect(JSON.stringify(saved)).not.toContain('sk-bf-e2e-virtual-key');
    await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
    await win.getByTestId('new-session-provider-chip').click();
    await expect(win.getByTestId(`new-session-provider-option-${id}`)).toBeEnabled();
    await win.keyboard.press('Escape');
    const before = mock.requests.length;
    const key = await win.evaluate(async provider => {
      const record = await window.praxis.ai.delegate({
        provider, reasoningEffort: 'medium', toolMode: 'read-only',
        task: { goal: 'Bifrost smoke test', maxSteps: 2, timeoutMs: 30000 }
      });
      return record.issueKey;
    }, id);
    await expect.poll(async () => win.evaluate(async key =>
      (await window.praxis.ai.listSessions()).find(s => s.issueKey === key)?.state, key)).toBe('completed');
    const chat = mock.requests.slice(before).find(r => r.url === '/openai/chat/completions');
    expect(chat?.headers['x-bf-vk']).toBe('sk-bf-e2e-virtual-key');
    expect(chat?.headers.authorization).toBeUndefined();
    expect(JSON.parse(chat!.body)).toMatchObject({ model: 'openai/gpt-4o-mini', stream: true, reasoning: { effort: 'medium' } });
    expect(chat?.body).not.toContain('providerOptions');
    const session = await win.evaluate(async key =>
      (await window.praxis.ai.listSessions()).find(s => s.issueKey === key), key);
    expect(session?.tokenUsage?.totalTokens).toBeGreaterThan(0);
    expect(session?.events?.find(event => event.type === 'message')?.cost?.amount).toBeGreaterThan(0);
  } finally {
    await closeTestApp(app);
    await mock.close();
  }
});
