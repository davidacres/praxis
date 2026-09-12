// SPDX-License-Identifier: MIT
//
// e2e spec for the add-on marketplace.
//
// The marketplace *config* (owner, token, endpoints) lives in Settings →
// Add-ons; browsing and installing happens in each kind's own panel — Themes,
// Surfaces, Agent Runtime. This spec drives all of it.
//
// `mockAddonRegistry.ts` serves both halves of the GitHub Packages surface
// (REST package listing + npm packument/tarball) from one in-process server,
// building real gzipped tarballs so the integrity check runs for real. The
// GitHub token is supplied via `PRAXIS_MARKETPLACE_TOKEN` because the e2e
// sandbox has no `safeStorage` keychain (same as github.spec.ts).

import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockAddonRegistry, type MockAddonRegistry } from './mockAddonRegistry';

let app: TestApp | undefined;
let registry: MockAddonRegistry | undefined;
let window: Page;

const OWNER = 'acme';

const NORD_THEME = {
  packageName: 'praxis-addon-nord',
  version: '1.0.0',
  manifest: {
    schemaVersion: 1,
    kind: 'theme',
    id: 'nord-aurora',
    name: 'Nord Aurora',
    summary: 'A cool, muted palette.',
    author: 'acme',
    display: {
      mode: 'dark',
      preview: {
        canvas: '#2e3440', panel: '#3b4252', raised: '#434c5e', border: '#4c566a',
        text: '#eceff4', muted: '#d8dee9', accent: '#88c0d0',
        success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a'
      }
    }
  },
  payload: {
    'theme.json': {
      id: 'nord-aurora',
      name: 'Nord Aurora',
      mode: 'dark',
      description: 'A cool, muted palette.',
      preview: {
        canvas: '#2e3440', panel: '#3b4252', raised: '#434c5e', border: '#4c566a',
        text: '#eceff4', muted: '#d8dee9', accent: '#88c0d0',
        success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a'
      }
    }
  }
};

const FADED_PACK = {
  packageName: 'praxis-addon-faded',
  version: '2.1.0',
  manifest: {
    schemaVersion: 1,
    kind: 'surface-pack',
    id: 'faded-linen',
    name: 'Faded Linen',
    summary: 'A soft woven material.',
    author: 'acme',
    display: { preview: { canvas: '#efe9dd', panel: '#e2d9c6', accent: '#8a7a52', text: '#33302a' } }
  },
  payload: {
    'pack.json': {
      id: 'faded-linen',
      name: 'Faded Linen',
      description: 'A soft woven material.',
      basePackId: 'parchment',
      tokens: { '--surface-texture-opacity': '0.5' }
    }
  }
};

const TIDY_AGENT = {
  packageName: 'praxis-addon-tidy',
  version: '0.4.0',
  manifest: {
    schemaVersion: 1,
    kind: 'agent',
    id: 'tidy-bot',
    name: 'Tidy Bot',
    summary: 'Keeps a working tree tidy between tasks.',
    author: 'acme'
  },
  payload: {
    'agent.json': {
      id: 'tidy-bot',
      name: 'Tidy Bot',
      type: 'acp',
      activation: 'manual',
      description: 'Keeps a working tree tidy between tasks.'
    }
  }
};

function seeded(registryBase: string): Record<string, unknown> {
  return {
    marketplace: {
      enabled: true,
      owner: OWNER,
      ownerType: 'user',
      packageNamePrefix: 'praxis-addon-',
      apiBaseUrl: registryBase,
      registryBaseUrl: registryBase,
      checkOnLaunch: false
    }
  };
}

const openSettings = () => window.locator('[data-testid="titlebar-settings"]').click();
const nav = (id: string) => window.locator(`[data-testid="settings-nav-${id}"]`).click();

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (registry) {
    await registry.close();
    registry = undefined;
  }
});

