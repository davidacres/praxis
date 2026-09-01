import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * Looks — switchable presets that bundle the whole appearance stack (theme,
 * mode, surface pack, dials/motif, priority colours, brand artwork). The suite
 * seeds the shipped appearance defaults, so every launch starts on the
 * `look-parchment` Look over the Praxis theme.
 *
 * Looks, Themes, and Surfaces each have their own node under Settings →
 * Appearance; `openLooks()` / `openSurfaces()` navigate to the right one.
 */
let app: TestApp;
let window: Page;

/**
 * Idempotent: the titlebar button *toggles* Settings, so clicking it when the
 * dialog is already open would close it. The Appearance group's children only
 * exist in the DOM while the group is expanded.
 */
async function openLooks(): Promise<void> {
  const group = window.locator('[data-testid="settings-nav-appearance-group"]');
  const looks = window.locator('[data-testid="settings-nav-appearance-looks"]');
  if (!(await group.isVisible())) {
    await window.locator('[data-testid="titlebar-settings"]').click();
  }
  if (!(await looks.isVisible())) {
    await group.click();
  }
  await looks.click();
  await expect(window.locator('[data-testid="looks-strip"]')).toBeVisible();
}

async function openSurfaces(): Promise<void> {
  await window.locator('[data-testid="settings-nav-appearance-surfaces"]').click();
  await expect(window.locator('[data-testid="surface-section"]')).toBeVisible();
}

test.beforeEach(async () => {
  app = await launchTestApp({ appearance: DEFAULT_APP_SETTINGS.appearance });
  window = app.window;
  await openLooks();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('ships the four built-in Looks with Parchment active', async () => {
  for (const id of ['look-parchment', 'look-blueprint', 'look-aurora', 'look-flat']) {
    await expect(window.locator(`[data-testid="look-card-${id}"]`)).toBeVisible();
  }
  await expect(window.locator('[data-testid="look-card-look-parchment"]')).toHaveClass(/active/);
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
});

test('selecting a Look swaps theme + surface together and persists', async () => {
  await window.locator('[data-testid="look-card-look-blueprint"] .look-card-apply').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await expect(window.locator('[data-testid="look-card-look-blueprint"]')).toHaveClass(/active/);

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
  await openLooks();
  await expect(window.locator('[data-testid="look-card-look-blueprint"]')).toHaveClass(/active/);
});

test('editing a dial while a Look is active is folded into that Look', async () => {
  await window.locator('[data-testid="look-save"]').click();
  await window.locator('[data-testid="look-name-input"]').fill('Editable Look');
  await window.locator('[data-testid="look-save-confirm"]').click();

  const readIntensity = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-intensity').trim());

  await openSurfaces();
  await window.locator('[data-testid="surface-intensity"]').fill('40');
  await expect.poll(readIntensity).toBe('0.4');

  // Reload: the active Look re-applies, and it now carries the edited value.
  await window.reload();
  await expect.poll(readIntensity).toBe('0.4');
  await openLooks();
  await expect(window.locator('.look-card.active')).toContainText('Editable Look');

  // Switching away and back proves the value lives in the Look, not just the
  // live appearance fields.
  await window.locator('[data-testid="look-card-look-flat"] .look-card-apply').click();
  await expect.poll(readIntensity).toBe('1');
  await window.locator('.look-card').filter({ hasText: 'Editable Look' }).locator('.look-card-apply').click();
  await expect.poll(readIntensity).toBe('0.4');
});

test('Save current as Look adds a card that survives a reload', async () => {
  await window.locator('[data-testid="look-save"]').click();
  await window.locator('[data-testid="look-name-input"]').fill('My Look');
  await window.locator('[data-testid="look-save-confirm"]').click();

  const mine = window.locator('.look-card').filter({ hasText: 'My Look' });
  await expect(mine).toHaveClass(/active/);

  await window.reload();
  await openLooks();
  await expect(window.locator('.look-card').filter({ hasText: 'My Look' })).toHaveCount(1);
});

test('built-in Looks cannot be renamed or deleted, while custom Looks can', async () => {
  await expect(window.locator('[data-testid="look-rename-look-aurora"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="look-delete-look-aurora"]')).toHaveCount(0);

  await window.locator('[data-testid="look-save"]').click();
  await window.locator('[data-testid="look-name-input"]').fill('Editable Look');
  await window.locator('[data-testid="look-save-confirm"]').click();
  const custom = window.locator('.look-card').filter({ hasText: 'Editable Look' });
  await expect(custom.locator('[data-testid^="look-rename-"]')).toBeVisible();
  await custom.locator('[data-testid^="look-rename-"]').click();
  const renameInput = window.getByRole('textbox', { name: 'Rename Editable Look' });
  await renameInput.fill('Renamed Look');
  await renameInput.press('Enter');
  const renamed = window.locator('.look-card').filter({ hasText: 'Renamed Look' });
  await expect(renamed).toBeVisible();
  await renamed.locator('[data-testid^="look-delete-"]').click();
  await expect(window.locator('.look-card').filter({ hasText: 'Renamed Look' })).toHaveCount(0);
});

test('factory appearance reset restores the theme, Look, surface, and libraries', async () => {
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-humanist-light"]').click();
  await openSurfaces();
  await window.locator('[data-testid="surface-card-graphite"]').click();
  await window.evaluate(() => window.praxis.settings.set({ appearance: { surface: { motif: { id: 'binary', scale: 80, opacity: 0.4, ink: 'accent' } } } }));
  await window.locator('[data-testid="settings-nav-overview"]').click();
  await window.locator('[data-testid="reset-appearance-factory"]').click();
  await expect(window.getByRole('dialog', { name: 'Reset appearance to factory defaults?' })).toBeVisible();
  await window.locator('[data-testid="reset-confirmation-overlay"]').getByRole('button', { name: 'Reset appearance' }).click();

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
  const appearance = await window.evaluate(() => window.praxis.settings.get().then(settings => settings.appearance));
  expect(appearance.activeLookId).toBe('look-parchment');
  expect(appearance.looks).toHaveLength(4);
  expect(appearance.customThemes).toHaveLength(0);
  expect(appearance.customSurfacePacks).toHaveLength(0);
  expect(appearance.surface.motif).toBeUndefined();
  const stored = await window.evaluate(() => window.praxis.settings.get());
  expect(stored.appearance.surface.motif).toBeUndefined();
});
