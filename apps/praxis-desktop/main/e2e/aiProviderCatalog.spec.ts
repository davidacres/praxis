import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';
import { chooseOption, chipOptionValues } from './chipSelect';

/**
 * FX-BF-044: Settings → AI Provider lists the providers in use; everything else
 * is picked from Add provider — built-ins, OpenAI-compatible presets, or a
 * custom endpoint that is tested before it is saved.
 */

let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
let providerFixtureDir: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  if (providerFixtureDir) fs.rmSync(providerFixtureDir, { recursive: true, force: true });
  providerFixtureDir = undefined;
  app = undefined;
  mock = undefined;
});

const shots = path.resolve(process.cwd(), 'output', 'playwright');

async function launch(): Promise<Page> {
  // The gateway is the default provider, configured through its env key; nothing else is set up.
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key' });
  await app.window.waitForSelector('[data-testid="new-session-view"]');
  return app.window;
}

async function openAiSettings(win: Page): Promise<void> {
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();
  await expect(win.getByTestId('ai-provider-status')).not.toHaveText('Checking…');
}

/** Every box lies inside `container` and no two overlap — the "don't overlap buttons" requirement, measured. */
async function expectNoOverlap(container: Locator, items: Locator): Promise<void> {
  const outer = await container.boundingBox();
  expect(outer).not.toBeNull();
  const boxes = [];
  for (let i = 0; i < (await items.count()); i++) {
    const item = items.nth(i);
    if (!(await item.isVisible())) continue;
    const box = (await item.boundingBox())!;
    boxes.push({ box, name: (await item.textContent())?.trim() || (await item.getAttribute('aria-label')) || `#${i}` });
  }
  expect(boxes.length).toBeGreaterThan(1);
  // A button's fixed height hides a wrapped label — the text spills over instead, onto its neighbours.
  // So also require every label to fit its button, and an input to keep room to type in.
  const inputWidths: Array<{ name: string; width: number }> = [];
  for (let i = 0; i < (await items.count()); i++) {
    const item = items.nth(i);
    if (!(await item.isVisible())) continue;
    const fit = await item.evaluate(el => ({
      tag: el.tagName,
      name: el.textContent?.trim() || el.getAttribute('aria-label') || '',
      // Lines the label's text actually occupies (a fixed-height button hides a wrap from scrollHeight).
      spills: (() => {
        const tops = new Set<number>();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) tops.add(Math.round(rect.top));
        }
        return tops.size > 1 || el.scrollWidth > el.clientWidth + 1;
      })(),
      width: el.getBoundingClientRect().width
    }));
    if (fit.tag !== 'INPUT') expect(fit.spills, `${fit.name} label fits on its button`).toBe(false);
    else inputWidths.push({ name: fit.name || 'input', width: fit.width });
  }
  for (const { name, width } of inputWidths) expect(width, `${name} keeps room to type`).toBeGreaterThanOrEqual(160);
  for (const { box, name } of boxes) {
    expect(box.x, `${name} starts inside its row`).toBeGreaterThanOrEqual(outer!.x - 0.5);
    expect(box.x + box.width, `${name} ends inside its row`).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5);
  }
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a]!.box;
      const q = boxes[b]!.box;
      const overlaps = p.x < q.x + q.width - 0.5 && q.x < p.x + p.width - 0.5 && p.y < q.y + q.height - 0.5 && q.y < p.y + p.height - 0.5;
      expect(overlaps, `${boxes[a]!.name} overlaps ${boxes[b]!.name}`).toBe(false);
    }
  }
}

async function addCustomEndpoint(win: Page, input: { name: string; url: string; auth?: 'bearer' | 'none'; key?: string }): Promise<void> {
  await win.getByTestId('ai-add-provider').click();
  await win.getByTestId('add-provider-tile-preset-custom').click();
  const form = win.getByTestId('custom-endpoint-form-new');
  await form.getByTestId('custom-endpoint-name').fill(input.name);
  await form.getByTestId('custom-endpoint-url').fill(input.url);
  if (input.auth === 'none') await chooseOption(form.getByTestId('custom-endpoint-auth'), 'none');
  if (input.key) await form.getByTestId('custom-endpoint-key').fill(input.key);
  await form.getByTestId('custom-endpoint-test').click();
  await expect(form.getByTestId('custom-endpoint-probe')).toBeVisible();
}

