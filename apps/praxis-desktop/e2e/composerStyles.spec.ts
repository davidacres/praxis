import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
test.afterEach(async () => { if (app) await closeTestApp(app); });

test('composer gallery applies globally, preserves a draft, and persists across reload', async () => {
  app = await launchTestApp();
  const page = app.window;
  const artifacts = path.resolve(__dirname, '../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const card = page.locator('.session-follow-up-composer').first();
  await expect(card).toHaveAttribute('data-composer-style', 'classic');
  const input = card.locator('textarea').first();
  await input.fill('Explore the composer gallery');
  await card.screenshot({ path: path.join(artifacts, 'composer-classic.png') });
  async function gallery() {
    await page.getByTestId('titlebar-settings').click();
    await page.getByTestId('settings-nav-appearance-composers').click();
  }
  await gallery();
  const ambient = page.getByTestId('composer-style-ambient-canvas');
  await ambient.click();
  await expect(ambient).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toHaveAttribute('data-composer-style', 'ambient-canvas');
  await page.locator('.settings-content').screenshot({ path: path.join(artifacts, 'composer-gallery.png') });
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await expect(input).toHaveValue('Explore the composer gallery');
  await input.focus();
  const canvas = card.locator('.ambient-composer-canvas');
  await expect(canvas.locator('.ambient-horizon')).toHaveCount(1);
  await expect(card.locator('.composer-input-shell')).toHaveCSS('translate', '0px -2px');
  const geometry = await card.evaluate(element => {
    const field = element.querySelector('textarea')!.getBoundingClientRect();
    const surface = element.querySelector('.ambient-composer-canvas')!.getBoundingClientRect();
    const header = element.querySelector('.session-mode-panel')!.getBoundingClientRect();
    return { inputOffset: field.top - surface.top, controlsBelowInput: header.top >= field.bottom, height: surface.height };
  });
  expect(geometry.inputOffset).toBeCloseTo(102, 0);
  expect(geometry.controlsBelowInput).toBe(true);
  expect(geometry.height).toBeLessThan(210);
  const before = await card.boundingBox();
  await input.fill('A long draft with internal scrolling.\n'.repeat(40));
  expect((await card.boundingBox())!.height).toBeCloseTo(before!.height, 0);
  expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await input.evaluate(el => el.clientWidth / el.closest('.ambient-composer-canvas')!.clientWidth)).toBeGreaterThan(0.9);
  await input.fill('Explore the composer gallery');
  await card.screenshot({ path: path.join(artifacts, 'composer-ambient-canvas.png') });
  await page.reload();
  const splash = page.getByTestId('startup-splash');
  if (await splash.isVisible()) await splash.click();
  await expect(splash).toBeHidden();
  await expect(card).toHaveAttribute('data-composer-style', 'ambient-canvas');
  expect((await page.evaluate(() => window.praxis.settings.get())).appearance.composerStyle).toBe('ambient-canvas');
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } }));
  await expect(card).toHaveAttribute('data-composer-style', 'ambient-canvas');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await expect.poll(() => input.evaluate(field => field.clientHeight >= parseFloat(getComputedStyle(field).lineHeight))).toBe(true);
  await input.fill('Explore the composer gallery');
  await input.focus();
  await card.screenshot({ path: path.join(artifacts, 'composer-ambient-dark.png') });
  const reference = await page.context().newPage();
  await reference.setViewportSize({ width: 740, height: 900 });
  await reference.emulateMedia({ reducedMotion: 'reduce' });
  await reference.setContent(fs.readFileSync(path.resolve(__dirname, '../../../docs/published-artifacts/composer-5-ambient-canvas.html'), 'utf8'));
  await reference.locator('textarea').fill('Explore the composer gallery');
  await reference.locator('.canvas-wrap').screenshot({ path: path.join(artifacts, 'composer-concept5-reference.png') });
  await reference.close();
  // Reject arbitrary style values at the native settings boundary.
  await page.evaluate(() => window.praxis.settings.set({ appearance: { composerStyle: 'invalid' } } as never));
  await expect(card).toHaveAttribute('data-composer-style', 'classic');
  await gallery();
  await ambient.click();
  await page.getByTestId('composer-style-classic').click();
  await expect(card).toHaveAttribute('data-composer-style', 'classic');
  await expect(card.locator('.ambient-horizon')).toHaveCount(0);
});

