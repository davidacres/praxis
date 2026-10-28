import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

const palette = {
  canvas: '#16202a', panel: '#203040', raised: '#102030', border: '#556677', text: '#eeeeee',
  muted: '#aabbcc', accent: '#ff8844', success: '#55bb88', warning: '#ddbb44', danger: '#ee5566'
};
const custom = { id: 'custom-accent-proof', name: 'Custom accent proof', mode: 'dark' as const, description: '', preview: palette };
const installed = { ...custom, id: 'installed-accent-proof', name: 'Installed accent proof' };

async function openThemes() {
  const page = app!.window;
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('settings-nav-appearance-themes').click();
}
async function currentAccent() {
  return app!.window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
}
async function enterColor(color: string) {
  const input = app!.window.getByTestId('theme-accent-hex');
  await input.fill(color);
  await input.press('Tab');
  await expect.poll(currentAccent).toBe(color);
}

// Proven against the old theme application by disabling applyAccentTokens: the first accent assertion fails.
test('one accent overrides every theme, survives Looks and reload, and restores custom and installed palette defaults', async () => {
  test.setTimeout(60000);
  app = await launchTestApp({ appearance: { customThemes: [custom], installedThemeIds: [custom.id, installed.id] } });
  await app.electronApp.evaluate(({ ipcMain }, installed) => {
    ipcMain.removeHandler('marketplace:listActiveAppearance');
    ipcMain.handle('marketplace:listActiveAppearance', () => ({ themes: [installed], surfacePacks: [] }));
  }, installed);
  await app.window.reload();
  await openThemes();
  const page = app.window;
  await enterColor('#00aacc');
  await page.getByRole('group', { name: 'Theme appearance mode' }).getByRole('button', { name: 'System' }).click();
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-mode', colorScheme);
    await expect.poll(currentAccent).toBe('#00aacc');
  }
  for (const id of ['praxis-light', 'praxis-dark', 'tm-default-1', 'tm-default-2', 'simple', custom.id, installed.id]) {
    await page.getByTestId(`theme-card-${id}`).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await expect.poll(currentAccent).toBe('#00aacc');
  }
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).appearance.accentColor)).toBe('#00aacc');
  // Theme default is the installed palette, including palettes without a bundled CSS selector.
  await page.getByRole('button', { name: 'Use theme default' }).click();
  await expect.poll(currentAccent).toBe(palette.accent);
  await page.getByTestId(`theme-card-${custom.id}`).first().click();
  await expect.poll(currentAccent).toBe(palette.accent);
  await enterColor('#ffee00');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-contrast').trim())).toBe('#000000');
  const capture = path.resolve(__dirname, '../../.praxis/session-artifacts/accent-custom-theme.png');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  await page.getByRole('dialog', { name: 'Settings' }).screenshot({ path: capture });
  await page.reload();
  await expect.poll(currentAccent).toBe('#ffee00');
  await openThemes();
  await page.getByTestId('settings-nav-appearance-looks').click();
  await page.getByTestId('look-card-look-blueprint').getByRole('button', { name: 'Apply the Blueprint Look' }).click();
  await expect.poll(currentAccent).toBe('#ffee00');
  await page.getByTestId('settings-nav-appearance-themes').click();
  await page.getByTestId('theme-card-praxis-light').click();
  await enterColor('#221166');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-contrast').trim())).toBe('#ffffff');
  const input = page.getByTestId('theme-accent-hex');
  await input.fill('#nope');
  await input.press('Tab');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect.poll(currentAccent).toBe('#221166');
  await page.getByRole('button', { name: 'Use theme default' }).click();
  await expect.poll(currentAccent).toBe('#c6431f');
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).appearance.accentColor)).toBe('');
  await page.getByRole('dialog', { name: 'Settings' }).screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/accent-theme-default.png') });
});