test('the list shows only providers in use; Add provider lists the rest and adds a built-in', async () => {
  const win = await launch();
  await openAiSettings(win);

  // Only the default (the gateway, configured through its env key) — no unconfigured built-in rows.
  const rows = win.getByTestId('ai-provider-list').locator('[data-testid^="ai-provider-row-"]');
  await expect(rows).toHaveCount(1);
  await expect(win.getByTestId('ai-provider-row-vercel-gateway')).toBeVisible();
  await expect(win.getByTestId('ai-provider-row-openai')).toHaveCount(0);

  await win.getByTestId('ai-add-provider').click();
  const dialog = win.getByTestId('add-provider-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('add-provider-tile-vercel-gateway')).toBeDisabled();
  await expect(dialog.getByTestId('add-provider-tile-openai')).toContainText('API key required');
  for (const preset of ['openrouter', 'groq', 'ollama', 'lm-studio', 'custom']) {
    await expect(dialog.getByTestId(`add-provider-tile-preset-${preset}`)).toBeVisible();
  }
  fs.mkdirSync(shots, { recursive: true });
  await win.screenshot({ path: path.join(shots, 'ai-provider-catalog-dialog.png') });

  // The search narrows the catalog.
  await dialog.getByTestId('add-provider-search').fill('local');
  await expect(dialog.getByTestId('add-provider-tile-preset-ollama')).toBeVisible();
  await expect(dialog.getByTestId('add-provider-tile-preset-groq')).toHaveCount(0);
  await dialog.getByTestId('add-provider-search').fill('');

  // Escape closes only the catalog; Settings stays open underneath.
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(win.getByTestId('ai-provider-list')).toBeVisible();
  await win.getByTestId('ai-add-provider').click();

  // Adding OpenAI puts it on the list, opens its setup and focuses the key field.
  await dialog.getByTestId('add-provider-tile-openai').click();
  await expect(dialog).toHaveCount(0);
  await expect(win.getByTestId('ai-provider-row-openai')).toBeVisible();
  await expect(win.getByTestId('ai-provider-body-openai')).toBeVisible();
  await expect(win.getByTestId('ai-api-key-input')).toBeFocused();
  expect(await win.evaluate(async () => (await window.praxis.settings.get()).ai.providers.openai?.added)).toBe(true);

  // Unconfigured, so it can be taken off the list again; nothing else about it changes.
  await win.getByTestId('ai-provider-remove-openai').click();
  await expect(win.getByTestId('ai-provider-row-openai')).toHaveCount(0);

  // A CLI with an explicit path override offers manual setup, not an install
  // action that would install a different executable and leave that override intact.
  await win.getByTestId('ai-add-provider').click();
  await dialog.getByTestId('add-provider-tile-claude-code-cli').click();
  await expect(win.getByTestId('ai-provider-body-claude-code-cli')).toContainText('Install the CLI, or set its path');
  await expect(win.getByTestId('ai-provider-install-claude-code-cli')).toHaveCount(0);
});

test('ACP settings clearly show installed and latest package versions', async () => {
  providerFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-acp-version-fixture-'));
  const fixtureCommand = path.join(providerFixtureDir, process.platform === 'win32' ? 'claude-agent-acp.exe' : 'claude-agent-acp');
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, fixtureCommand);
  else fs.writeFileSync(fixtureCommand, '#!/bin/sh\nprintf "0.0.0\\n"\n', { mode: 0o755 });
  // Keep the fixture first when Praxis resolves the interactive login shell's
  // PATH. A developer's real ACP may already match the registry version.
  const fixtureShell = path.join(providerFixtureDir, 'fixture-shell');
  fs.writeFileSync(fixtureShell, '#!/bin/sh\nprintf "__PRAXIS_PATH_START__%s__PRAXIS_PATH_END__" "$PATH"\n', { mode: 0o755 });
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli' } }, undefined, {
    AI_GATEWAY_API_KEY: 'gateway-e2e-key',
    ...(process.platform === 'win32' ? {} : { SHELL: fixtureShell }),
    PATH: `${providerFixtureDir}${path.delimiter}${process.env.PATH ?? ''}`
  }, { discoverInstalledCli: true });
  const win = app.window;
  const startupNotice = win.getByTestId('acp-update-notice');
  await expect(startupNotice).toBeVisible({ timeout: 15000 });
  await expect(startupNotice).toContainText('Claude Code (local)');
  await expect(startupNotice).toContainText('→');
  const artifactDir = path.resolve(process.cwd(), '../.praxis/session-artifacts');
  await fs.promises.mkdir(artifactDir, { recursive: true });
  await startupNotice.screenshot({ path: path.join(artifactDir, 'acp-update-startup-notice.png') });
  await startupNotice.getByRole('button', { name: 'Update ACP' }).click();
  await expect(win.getByRole('dialog', { name: 'Update Claude Code (local) ACP?' })).toBeVisible();
  await win.getByRole('button', { name: 'Cancel' }).click();
  await startupNotice.getByRole('button', { name: 'AI Provider settings' }).click();
  await expect(win.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(win.getByTestId('settings-nav-ai')).toBeVisible();
  await win.getByTestId('ai-provider-list').waitFor();

  const versionPanel = win.getByTestId('ai-provider-acp-versions-claude-code-cli');
  await expect(versionPanel).toBeVisible();
  await expect(win.getByTestId('ai-provider-acp-current-claude-code-cli')).toHaveText(/^v\d+\.\d+/);
  await expect(win.getByTestId('ai-provider-acp-latest-claude-code-cli')).toHaveText(/^v\d+\.\d+\.\d+$/, { timeout: 15000 });
  await expect(win.getByTestId('ai-provider-update-claude-code-cli')).toBeVisible();
  await versionPanel.screenshot({ path: path.join(artifactDir, 'ai-provider-acp-versions.png') });
});