test('composer presentation covers selectors, menus, usage and prompt feedback while Classic retains its controls', async () => {
  const { startMockGatewayServer } = await import('./mockGatewayServer');
  const { chooseOption } = await import('./chipSelect');
  const gateway = await startMockGatewayServer({ mode: 'complete', replyFor: body => {
    if (!body.includes('fixed checklist')) return undefined;
    const checks = Object.fromEntries(['target', 'outcome', 'done', 'context-gap', 'ambiguity'].map(id => [id, {
      answer: id === 'context-gap' || id === 'ambiguity' ? 'no' : 'yes', evidence: '', fix: '', question: 'What result do you want?'
    }]));
    const unknown = { text: '', evidence: '', source: 'unknown' };
    return JSON.stringify({ kind: 'instruction', checks, interpretation: { target: unknown, change: unknown, result: unknown, preserve: [] } });
  } });
  try {
    app = await launchTestApp({
      ai: { activeProvider: 'vercel-gateway', defaultModel: 'mock/model', gatewayUrl: gateway.baseUrl }
    }, undefined, { AI_GATEWAY_API_KEY: 'composer-style-test', AI_GATEWAY_URL: gateway.baseUrl });
    const page = app.window;
    const artifacts = path.resolve(__dirname, '../.praxis/session-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const scope = page.getByTestId('new-session-view');
    const presentation = scope.locator('.session-composer-presentation');
    const input = scope.locator('textarea.composer-input');
    await chooseOption(page.getByTestId('new-session-tool-mode'), 'read-only');
    await input.fill('fix the truncated headline in the prompt score bar');
    const analysis = page.getByTestId('session-prompt-score-wrapper');
    await expect(analysis).toBeVisible();
    await expect(page.getByTestId('new-session-model-chip')).toBeVisible();
    await presentation.screenshot({ path: path.join(artifacts, 'composer-classic-complete.png') });
    const classicRadius = await page.getByTestId('new-session-submit').evaluate(el => getComputedStyle(el).borderRadius);
    await page.evaluate(() => window.praxis.settings.set({ appearance: { composerStyle: 'ambient-canvas' } }));
    await expect(presentation).toHaveAttribute('data-composer-custom', 'true');
    await expect(analysis).toHaveAttribute('data-composer-part', 'analysis');
    await expect(page.getByTestId('session-usage-summary')).toHaveCSS('border-top-width', '0px');
    await expect(page.getByTestId('new-session-submit')).toHaveCSS('border-radius', '999px');
    await expect(analysis).not.toContainText('Checking clarity');
    await expect(page.getByTestId('session-prompt-check-unavailable')).toHaveCount(0);
    await input.focus();
    await presentation.screenshot({ path: path.join(artifacts, 'composer-ambient-complete.png') });
    await page.getByTestId('prompt-strip-details-toggle').click();
    await expect(page.getByTestId('prompt-coach-details')).toBeVisible();
    await page.getByTestId('prompt-strip-details-toggle').click();
    await expect(page.getByTestId('prompt-coach-details')).toHaveCount(0);
    await page.getByTestId('session-usage-summary').locator(':scope > summary').click();
    await expect(page.getByTestId('session-usage-expanded')).toBeVisible();
    await presentation.screenshot({ path: path.join(artifacts, 'composer-ambient-usage.png') });
    await page.getByTestId('session-usage-summary').locator(':scope > summary').click();
    await page.getByTestId('new-session-model-chip').click();
    const menu = page.locator('.composer-model-menu');
    await expect(menu).toHaveAttribute('data-composer-style', 'ambient-canvas');
    await expect(menu).toHaveCSS('border-radius', '16px');
    await page.screenshot({ path: path.join(artifacts, 'composer-ambient-model-menu.png') });
    await page.getByTestId('new-session-model-chip').click();
    await page.evaluate(() => window.praxis.settings.set({ appearance: { composerStyle: 'classic' } }));
    await expect(presentation).not.toHaveAttribute('data-composer-custom', 'true');
    await expect(page.getByTestId('new-session-submit')).toHaveCSS('border-radius', classicRadius);
    await page.getByTestId('new-session-model-chip').click();
    await expect(menu).toHaveAttribute('data-composer-style', 'classic');
    await expect(input).toHaveValue('fix the truncated headline in the prompt score bar');
    await page.getByTestId('new-session-model-chip').click();
    await page.evaluate(() => window.praxis.settings.set({ appearance: { composerStyle: 'ambient-canvas', themeId: 'praxis-dark', themeMode: 'dark' } }));
    const record = await page.evaluate(async () => {
      const created = await window.praxis.ai.delegate({ goal: 'Review composer controls', toolMode: 'read-only', task: { goal: 'Review composer controls', maxSteps: 2, timeoutMs: 10000 } });
      return created;
    });
    await expect.poll(() => page.evaluate(key => window.praxis.ai.getSession(key).then(s => s?.state), record.issueKey)).toBe('completed');
    const { openSession } = await import('./sessionNavigation');
    await openSession(page, record.issueKey);
    const completed = { ...(await page.evaluate(key => window.praxis.ai.getSession(key), record.issueKey)), acpAvailableCommands: [{ name: 'explain', description: 'Explain the selected changes' }] };
    // Synthetic agent command availability; no slash command is executed.
    await app.emitEvent('ai:sessionChanged', { ...completed, acpAvailableCommands: [{ name: 'explain', description: 'Explain the selected changes' }] });
    const commands = page.getByTestId('session-acp-commands');
    await expect(commands).toBeVisible();
    await commands.click();
    const commandMenu = page.getByRole('listbox', { name: 'Agent commands' });
    await expect(commandMenu).toHaveAttribute('data-composer-style', 'ambient-canvas');
    await expect(commandMenu).toHaveCSS('border-radius', '16px');
    await page.screenshot({ path: path.join(artifacts, 'composer-ambient-commands.png') });
    await commands.click();
    await page.locator('.session-chat-composer').screenshot({ path: path.join(artifacts, 'composer-ambient-existing.png') });
    const activeInput = page.locator('.session-chat-composer textarea.composer-input');
    const writingHeight = (await activeInput.boundingBox())!.height;
    await app.emitEvent('ai:sessionChanged', { ...completed, state: 'running' });
    await expect(activeInput).not.toHaveClass(/is-collapsed/);
    expect((await activeInput.boundingBox())!.height).toBeCloseTo(writingHeight, 0);
    await expect(page.locator('.session-chat-composer [data-composer-slot="toolbar"]')).toBeVisible();
    await expect(commands).toBeHidden();
    await expect(page.getByTestId('session-permission-chip')).toHaveCount(1);
    await expect(page.getByTestId('session-permission-chip')).toBeHidden();
    const busyHeight = (await activeInput.boundingBox())!.height;
    await page.locator('.session-chat-composer').screenshot({ path: path.join(artifacts, 'composer-ambient-busy.png'), animations: 'disabled' });
    await app.emitEvent('ai:sessionChanged', completed);
    await expect(commands).toBeVisible();
    expect((await activeInput.boundingBox())!.height).toBeCloseTo(busyHeight, 0);
    await page.locator('.session-chat-composer').screenshot({ path: path.join(artifacts, 'composer-ambient-chips.png'), animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(commands).toHaveCSS('animation-name', 'none');
    await app.emitEvent('ai:sessionChanged', { ...completed, state: 'running' });
    await expect(commands).toBeHidden();
    await expect(page.getByTestId('session-permission-chip')).toHaveCount(1);
    await expect(page.getByTestId('session-permission-chip')).toBeHidden();
    await app.emitEvent('ai:sessionChanged', completed);
    await expect(commands).toBeVisible();
  } finally { await gateway.close(); }
});
