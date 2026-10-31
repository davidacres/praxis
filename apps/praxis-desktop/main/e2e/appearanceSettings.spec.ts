import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockAddonRegistry } from './mockAddonRegistry';
import { chooseOption, chipOptionValues } from './chipSelect';
import { startMockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

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
  await expect(window.locator('.settings-section-title')).toHaveText('Appearance');
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
  await expect(window.locator('[data-testid^="theme-card-"]')).toHaveCount(5);
  await expect(window.locator('[data-testid="theme-card-praxis-light"]')).toHaveAttribute('aria-pressed', 'true');
  // This snapshot owns the gallery; shell/navigation have their own regression guards.
  await expect(window.locator('.settings-content')).toHaveScreenshot('theme-gallery-content.png');

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
    // Hold installation open so visibility alone cannot masquerade as readiness.
    await app.electronApp.evaluate((_electron, modulePath) => {
      const require = process.getBuiltinModule('module')!.createRequire(modulePath);
      const marketplace = require(modulePath);
      const build = marketplace.buildMarketplaceService;
      marketplace.buildMarketplaceService = async () => {
        const service = await build();
        const install = service.install.bind(service);
        service.install = async (...args: unknown[]) => {
          await new Promise(resolve => setTimeout(resolve, 600));
          return install(...args);
        };
        return service;
      };
    }, require.resolve('../out/main/marketplaceInstance'));

    await window.locator('[data-testid="titlebar-settings"]').click();
    await window.locator('[data-testid="settings-nav-appearance-themes"]').click();

    const marketplace = window.locator('[data-testid="theme-marketplace"]');
    await expect(marketplace).toBeVisible();
    const card = marketplace.locator('[data-testid="theme-card-dracula-dark"]');
    await expect(card).toHaveAttribute('aria-label', /available in marketplace/);
    await card.click();
    // The marketplace itself is a gallery section and remains visible while installing.
    // Select the installed gallery card only after that separate card exists.
    const galleryCard = window.locator('.theme-gallery-section:not(.theme-marketplace-section) [data-testid="theme-card-dracula-dark"]').first();
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
  await editor.getByLabel('Session chat background hex').fill('#123456');
  await editor.getByLabel('Session chat background image').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(editor.getByRole('alert')).toHaveText('Choose a valid image file.');
  const imageData = await window.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 800, 500);
    gradient.addColorStop(0, '#123456'); gradient.addColorStop(1, '#396359');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 800, 500);
    ctx.fillStyle = '#ffffff18';
    for (let x = 0; x < 800; x += 100) { ctx.beginPath(); ctx.arc(x, 250, 140, 0, Math.PI * 2); ctx.fill(); }
    return canvas.toDataURL('image/png');
  });
  await editor.getByLabel('Session chat background image').setInputFiles({ name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from(imageData.split(',')[1]!, 'base64') });
  await expect(editor.getByAltText('Session chat background preview')).toBeVisible();
  await expect(editor.getByRole('alert')).toHaveCount(0);

  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await editor.screenshot({ path: path.join(artifacts, 'session-chat-background-editor.png') });
  await editor.getByRole('button', { name: 'Save theme' }).click();
  const custom = await window.evaluate(() => window.praxis.settings.get().then(settings => settings.appearance.customThemes.at(-1)));
  expect(custom?.name).toBe('Ocean Custom');
  expect(custom?.preview.chatBackground).toBe('#123456');
  expect(custom?.preview.chatBackgroundImage).toBe(imageData);
  await expect(window.locator('html')).toHaveAttribute('data-theme', custom!.id);
  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-theme', custom!.id);
  expect(await window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--session-chat-bg').trim())).toBe('#123456');
  const mock = await startMockGatewayServer({ mode: 'complete' });
  await closeTestApp(app);
  app = await launchTestApp({ appearance: { ...DEFAULT_APP_SETTINGS.appearance, customThemes: [custom!], installedThemeIds: [custom!.id], themeId: custom!.id } }, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl
  });
  window = app.window;
  try {
    const session = await window.evaluate(() => window.praxis.ai.delegate({
      provider: 'vercel-gateway', task: { goal: 'Show the custom chat background.' }, toolMode: 'read-only'
    }));
    await openSession(window, session.issueKey);
    const chatPane = window.locator('.agent-details-page');
    await expect(chatPane).toHaveCSS('background-color', 'rgb(18, 52, 86)');
    await expect(chatPane).toHaveCSS('background-image', `url("${imageData}")`);
    await expect(window.locator('.session-chat-scroll')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(window.locator('.session-chat-scroll')).toHaveCSS('background-image', 'none');
    const paneBounds = await chatPane.boundingBox();
    const threadBounds = await window.locator('.session-chat-scroll').boundingBox();
    expect(paneBounds!.height).toBeGreaterThan(threadBounds!.height + 200);
    // Prove the guard rejects moving the image back onto the message block.
    const disabledImage = await window.addStyleTag({ content: '.agent-details-page { background-image: none !important; }' });
    await expect(expect(chatPane).toHaveCSS('background-image', `url("${imageData}")`, { timeout: 200 })).rejects.toThrow();
    await disabledImage.evaluate(element => element.remove());
    expect(await chatPane.evaluate(async element => { const image = new Image(); image.src = getComputedStyle(element).backgroundImage.slice(5, -2); await image.decode(); return image.naturalWidth; })).toBe(800);
    await window.locator('.pane-main').screenshot({ path: path.join(artifacts, 'session-chat-background.png') });
    await window.locator('[data-testid="titlebar-settings"]').click();
    await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
    await window.getByTestId(`theme-card-${custom!.id}`).dblclick();
    const savedEditor = window.getByRole('region', { name: 'Custom theme editor' });
    await savedEditor.getByRole('button', { name: 'Remove image' }).click();
    await expect(savedEditor.getByAltText('Session chat background preview')).toHaveCount(0);
    await savedEditor.getByRole('button', { name: 'Use surface background' }).click();
    await expect(savedEditor.getByLabel('Session chat background hex')).toHaveValue('');
    await savedEditor.getByRole('button', { name: 'Save theme' }).click();
    expect(await window.locator('html').evaluate(el => el.style.getPropertyValue('--session-chat-bg'))).toBe('');
    expect(await window.locator('html').evaluate(el => el.style.getPropertyValue('--session-chat-image'))).toBe('');
  } finally {
    await mock.close();
  }

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