test('Add-ons panel holds only the central config and points at the per-kind panels', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [NORD_THEME] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('marketplace');
  await expect(window.locator('.settings-section-title')).toHaveText('Add-ons');

  await expect(window.locator('[data-testid="marketplace-owner"]')).toHaveValue(OWNER);
  await expect(window.locator('[data-testid="marketplace-status"]')).toContainText(
    'Browse and install add-ons from the Themes, Surfaces, and Agent Runtime panels'
  );
  // No catalogue or install controls live here any more.
  await expect(window.locator('[data-testid="marketplace-browse"]')).toHaveCount(0);
  await expect(window).toHaveScreenshot('addons-config.png');
});

test('Themes panel: the marketplace section installs a theme into the gallery, then removes it', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [NORD_THEME, FADED_PACK] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('appearance-themes');

  const marketplace = window.locator('[data-testid="theme-marketplace"]');
  await expect(marketplace).toBeVisible();
  // The uninstalled add-on renders as a real preview card, built from the
  // manifest's display hints.
  const available = marketplace.locator('[data-testid="theme-card-nord-aurora"]');
  await expect(available).toBeVisible();
  await marketplace.scrollIntoViewIfNeeded();
  await expect(window).toHaveScreenshot('themes-marketplace.png');

  await available.click(); // an uninstalled card's click is "install"
  // A marketplace card stays put once installed — it doesn't leave the
  // section — and now also renders as a selectable card in the gallery
  // (Recent/Staff picks), so the same id legitimately appears twice.
  await expect(marketplace.locator('[data-testid="theme-card-nord-aurora"]')).toBeVisible();
  await window.getByRole('searchbox', { name: 'Search themes' }).fill('nord');
  const gallery = window.locator('.theme-gallery-section').filter({ hasText: 'Recent' }).first();
  await expect(gallery.locator('[data-testid="theme-card-nord-aurora"]')).toBeVisible();

  // Switch to "Installed" filter to see the installed marketplace item
  await marketplace.locator('[data-testid="theme-marketplace-filter-installed"]').click();
  await expect(marketplace.locator('[data-testid="theme-marketplace-installed-item"]')).toContainText('Nord Aurora');

  await window.getByRole('searchbox', { name: 'Search themes' }).fill('');
  // Remove the installed marketplace item
  await marketplace
    .locator('[data-testid="theme-marketplace-installed-item"]')
    .getByRole('button', { name: 'Remove' })
    .click();
  // Removed from installed list; it also drops out of Recent/Staff picks
  // (those only show installed items), but stays in the marketplace's "All"
  // view — uninstalled again, not gone.
  await expect(marketplace.locator('[data-testid="theme-marketplace-installed-item"]')).toHaveCount(0);
  await marketplace.locator('[data-testid="theme-marketplace-filter-all"]').click();
  await expect(gallery.locator('[data-testid="theme-card-nord-aurora"]')).toHaveCount(0);
  await expect(marketplace.locator('[data-testid="theme-card-nord-aurora"]')).toBeVisible();
});

test('Surfaces panel: the marketplace section installs a pack, and it can be removed from the gallery', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [FADED_PACK] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('appearance-surfaces');

  const card = window.locator('[data-testid="surface-marketplace-faded-linen"]');
  await expect(card).toContainText('Faded Linen');
  await expect(window.locator('[data-testid="surface-section"]')).toHaveScreenshot('surfaces-marketplace.png');

  await card.getByRole('button', { name: 'Install' }).click();
  await expect(window.locator('[data-testid="surface-marketplace-faded-linen"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="surface-card-faded-linen"]')).toBeVisible();

  await window.locator('[data-testid="surface-remove-faded-linen"]').click();
  await expect(window.locator('[data-testid="surface-card-faded-linen"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="surface-marketplace-faded-linen"]')).toBeVisible();
});

