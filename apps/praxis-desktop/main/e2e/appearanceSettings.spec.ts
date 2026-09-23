import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockAddonRegistry } from './mockAddonRegistry';
import { chooseOption, chipOptionValues } from './chipSelect';

/**
 * The suite runs fully isolated (see launchTestApp.ts): each test gets its own
 * settings file via `PRAXIS_SETTINGS_PATH`, seeded here with the
 * shipped appearance defaults so assertions do not depend on any local
 * customisation. The developer's real settings file is never touched.
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

async function openAppearance(): Promise<void> {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance"]').click();
  await expect(window.locator('.settings-section-title')).toHaveText('Board Settings');
  await window.locator('.priority-color-list').waitFor({ state: 'visible' });
}

test('opens Settings from the title bar as a dismissible popover dialog', async () => {
  await expect(window.locator('[data-testid="nav-settings"]')).toHaveCount(0);
  await window.locator('[data-testid="titlebar-settings"]').click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Changes are saved automatically.')).toBeVisible();
  await expect(window.locator('[data-testid="titlebar-settings"]')).toHaveAttribute('aria-expanded', 'true');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).not.toBeVisible();
});

test('theme gallery previews and persists the selected complete palette', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await expect(window.locator('[data-testid^="theme-card-"]')).toHaveCount(4);
  await expect(window.locator('[data-testid="theme-card-praxis-light"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(window).toHaveScreenshot('theme-gallery.png');

  await window.locator('[data-testid="theme-card-praxis-dark"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await expect(window.locator('[data-testid="theme-card-praxis-dark"]')).toHaveAttribute('aria-pressed', 'true');

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.getByRole('searchbox', { name: 'Search themes' }).fill('dark');
  await expect(window.locator('[data-testid="theme-card-praxis-dark"]')).toHaveCount(1);
  await expect(window.locator('[data-testid="theme-card-praxis-light"]')).toHaveCount(0);

  await window.getByRole('searchbox', { name: 'Search themes' }).fill('default');
  const tmDefault = window.locator('[data-testid="theme-card-tm-default-1"]');
  await expect(tmDefault).toHaveCount(1);
  await tmDefault.click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'tm-default-1');
});

test('persists the selected theme and mode through app settings', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-praxis-dark"]').click();
  await window.getByRole('button', { name: 'System' }).click();
  await window.waitForTimeout(300);
  const appearance = await window.evaluate(() => window.praxis.settings.get().then(settings => settings.appearance));
  expect(appearance.themeId).toBe('praxis-dark');
  expect(appearance.themeMode).toBe('system');
  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', /praxis-(light|dark)/);
});

test('startup splash inherits the saved app theme', async () => {
  // launchTestApp already dismissed the first splash; the reload below brings a
  // fresh one back, which is the one these colour assertions read.
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-praxis-dark"]').click();
  // Clear the "returning user" flag so the reload brings the full splash these
  // colour assertions read, not the brief brand mark.
  await window.evaluate(() => localStorage.removeItem('praxis-onboarded'));
  await window.reload();

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  const colors = await window.locator('[data-testid="startup-splash"]').evaluate(splash => {
    const root = getComputedStyle(document.documentElement);
    const resolveColor = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const trail = splash.querySelector('.startup-splash-trail-thin')!;
    const dot = splash.querySelector('.startup-splash-dot-core')!;
    const loader = splash.querySelector('.startup-splash-loader')!;
    const wordmark = splash.querySelector('.startup-splash-svg')!;
    const outerRing = splash.querySelector('.startup-splash-loader-ring-outer')!;
    const innerRing = splash.querySelector('.startup-splash-loader-ring-inner')!;
    const loaderRect = loader.getBoundingClientRect();
    const wordmarkRect = wordmark.getBoundingClientRect();
    const innerRingRect = innerRing.getBoundingClientRect();
    return {
      themeBackground: resolveColor(root.getPropertyValue('--bg').trim()),
      themeElevated: resolveColor(root.getPropertyValue('--bg-elevated').trim()),
      themeText: resolveColor(root.getPropertyValue('--text').trim()),
      themeAccent: resolveColor(root.getPropertyValue('--accent').trim()),
      splashBackground: getComputedStyle(splash).backgroundImage,
      trail: getComputedStyle(trail).stroke,
      loaderRingCount: splash.querySelectorAll('.startup-splash-loader-ring').length,
      loaderWidthRatio: loaderRect.width / wordmarkRect.width,
      loaderCenterOffsetX: Math.abs(loaderRect.left + loaderRect.width / 2 - (wordmarkRect.left + wordmarkRect.width / 2)),
      loaderCenterOffsetY: Math.abs(loaderRect.top + loaderRect.height / 2 - (wordmarkRect.top + wordmarkRect.height / 2)),
      innerRingWidthRatio: innerRingRect.width / loaderRect.width,
      outerRingAccent: getComputedStyle(outerRing).color,
      outerRingDirection: getComputedStyle(outerRing).animationDirection,
      outerRingBackground: getComputedStyle(outerRing).backgroundImage,
      innerRingAccent: getComputedStyle(innerRing).color,
      innerRingDirection: getComputedStyle(innerRing).animationDirection,
      loaderAnimation: getComputedStyle(outerRing).animationName,
      dot: getComputedStyle(dot).stopColor
    };
  });

  expect(colors.splashBackground).toContain(colors.themeBackground);
  expect(colors.splashBackground).toContain(colors.themeElevated);
  expect(colors.trail).toBe(colors.themeText);
  expect(colors.loaderRingCount).toBe(2);
  expect(colors.loaderWidthRatio).toBeCloseTo(0.5, 2);
  expect(colors.loaderCenterOffsetX).toBeLessThanOrEqual(1);
  expect(colors.loaderCenterOffsetY).toBeLessThanOrEqual(1);
  expect(colors.innerRingWidthRatio).toBeGreaterThan(0.9);
  expect(colors.outerRingAccent).toBe(colors.themeAccent);
  expect(colors.innerRingAccent).toBe(colors.themeAccent);
  expect(colors.outerRingBackground).toContain('conic-gradient');
  expect(colors.outerRingDirection).toBe('normal');
  expect(colors.innerRingDirection).toBe('reverse');
  expect(colors.loaderAnimation).toBe('startup-splash-loader-spin');
  expect(colors.dot).toBe(colors.themeAccent);
});

test('installs a marketplace theme and makes it available on reload', async () => {
  await closeTestApp(app);
  const registry = await startMockAddonRegistry({
    owner: 'acme',
    addons: [{
      packageName: 'praxis-addon-dracula',
      version: '1.0.0',
      manifest: {
        schemaVersion: 1,
        kind: 'theme',
        id: 'dracula-dark',
        name: 'Dracula',
        summary: 'A dark gothic theme.',
        author: 'acme',
        display: {
          mode: 'dark',
          preview: {
            canvas: '#282a36', panel: '#44475a', raised: '#6272a4', border: '#6272a4',
            text: '#f8f8f2', muted: '#6272a4', accent: '#bd93f9',
            success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555'
          }
        }
      },
      payload: {
        'theme.json': {
          id: 'dracula-dark',
          name: 'Dracula',
          mode: 'dark',
          description: 'A dark gothic theme.',
          preview: {
            canvas: '#282a36', panel: '#44475a', raised: '#6272a4', border: '#6272a4',
            text: '#f8f8f2', muted: '#6272a4', accent: '#bd93f9',
            success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555'
          }
        }
      }
    }]
  });
  try {
    app = await launchTestApp({
      appearance: DEFAULT_APP_SETTINGS.appearance,
      marketplace: {
        enabled: true,
        owner: 'acme',
        ownerType: 'user',
        packageNamePrefix: 'praxis-addon-',
        apiBaseUrl: registry.baseUrl,
        registryBaseUrl: registry.baseUrl,
        checkOnLaunch: false
      }
    }, undefined, { PRAXIS_MARKETPLACE_TOKEN: 'e2e-token' });
    window = app.window;

    await window.locator('[data-testid="titlebar-settings"]').click();
    await window.locator('[data-testid="settings-nav-appearance-themes"]').click();

    const marketplace = window.locator('[data-testid="theme-marketplace"]');
    await expect(marketplace).toBeVisible();
    const card = marketplace.locator('[data-testid="theme-card-dracula-dark"]');
    await expect(card).toHaveAttribute('aria-label', /available in marketplace/);
    await card.click();
    const galleryCard = window.locator('.theme-gallery-section [data-testid="theme-card-dracula-dark"]').first();
    await expect(galleryCard).toBeVisible();
    await galleryCard.click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dracula-dark');
    await window.reload();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dracula-dark');
  } finally {
    await registry.close();
  }
});

test('creates a custom theme with editable colors and persists it', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.getByRole('button', { name: /Create custom theme/ }).click();
  const editor = window.getByRole('region', { name: 'Custom theme editor' });
  await editor.getByLabel('Name').fill('Ocean Custom');
  await editor.getByLabel('Accent').last().fill('#149eca');
  await editor.getByRole('button', { name: 'Save theme' }).click();
  const custom = await window.evaluate(() => window.praxis.settings.get().then(settings => settings.appearance.customThemes.at(-1)));
  expect(custom?.name).toBe('Ocean Custom');
  await expect(window.locator('html')).toHaveAttribute('data-theme', custom!.id);
  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', custom!.id);
});

test('gradient priorities expose a picker per stop plus a direction control', async () => {
  await openAppearance();

  // Highest ships as `linear-gradient(to bottom, #DC2626, #EA580C)`.
  await expect(window.getByLabel('Highest gradient start color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Highest gradient end color')).toHaveValue('#ea580c');
  await expect(window.getByLabel('Highest gradient direction')).toHaveAttribute('data-value', 'to bottom');

  // Solid priorities get a single picker and no direction control.
  await expect(window.getByLabel('Lowest priority color')).toHaveValue('#22c55e');
  await expect(window.getByLabel('Lowest gradient direction')).toHaveCount(0);
});

test('terminal settings expose detected profiles and persist appearance preferences', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-terminal"]').click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.locator('.settings-section-title')).toHaveText('Terminal');
  expect(await chipOptionValues(dialog.getByLabel('Terminal default profile'))).not.toHaveLength(0);
  await dialog.getByLabel('Terminal font size').fill('16');
  await chooseOption(dialog.getByLabel('Terminal cursor style'), 'underline');
  await dialog.getByRole('switch', { name: 'Copy on selection' }).click();
  await window.waitForTimeout(500);

  await window.reload();
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-terminal"]').click();
  await expect(window.getByLabel('Terminal font size')).toHaveValue('16');
  await expect(window.getByLabel('Terminal cursor style')).toHaveAttribute('data-value', 'underline');
  await expect(window.getByRole('switch', { name: 'Copy on selection' })).toHaveAttribute('aria-checked', 'true');
});

test('solid and gradient round trip through the mode toggle and survive a reload', async () => {
  await openAppearance();

  const criticalRow = window.locator('.priority-color-row', { hasText: 'Critical' });
  await expect(window.getByLabel('Critical priority color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient start color')).toHaveCount(0);

  await criticalRow.getByRole('button', { name: 'Gradient' }).click();

  // The second stop is seeded 35% darker so the new gradient reads as a gradient.
  await expect(window.getByLabel('Critical gradient start color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient end color')).toHaveValue('#8f1919');

  await chooseOption(window.getByLabel('Critical gradient direction'), 'to right');
  await window.waitForTimeout(300);

  await window.reload();
  await openAppearance();
  await expect(window.getByLabel('Critical gradient direction')).toHaveAttribute('data-value', 'to right');
  await expect(window.getByLabel('Critical gradient start color')).toHaveValue('#dc2626');

  // Back to solid: the first stop becomes the solid color.
  await criticalRow.getByRole('button', { name: 'Solid' }).click();
  await expect(window.getByLabel('Critical priority color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient start color')).toHaveCount(0);
});
