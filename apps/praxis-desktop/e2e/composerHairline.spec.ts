import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp } from './launchTestApp';

test('Hairline selects, persists and keeps a compact scrolling writing surface', async () => {
  const app = await launchTestApp();
  try {
    const page = app.window;
    await page.getByTestId('titlebar-settings').click();
    await page.getByTestId('settings-nav-appearance-composers').click();
    await page.getByTestId('composer-style-hairline').click();
    await expect(page.getByTestId('composer-style-hairline')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
    const card = page.locator('.session-follow-up-composer').first();
    await expect(card).toHaveAttribute('data-composer-style', 'hairline');
    const input = card.locator('textarea').first();
    await input.fill('Explore a quieter way to work.');
    const height = (await input.boundingBox())!.height;
    expect(height).toBeLessThanOrEqual(64);
    await input.fill(Array.from({length: 40}, (_, i) => `Draft line ${i}`).join('\n'));
    expect((await input.boundingBox())!.height).toBeCloseTo(height, 0);
    expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(card.locator('.ambient-horizon')).toHaveCount(0);
    // Proves that the actual Hairline rule paints, rather than an inherited transparent border.
    expect(await card.evaluate(el => getComputedStyle(el).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
    await input.fill('Explore a quieter way to work.');
    const artifacts = path.resolve(__dirname, '../.praxis/session-artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    await page.screenshot({path: path.join(artifacts, 'composer-hairline.png'), animations: 'disabled'});
    await page.reload();
    await expect(card).toHaveAttribute('data-composer-style', 'hairline');
    expect((await page.evaluate(() => window.praxis.settings.get())).appearance.composerStyle).toBe('hairline');
    await page.emulateMedia({reducedMotion: 'reduce'});
    expect(await card.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  } finally { await closeTestApp(app); }
});

test('Hairline keeps its writing area stable and hides chips during activity', async () => {
  const { startMockGatewayServer } = await import('./mockGatewayServer');
  const { openSession } = await import('./sessionNavigation');
  const gateway = await startMockGatewayServer({mode: 'complete'});
  const app = await launchTestApp({ai: {activeProvider: 'vercel-gateway', defaultModel: 'mock/model', gatewayUrl: gateway.baseUrl}}, undefined,
    {AI_GATEWAY_API_KEY: 'hairline-test', AI_GATEWAY_URL: gateway.baseUrl});
  try {
    const page = app.window;
    await page.evaluate(() => window.praxis.settings.set({appearance: {composerStyle: 'hairline', themeId: 'praxis-dark', themeMode: 'dark'}}));
    const record = await page.evaluate(() => window.praxis.ai.delegate({goal: 'Check the Hairline composer', mode: 'execute', toolMode: 'read-only'}));
    await expect.poll(async () => (await page.evaluate(key => window.praxis.ai.getSession(key), record.issueKey)).state).toBe('completed');
    await openSession(page, record.issueKey);
    const completed = await page.evaluate(key => window.praxis.ai.getSession(key), record.issueKey);
    const composer = page.locator('.session-chat-composer');
    const input = composer.locator('textarea.composer-input');
    await input.fill('Keep the writing surface calm.');
    const height = (await input.boundingBox())!.height;
    const chip = page.getByTestId('session-permission-chip');
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.locator('[data-composer-part="menu"]').first()).toHaveAttribute('data-composer-style', 'hairline');
    await chip.click();
    await expect(page.locator('[data-composer-part="menu"]')).toHaveCount(0);
    await app.emitEvent('ai:sessionChanged', {...completed, state: 'running'});
    await expect(chip).toHaveCount(1);
    await expect(chip).toBeHidden();
    await expect(input).not.toHaveClass(/is-collapsed/);
    expect((await input.boundingBox())!.height).toBeCloseTo(height, 0);
    await composer.screenshot({path: path.resolve(__dirname, '../.praxis/session-artifacts/composer-hairline-busy.png'), animations: 'disabled'});
    await app.emitEvent('ai:sessionChanged', completed);
    await expect(chip).toBeVisible();
    await input.fill('');
    await expect(page.getByTestId('session-prompt-score-wrapper')).toBeHidden();
    await page.screenshot({path: path.resolve(__dirname, '../.praxis/session-artifacts/composer-hairline-session.png'), animations: 'disabled'});
  } finally { await closeTestApp(app); await gateway.close(); }
});