test('Agent Runtime panel: an agent installs untrusted and only runs after trust is granted', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [TIDY_AGENT] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('agent-runtime');

  const catalogRow = window.locator('[data-testid="agent-marketplace-tidy-bot"]');
  await expect(catalogRow).toContainText('Tidy Bot');
  await catalogRow.getByRole('button', { name: 'Install (untrusted)' }).click();

  const installedRow = window.locator('[data-testid="agent-marketplace-installed-tidy-bot"]');
  await expect(installedRow).toContainText('installed but not trusted');
  await expect(window.locator('[data-testid="agent-runtime-marketplace"]')).toHaveScreenshot('agents-marketplace.png');

  await installedRow.getByRole('button', { name: 'Trust' }).click();
  await expect(installedRow).toContainText('trusted — runs like a global agent');
  await expect(installedRow.getByRole('button', { name: 'Revoke trust' })).toBeVisible();
});

test('an unconfigured marketplace is explained inside each panel', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [NORD_THEME] });
  app = await launchTestApp(
    {
      marketplace: {
        enabled: true,
        owner: OWNER,
        ownerType: 'user',
        packageNamePrefix: 'praxis-addon-',
        apiBaseUrl: registry.baseUrl,
        registryBaseUrl: registry.baseUrl,
        checkOnLaunch: false
      }
    },
    undefined,
    { PRAXIS_MARKETPLACE_TOKEN: undefined }
  );
  window = app.window;

  await openSettings();
  await nav('appearance-themes');
  await expect(window.locator('[data-testid="theme-marketplace"]')).toContainText(
    'Set up the add-on catalogue in Settings › Add-ons'
  );

  await nav('marketplace');
  await expect(window.locator('[data-testid="marketplace-status"]')).toContainText(
    'Set an owner, add a token, and enable the marketplace'
  );
});

test('Themes marketplace filter toggle shows All and Installed views with screenshots', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [NORD_THEME] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('appearance-themes');

  const marketplace = window.locator('[data-testid="theme-marketplace"]');
  await expect(marketplace).toBeVisible();

  // Screenshot 1: Marketplace "All" view with filter buttons and available themes
  await marketplace.scrollIntoViewIfNeeded();
  await expect(marketplace.locator('[data-testid="theme-marketplace-filter-all"]')).toBeVisible();
  await expect(marketplace.locator('[data-testid="theme-marketplace-filter-installed"]')).toBeVisible();
  await expect(window).toHaveScreenshot('marketplace-filter-all-view.png');

  // Install the theme
  await marketplace.locator('[data-testid="theme-card-nord-aurora"]').click();

  // Screenshot 2: Click installed filter to show only installed items
  await marketplace.locator('[data-testid="theme-marketplace-filter-installed"]').click();
  await expect(marketplace.locator('[data-testid="theme-marketplace-installed-item"]')).toContainText('Nord Aurora');
  await expect(window).toHaveScreenshot('marketplace-filter-installed-view.png');

  // Screenshot 3: Switch back to "All" view
  await marketplace.locator('[data-testid="theme-marketplace-filter-all"]').click();
  await expect(window).toHaveScreenshot('marketplace-filter-back-to-all-view.png');
});

test('Marketplace loads real GitHub packages with token configured', async () => {
  // Test with REAL GitHub API using real token
  app = await launchTestApp({
    marketplace: {
      enabled: true,
      owner: 'davidacres',
      ownerType: 'user',
      packageNamePrefix: 'praxis-addon-',
      apiBaseUrl: 'https://api.github.com',
      registryBaseUrl: 'https://npm.pkg.github.com',
      checkOnLaunch: false
    }
  }, undefined, {
    PRAXIS_MARKETPLACE_TOKEN: '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'
  });
  window = app.window;

  await openSettings();
  await nav('appearance-themes');

  const marketplace = window.locator('[data-testid="theme-marketplace"]');

  // Wait for marketplace to load from GitHub API
  await expect(marketplace.locator('[data-testid="theme-marketplace-filter-all"]')).toBeVisible({ timeout: 10000 });

  // Should show available items count from GitHub packages
  await expect(marketplace).toContainText('available', { timeout: 10000 });

  // Verify at least one theme card appears from the published packages
  const themeCards = marketplace.locator('[data-testid^="theme-card-"]');
  await expect(themeCards.first()).toBeVisible({ timeout: 10000 });
});

