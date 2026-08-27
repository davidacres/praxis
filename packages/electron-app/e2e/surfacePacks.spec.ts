import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@ticket-manager/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * Phase 1 of Surface Packs — the premium material layer applied on the
 * `data-surface` axis, composed over whatever theme is active. The suite seeds
 * the shipped appearance defaults, so every launch starts on `parchment`.
 */
let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp({ appearance: DEFAULT_APP_SETTINGS.appearance });
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

async function openSurface(): Promise<void> {
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="surface-section"]').scrollIntoViewIfNeeded();
  await expect(window.locator('[data-testid="surface-section"]')).toBeVisible();
}

test('ships default-on with the Parchment surface over the Praxis theme', async () => {
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');

  // The pack drives a real texture layer on the panel shells.
  const textureOpacity = await window.locator('.pane-main').evaluate(el =>
    parseFloat(getComputedStyle(el, '::after').opacity)
  );
  expect(textureOpacity).toBeGreaterThan(0);
});

test('switches surface pack, composing over the current theme, and persists it', async () => {
  await openSurface();
  await expect(window.locator('[data-testid="surface-card-parchment"]')).toHaveAttribute('aria-pressed', 'true');

  await window.locator('[data-testid="surface-card-graphite"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');
  await expect(window.locator('[data-testid="surface-card-graphite"]')).toHaveAttribute('aria-pressed', 'true');
  // The theme axis is untouched.
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');
});

test('the Intensity dial scales the texture and is disabled for Flat', async () => {
  await openSurface();

  const readIntensity = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-intensity').trim());
  expect(await readIntensity()).toBe('1');

  await window.locator('[data-testid="surface-intensity"]').fill('40');
  await expect.poll(readIntensity).toBe('0.4');

  await window.reload();
  await window.locator('[data-testid="titlebar-themes"]').click();
  expect(await readIntensity()).toBe('0.4');

  await window.locator('[data-testid="surface-card-flat"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'flat');
  await expect(window.locator('[data-testid="surface-intensity"]')).toBeDisabled();
  await expect(window.locator('[data-testid="surface-texture-toggle"]')).toBeDisabled();
});

test('contrast guard: no bundled pack pushes a panel texture past the safe ceiling', async () => {
  // Phase 1's only new contrast risk is texture opacity on panels. Blueprint
  // keeps panels clean (0); Parchment/Graphite stay well under the ceiling that
  // would erode WCAG AA for body text. Checked at full intensity over both
  // Praxis variants by driving the axes directly — this is a pure-CSS fact.
  const CEILING = 0.14;
  for (const mode of ['dark', 'light']) {
    for (const pack of ['flat', 'parchment', 'graphite', 'blueprint']) {
      const opacity = await window.locator('.pane-main').evaluate((el, [m, p]) => {
        const root = document.documentElement;
        root.setAttribute('data-mode', m);
        root.setAttribute('data-theme', `praxis-${m}`);
        root.setAttribute('data-surface', p);
        root.style.setProperty('--surface-intensity', '1');
        root.style.setProperty('--surface-texture', '1');
        return parseFloat(getComputedStyle(el, '::after').opacity);
      }, [mode, pack] as const);
      expect(opacity, `${pack} @ praxis-${mode}`).toBeLessThanOrEqual(CEILING);
    }
  }
});

test('the Texture toggle gates the grain layer without changing the pack', async () => {
  await openSurface();
  const readTextureGate = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-texture').trim());
  expect(await readTextureGate()).toBe('1');

  await window.locator('[data-testid="surface-texture-toggle"]').click();
  await expect.poll(readTextureGate).toBe('0');
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');

  const textureOpacity = await window.locator('.pane-main').evaluate(el =>
    parseFloat(getComputedStyle(el, '::after').opacity)
  );
  expect(textureOpacity).toBe(0);
});
