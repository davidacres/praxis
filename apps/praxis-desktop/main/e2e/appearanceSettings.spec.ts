import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

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
  await window.locator('[data-testid="titlebar-themes"]').click();
  await expect(window.locator('[data-testid^="theme-card-"]')).toHaveCount(27);
  await expect(window.locator('[data-testid="theme-card-praxis-dark"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(window).toHaveScreenshot('theme-gallery.png');

  await window.locator('[data-testid="theme-card-humanist-light"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'humanist-light');
  await expect(window.locator('[data-testid="theme-card-humanist-light"]')).toHaveAttribute('aria-pressed', 'true');

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'humanist-light');
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.getByRole('searchbox', { name: 'Search themes' }).fill('github');
  await expect(window.locator('[data-testid^="theme-card-github-"]')).toHaveCount(2);
  await expect(window.locator('[data-testid^="theme-card-humanist-"]')).toHaveCount(0);
});

test('persists the selected theme and mode through app settings', async () => {
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="theme-card-anthropic-dark"]').click();
  await window.getByRole('button', { name: 'System' }).click();
  await window.waitForTimeout(300);
  const appearance = await window.evaluate(() => window.praxis.settings.get().then(settings => settings.appearance));
  expect(appearance.themeId).toBe('anthropic-dark');
  expect(appearance.themeMode).toBe('system');
  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', /anthropic-(light|dark)/);
});

test('startup splash inherits the saved app theme', async () => {
  // launchTestApp already dismissed the first splash; the reload below brings a
  // fresh one back, which is the one these colour assertions read.
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="theme-card-humanist-light"]').click();
  await window.reload();

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'humanist-light');
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
    return {
      themeBackground: resolveColor(root.getPropertyValue('--bg').trim()),
      themeElevated: resolveColor(root.getPropertyValue('--bg-elevated').trim()),
      themeText: resolveColor(root.getPropertyValue('--text').trim()),
      themeAccent: resolveColor(root.getPropertyValue('--accent').trim()),
      splashBackground: getComputedStyle(splash).backgroundImage,
      trail: getComputedStyle(trail).stroke,
      dot: getComputedStyle(dot).stopColor
    };
  });

  expect(colors.splashBackground).toContain(colors.themeBackground);
  expect(colors.splashBackground).toContain(colors.themeElevated);
  expect(colors.trail).toBe(colors.themeText);
  expect(colors.dot).toBe(colors.themeAccent);
});

test('installs a marketplace theme and makes it available on reload', async () => {
  await window.locator('[data-testid="titlebar-themes"]').click();
  const marketplace = window.locator('[data-testid="theme-card-dracula-dark"]');
  await expect(marketplace).toHaveAttribute('aria-label', /available in marketplace/);
  await marketplace.click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dracula-dark');
  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dracula-dark');
});

test('creates a custom theme with editable colors and persists it', async () => {
  await window.locator('[data-testid="titlebar-themes"]').click();
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
  await expect(window.getByLabel('Highest gradient direction')).toHaveValue('to bottom');

  // Solid priorities get a single picker and no direction control.
  await expect(window.getByLabel('Lowest priority color')).toHaveValue('#22c55e');
  await expect(window.getByLabel('Lowest gradient direction')).toHaveCount(0);
});

test('terminal settings expose detected profiles and persist appearance preferences', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-terminal"]').click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.locator('.settings-section-title')).toHaveText('Terminal');
  await expect(dialog.getByLabel('Terminal default profile').locator('option')).not.toHaveCount(0);
  await dialog.getByLabel('Terminal font size').fill('16');
  await dialog.getByLabel('Terminal cursor style').selectOption('underline');
  await dialog.getByRole('switch', { name: 'Copy on selection' }).click();
  await window.waitForTimeout(500);

  await window.reload();
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-terminal"]').click();
  await expect(window.getByLabel('Terminal font size')).toHaveValue('16');
  await expect(window.getByLabel('Terminal cursor style')).toHaveValue('underline');
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

  await window.getByLabel('Critical gradient direction').selectOption('to right');
  await window.waitForTimeout(300);

  await window.reload();
  await openAppearance();
  await expect(window.getByLabel('Critical gradient direction')).toHaveValue('to right');
  await expect(window.getByLabel('Critical gradient start color')).toHaveValue('#dc2626');

  // Back to solid: the first stop becomes the solid color.
  await criticalRow.getByRole('button', { name: 'Solid' }).click();
  await expect(window.getByLabel('Critical priority color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient start color')).toHaveCount(0);
});
