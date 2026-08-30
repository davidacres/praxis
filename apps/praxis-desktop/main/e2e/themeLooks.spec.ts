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

async function openLooks(): Promise<void> {
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="settings-nav-appearance-looks"]').click();
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
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'blueprint');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await expect(window.locator('[data-testid="look-card-look-blueprint"]')).toHaveClass(/active/);

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'blueprint');
  await openLooks();
  await expect(window.locator('[data-testid="look-card-look-blueprint"]')).toHaveClass(/active/);
});

test('editing a dial while a Look is active is folded into that Look', async () => {
  const readIntensity = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-intensity').trim());

  await openSurfaces();
  await window.locator('[data-testid="surface-intensity"]').fill('40');
  await expect.poll(readIntensity).toBe('0.4');

  // Reload: the active Look re-applies, and it now carries the edited value.
  await window.reload();
  await expect.poll(readIntensity).toBe('0.4');
  await openLooks();
  await expect(window.locator('[data-testid="look-card-look-parchment"]')).toHaveClass(/active/);

  // Switching away and back proves the value lives in the Look, not just the
  // live appearance fields.
  await window.locator('[data-testid="look-card-look-flat"] .look-card-apply').click();
  await expect.poll(readIntensity).toBe('1');
  await window.locator('[data-testid="look-card-look-parchment"] .look-card-apply').click();
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

test('deleting the active Look detaches without wiping the others', async () => {
  await window.locator('[data-testid="look-card-look-aurora"] .look-card-apply').click();
  await expect(window.locator('[data-testid="look-card-look-aurora"]')).toHaveClass(/active/);

  await window.locator('[data-testid="look-delete-look-aurora"]').click();
  await expect(window.locator('[data-testid="look-card-look-aurora"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="look-card-look-parchment"]')).toBeVisible();
  // Nothing is active now — an edit is not mirrored anywhere.
  await expect(window.locator('.look-card.active')).toHaveCount(0);
});