test('a custom endpoint is tested, saved, listed with its capabilities and runs an agent session', async () => {
  mock = await startMockOpenAiCompatibleServer({ apiPath: '/v1', models: ['team/coder-large', 'team/coder-small'] });
  const win = await launch();
  await openAiSettings(win);

  await addCustomEndpoint(win, { name: 'Team vLLM', url: mock.baseUrl, key: 'e2e-custom-key' });
  const form = win.getByTestId('custom-endpoint-form-new');
  for (const step of ['models', 'chat', 'streaming', 'tools']) {
    await expect(form.getByTestId(`custom-endpoint-probe-${step}`)).toHaveAttribute('data-status', 'pass');
  }
  // The first listed model is picked for the user.
  await expect(form.getByTestId('custom-endpoint-model')).toHaveAttribute('data-value', 'team/coder-large');
  // The typed key was sent as a bearer token on the configured path.
  expect(mock.requests.some(r => r.url === '/v1/models' && r.headers.authorization === 'Bearer e2e-custom-key')).toBe(true);
  await win.screenshot({ path: path.join(shots, 'ai-provider-custom-form.png') });

  // Button clusters never overlap, even with the window narrowed.
  await app!.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 760));
  await expectNoOverlap(form.locator('.custom-endpoint-actions'), form.locator('.custom-endpoint-actions > .btn'));
  await win.screenshot({ path: path.join(shots, 'ai-provider-custom-form-narrow.png') });

  await form.getByTestId('custom-endpoint-save').click();
  const row = win.getByTestId('ai-provider-row-custom:team-vllm');
  await expect(row).toBeVisible();
  await expect(win.getByTestId('ai-provider-row-new')).toHaveCount(0);
  await expect(win.getByTestId('ai-provider-caps-custom:team-vllm').locator('[data-ok="false"]')).toHaveCount(0);

  const saved = await win.evaluate(async () => {
    const settings = await window.praxis.settings.get();
    const status = (await window.praxis.ai.listProviderStatuses()).find(s => s.provider === 'custom:team-vllm');
    return { endpoint: settings.ai.customProviders?.[0], model: settings.ai.providers['custom:team-vllm']?.defaultModel, status };
  });
  expect(saved.endpoint).toMatchObject({ id: 'custom:team-vllm', label: 'Team vLLM', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'bearer' } });
  expect(saved.endpoint?.capabilities?.tools).toBe(true);
  expect(saved.model).toBe('team/coder-large');
  expect(saved.status).toMatchObject({ configured: true, enabled: true, custom: true, label: 'Team vLLM', keySource: 'secret' });
  // The key lives in the keychain, never in the settings file.
  expect(JSON.stringify(await win.evaluate(async () => window.praxis.settings.get()))).not.toContain('e2e-custom-key');
  await win.screenshot({ path: path.join(shots, 'ai-provider-list-with-custom.png') });

  // It is a choice for new sessions, and a session on it runs against the endpoint.
  await row.locator('.ai-provider-head').getByRole('button', { name: /Make default|Use Team vLLM/ }).click();
  await expect(win.getByTestId('ai-provider-default-custom:team-vllm')).toBeVisible();
  await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();

  await win.getByTestId('new-session-provider-chip').click();
  await expect(win.getByTestId('new-session-provider-option-custom:team-vllm')).toBeEnabled();
  await win.keyboard.press('Escape');

  const before = mock.requests.length;
  const issueKey = await win.evaluate(async () => {
    const record = await window.praxis.ai.delegate({
      provider: 'custom:team-vllm',
      toolMode: 'read-only',
      goal: 'Custom endpoint smoke test',
      task: { goal: 'Custom endpoint smoke test', maxSteps: 2, timeoutMs: 30000 }
    });
    return record.issueKey;
  });
  await expect
    .poll(async () => win.evaluate(async key => (await window.praxis.ai.listSessions()).find(s => s.issueKey === key)?.state, issueKey))
    .toBe('completed');
  const chat = mock.requests.slice(before).find(r => r.url === '/v1/chat/completions');
  expect(chat?.headers.authorization).toBe('Bearer e2e-custom-key');
  expect(chat?.body).toContain('team/coder-large');
  // Vercel's caching hint never reaches another host.
  expect(chat?.body).not.toContain('providerOptions');
  const usage = await win.evaluate(async key => (await window.praxis.ai.listSessions()).find(s => s.issueKey === key)?.tokenUsage, issueKey);
  expect(usage?.totalTokens ?? 0).toBeGreaterThan(0);
});

