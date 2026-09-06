// SPDX-License-Identifier: MIT
//
// e2e spec for the add-on marketplace (Settings → Add-ons).
//
// `mockAddonRegistry.ts` serves both halves of the GitHub Packages surface the
// marketplace uses (REST package listing + npm packument/tarball) from one
// in-process server, and builds real gzipped tarballs so the integrity check
// runs for real. The marketplace GitHub token is supplied via
// `PRAXIS_MARKETPLACE_TOKEN` because the e2e sandbox has no keychain backend
// for `safeStorage` (same constraint as github.spec.ts).

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
    author: 'acme'
  },
  payload: {
    'theme.json': {
      id: 'nord-aurora',
      name: 'Nord Aurora',
      mode: 'dark',
      description: 'A cool, muted palette.',
      preview: {
        canvas: '#2e3440',
        panel: '#3b4252',
        raised: '#434c5e',
        border: '#4c566a',
        text: '#eceff4',
        muted: '#d8dee9',
        accent: '#88c0d0',
        success: '#a3be8c',
        warning: '#ebcb8b',
        danger: '#bf616a'
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
    author: 'acme'
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

function seededSettings(registryBase: string): Record<string, unknown> {
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

async function openAddons(): Promise<void> {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-marketplace"]').click();
  await expect(window.locator('.settings-section-title')).toHaveText('Add-ons');
}

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

test('browses the catalogue, installs a theme, and the theme joins the gallery', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [NORD_THEME, FADED_PACK] });
  app = await launchTestApp(seededSettings(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openAddons();
  await expect(window.locator('[data-testid="settings-marketplace"]')).toContainText(
    'Marketplace is configured and ready.'
  );

  await window.locator('[data-testid="marketplace-browse"]').click();
  await expect(window.locator('[data-testid="marketplace-catalog-nord-aurora"]')).toContainText('Nord Aurora');
  await expect(window.locator('[data-testid="marketplace-catalog-faded-linen"]')).toContainText('Faded Linen');

  await window
    .locator('[data-testid="marketplace-catalog-nord-aurora"]')
    .getByRole('button', { name: 'Install' })
    .click();

  const installed = window.locator('[data-testid="marketplace-installed-nord-aurora"]');
  await expect(installed).toContainText('Nord Aurora');
  await expect(installed).toContainText('Theme · v1.0.0');
  await expect(window).toHaveScreenshot('marketplace-installed.png');

  // Activation: the installed theme is now a real card in the gallery.
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.getByRole('searchbox', { name: 'Search themes' }).fill('nord');
  await expect(window.locator('[data-testid="theme-card-nord-aurora"]')).toBeVisible();

  // Remove it again — the card goes with it.
  await window.locator('[data-testid="settings-nav-marketplace"]').click();
  await installed.getByRole('button', { name: 'Remove' }).click();
  await expect(window.locator('[data-testid="marketplace-installed-nord-aurora"]')).toHaveCount(0);

  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.getByRole('searchbox', { name: 'Search themes' }).fill('nord');
  await expect(window.locator('[data-testid="theme-card-nord-aurora"]')).toHaveCount(0);
});

test('an unconfigured marketplace explains itself and cannot browse', async () => {
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

  await openAddons();
  await expect(window.locator('[data-testid="settings-marketplace"]')).toContainText(
    'Set an owner, add a token, and enable the marketplace'
  );
  await expect(window.locator('[data-testid="marketplace-browse"]')).toBeDisabled();
});