test('an endpoint without tool calling is listed as chat only, kept out of sessions, and removable', async () => {
  mock = await startMockOpenAiCompatibleServer({ tools: false, models: ['llama-small'] });
  const win = await launch();
  await openAiSettings(win);

  await addCustomEndpoint(win, { name: 'Lab Ollama', url: mock.baseUrl, auth: 'none' });
  const form = win.getByTestId('custom-endpoint-form-new');
  await expect(form.getByTestId('custom-endpoint-probe-tools')).toHaveAttribute('data-status', 'fail');
  await expect(form.getByTestId('custom-endpoint-probe-chat')).toHaveAttribute('data-status', 'pass');
  // No key: nothing sent as Authorization.
  expect(mock.requests.every(r => r.headers.authorization === undefined)).toBe(true);
  await form.getByTestId('custom-endpoint-save').click();

  const id = 'custom:lab-ollama';
  await expect(win.getByTestId(`ai-provider-row-${id}`)).toContainText('chat only');
  await expect(win.getByTestId(`ai-provider-caps-${id}`).locator('[data-capability="tools"]')).toHaveAttribute('data-ok', 'false');

  // Still a recommendations provider — that is a one-shot prompt, no tools.
  await win.getByTestId('ai-tab-defaults').click();
  expect(await chipOptionValues(win.getByTestId('ai-recommendation-provider-select'))).toContain(id);
  await win.getByTestId('ai-tab-providers').click();

  // Main refuses an agent session on it, with the reason.
  const refused = await win.evaluate(async id => {
    try {
      await window.praxis.ai.delegate({ provider: id, toolMode: 'read-only', task: { goal: 'hello' } });
      return 'started';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, id);
  expect(refused).toMatch(/tool calling/);

  // The composer lists it, disabled, and says why.
  await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await win.getByTestId('new-session-provider-chip').click();
  const option = win.getByTestId(`new-session-provider-option-${id}`);
  await expect(option).toBeDisabled();
  await expect(option).toContainText('Chat only');
  await win.screenshot({ path: path.join(shots, 'ai-provider-session-picker.png') });
  await win.keyboard.press('Escape');

  // Removing it asks first, then deletes it and its settings.
  await openAiSettings(win);
  await win.getByTestId(`ai-provider-row-${id}`).locator('.ai-provider-head').click();
  await win.getByTestId('custom-endpoint-remove').click();
  await win.getByRole('button', { name: 'Remove endpoint' }).last().click();
  await expect(win.getByTestId(`ai-provider-row-${id}`)).toHaveCount(0);
  const after = await win.evaluate(async () => {
    const settings = await window.praxis.settings.get();
    const statuses = await window.praxis.ai.listProviderStatuses();
    return { endpoints: settings.ai.customProviders ?? [], listed: statuses.some(s => s.provider === 'custom:lab-ollama') };
  });
  expect(after).toEqual({ endpoints: [], listed: false });
});

test('the built-in API key row keeps its buttons inside the row without overlapping', async () => {
  const win = await launch();
  await app!.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 760));
  await openAiSettings(win);
  const body = win.getByTestId('ai-provider-body-vercel-gateway');
  await expect(body).toBeVisible();
  const cluster = body.locator('.ai-key-controls').first();
  await expectNoOverlap(cluster, cluster.locator('> .input, > .btn'));
  await win.screenshot({ path: path.join(shots, 'ai-provider-key-row-narrow.png') });
});
