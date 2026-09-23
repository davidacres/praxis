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

import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** A pin: runs a built-in agent on its own runtime (the marketplace "Claude Implementer" and the like). */
function implementerPin(id: string, name: string, runtime: string, command: string) {
  return {
    packageName: `praxis-addon-agent-${id}`,
    version: '1.0.0',
    manifest: {
      schemaVersion: 1,
      kind: 'agent',
      id,
      name,
      summary: `Always runs the built-in Praxis Implementer on ${runtime}, whatever runtime the session uses.`,
      replaces: 'praxis-implementer',
      display: { runtime },
      author: 'acme'
    },
    payload: {
      'agent.json': { schemaVersion: 1, id, name, type: 'acp', entry: { command }, activation: 'onDemand', replaces: 'praxis-implementer' }
    }
  };
}
const CLAUDE_IMPLEMENTER = implementerPin('claude-implementer', 'Claude Implementer', 'Claude Code', 'claude-agent-acp');
const CODEX_IMPLEMENTER = implementerPin('codex-implementer', 'Codex Implementer', 'Codex', 'codex-acp');

const DEVICE_SKILL = {
  packageName: 'praxis-addon-device-check',
  version: '1.0.1',
  manifest: {
    schemaVersion: 1,
    kind: 'skill',
    id: 'device-check',
    name: 'Device check',
    summary: 'Checks a phone is ready for automated tests.',
    author: 'acme'
  },
  payload: {
    'SKILL.md': '---\nname: device-check\ndescription: Checks a connected phone is ready for automated UI tests.\nversion: 1.0.1\n---\n\n# Device check\n'
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

test('Agent Runtime panel: installing an agent asks first, then it can be uninstalled', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [TIDY_AGENT] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('agent-runtime');

  const row = window.locator('[data-testid="agent-marketplace-tidy-bot"]');
  await expect(row).toContainText('Tidy Bot');
  await expect(row).toContainText('Keeps a working tree tidy between tasks.');
  await row.getByRole('button', { name: 'Install' }).click();

  // Installing is the trust decision, made in one themed confirmation.
  const dialog = window.getByRole('dialog', { name: 'Install Tidy Bot?' });
  await expect(dialog).toContainText('Install it only if you trust its author.');
  await dialog.getByRole('button', { name: 'Install' }).click();

  await expect(row).toContainText('Installed');
  await expect(row.getByRole('button', { name: 'Uninstall' })).toBeVisible();
  await expect(row.getByRole('button', { name: /Trust|Enable/ })).toHaveCount(0);
  // Move the pointer away so the snapshot records the resting state.
  await window.mouse.move(0, 0);
  await expect(window.locator('[data-testid="agent-runtime-marketplace"]')).toHaveScreenshot('agents-marketplace.png');

  await row.getByRole('button', { name: 'Uninstall' }).click();
  await window.getByRole('dialog', { name: 'Uninstall Tidy Bot?' }).getByRole('button', { name: 'Uninstall' }).click();
  await expect(row.getByRole('button', { name: 'Install' })).toBeVisible();
});

test('Agent Runtime panel: a marketplace skill installs after confirmation and agents can load it', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [DEVICE_SKILL] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, {
    PRAXIS_MARKETPLACE_TOKEN: 'e2e-token'
  });
  window = app.window;

  await openSettings();
  await nav('agent-runtime');
  await window.locator('[data-testid="agent-runtime-tab-skills"]').click();
  const skillsTab = window.locator('[data-testid="agent-runtime-tab-skills"]');
  await expect(skillsTab).toContainText('Skills (0)');

  const row = window.locator('[data-testid="skill-marketplace-device-check"]');
  await expect(row).toContainText('Device check');
  await expect(row).toContainText('Checks a phone is ready for automated tests.');
  await row.getByRole('button', { name: 'Install' }).click();
  const dialog = window.getByRole('dialog', { name: 'Install Device check?' });
  await expect(dialog).toContainText('any scripts it includes');
  await dialog.getByRole('button', { name: 'Install' }).click();

  // Listed once — in the marketplace, as installed — and discovered for agents.
  await expect(row).toContainText('Installed');
  await expect(skillsTab).toContainText('Skills (1)');
  await expect(window.locator('[data-testid="agent-runtime-skill-device-check"]')).toHaveCount(0);

  await row.getByRole('button', { name: 'Uninstall' }).click();
  await window.getByRole('dialog', { name: 'Uninstall Device check?' }).getByRole('button', { name: 'Uninstall' }).click();
  await expect(row.getByRole('button', { name: 'Install' })).toBeVisible();
  await expect(skillsTab).toContainText('Skills (0)');
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
  // The installed-item text can appear a tick before the surrounding list
  // settles from its own IPC-backed refresh, which otherwise still had a
  // pending re-render at the exact moment `toHaveScreenshot` fired.
  await window.waitForTimeout(300);
  // Filtering shrinks the page beneath the current scroll offset. Normalize
  // the scroll position so this remains a screenshot of the Installed view,
  // not whichever lower viewport Chromium happened to preserve.
  await window.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  await expect(window).toHaveScreenshot('marketplace-filter-installed-view.png');

  // Screenshot 3: Switch back to "All" view
  await marketplace.locator('[data-testid="theme-marketplace-filter-all"]').click();
  await window.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  await expect(window).toHaveScreenshot('marketplace-filter-back-to-all-view.png');
});

test('Marketplace loads real GitHub packages with token configured', async () => {
  // Hits the REAL GitHub API. Opt in with a read:packages token in
  // PRAXIS_E2E_MARKETPLACE_TOKEN; never commit a token to this file.
  const liveToken = process.env.PRAXIS_E2E_MARKETPLACE_TOKEN?.trim();
  test.skip(!liveToken, 'Set PRAXIS_E2E_MARKETPLACE_TOKEN to run against the live marketplace.');
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
    PRAXIS_MARKETPLACE_TOKEN: liveToken
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

test('Agent Runtime panel: a pin runs a built-in agent on its own runtime, one pin per agent', async () => {
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [CLAUDE_IMPLEMENTER, CODEX_IMPLEMENTER] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, { PRAXIS_MARKETPLACE_TOKEN: 'e2e-token' });
  window = app.window;
  const agentsDir = path.join(app.userDataDir, 'agents');

  await openSettings();
  await nav('agent-runtime');
  const builtIn = window.locator('[data-testid="agent-runtime-profile-praxis-implementer"]');
  const claude = window.locator('[data-testid="agent-marketplace-claude-implementer"]');
  const codex = window.locator('[data-testid="agent-marketplace-codex-implementer"]');
  await expect(claude).toContainText('Claude Code');
  await expect(claude).toContainText('Always runs the built-in Praxis Implementer on Claude Code');
  await expect(builtIn).not.toContainText('set by');

  // Installing says what changes: the built-in's instructions, on this runtime.
  await claude.getByRole('button', { name: 'Install' }).click();
  const installClaude = window.getByRole('dialog', { name: 'Install Claude Implementer?' });
  await expect(installClaude).toContainText('Praxis will run the built-in Praxis Implementer — its own instructions — on Claude Code');
  await installClaude.getByRole('button', { name: 'Install' }).click();
  await expect(claude).toContainText('Installed');
  // The built-in stays listed — it is still the agent — and says what runs it.
  await expect(builtIn).toContainText('Runs on Claude Code — set by Claude Implementer');
  await expect(window.locator('[data-testid="agent-runtime-profile-claude-implementer"]')).toHaveCount(0);

  // A second pin for the same agent replaces the first.
  await codex.getByRole('button', { name: 'Install' }).click();
  const installCodex = window.getByRole('dialog', { name: 'Install Codex Implementer?' });
  await expect(installCodex).toContainText('Claude Implementer will be uninstalled.');
  await installCodex.getByRole('button', { name: 'Install' }).click();
  await expect(codex).toContainText('Installed');
  await expect(claude.getByRole('button', { name: 'Install' })).toBeVisible();
  await expect(builtIn).toContainText('Runs on Codex — set by Codex Implementer');
  await window.mouse.move(0, 0);
  await window.screenshot({ path: 'output/playwright/agent-pins.png' });

  // The built-in's own folder is untouched; the pin lives beside it.
  const builtInManifest = JSON.parse(fs.readFileSync(path.join(agentsDir, 'praxis-implementer', 'agent.json'), 'utf8'));
  expect(builtInManifest.type).toBe('gateway');
  expect(fs.existsSync(path.join(agentsDir, 'praxis-implementer', 'AGENT.md'))).toBe(true);
  expect(fs.existsSync(path.join(agentsDir, 'claude-implementer'))).toBe(false);
  await window.getByRole('button', { name: 'Done' }).click();

  // A session with the built-in, on an API runtime, launches the pin's runtime
  // (Codex, honouring its configured CLI path) with the built-in's instructions.
  const fixture = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');
  const session = await window.evaluate(async ({ cliPath, cwd }) => {
    await window.praxis.settings.set({ ai: { providers: { 'codex-cli': { cliPath } } } });
    return window.praxis.ai.delegate({
      goal: 'ECHO_PROMPT',
      workingDirectory: cwd,
      toolMode: 'read-only',
      profileId: 'praxis-implementer',
      hostId: 'praxis-implementer',
      task: { goal: 'ECHO_PROMPT', maxSteps: 2, timeoutMs: 30000 }
    });
  }, { cliPath: fixture, cwd: app.userDataDir });
  const transcript = () => window.evaluate(key => window.praxis.ai.listSessions().then(list => JSON.stringify(list.find(item => item.issueKey === key) ?? {})), session.issueKey);
  await expect.poll(transcript, { timeout: 20000 }).toContain('PROMPT_ECHO:');
  expect(await transcript()).toContain('Hello from the fake ACP agent');
  // The echo is the prompt the pinned runtime received: the built-in's own brief.
  const echoes = (await transcript()).split('PROMPT_ECHO:').slice(1);
  expect(echoes.some(echo => echo.includes('You are the Praxis implementation agent.'))).toBe(true);

  // Uninstalling hands the built-in back to the session's runtime.
  await openSettings();
  await nav('agent-runtime');
  await codex.getByRole('button', { name: 'Uninstall' }).click();
  const uninstall = window.getByRole('dialog', { name: 'Uninstall Codex Implementer?' });
  await expect(uninstall).toContainText('The built-in Praxis Implementer goes back to running on the session’s runtime.');
  await uninstall.getByRole('button', { name: 'Uninstall' }).click();
  await expect(builtIn).not.toContainText('set by');
});

test('an early pin that reused the built-in agent’s id still pins it without overwriting the built-in', async () => {
  const legacy = {
    packageName: 'praxis-addon-agent-implementer',
    version: '1.0.0',
    manifest: { schemaVersion: 1, kind: 'agent', id: 'praxis-implementer', name: 'Praxis Implementer', summary: 'Implements a plan and commits the change. Runs on Claude Code via claude-agent-acp.', author: 'acme' },
    payload: { 'agent.json': { schemaVersion: 1, id: 'praxis-implementer', name: 'Praxis Implementer', type: 'acp', entry: { command: 'claude-agent-acp' }, activation: 'onDemand' } }
  };
  registry = await startMockAddonRegistry({ owner: OWNER, addons: [legacy, CLAUDE_IMPLEMENTER] });
  app = await launchTestApp(seeded(registry.baseUrl), undefined, { PRAXIS_MARKETPLACE_TOKEN: 'e2e-token' });
  window = app.window;
  const agentsDir = path.join(app.userDataDir, 'agents');

  await openSettings();
  await nav('agent-runtime');
  const row = window.locator('[data-testid="agent-marketplace-praxis-implementer"]');
  await expect(row).toContainText('Runs the built-in Praxis Implementer');
  await row.getByRole('button', { name: 'Install' }).click();
  await window.getByRole('dialog', { name: 'Install Praxis Implementer?' }).getByRole('button', { name: 'Install' }).click();
  await expect(row).toContainText('Installed');

  const builtIn = window.locator('[data-testid="agent-runtime-profile-praxis-implementer"]');
  await expect(builtIn).toContainText('Built-in');
  await expect(builtIn).toContainText('Runs on Claude Code — set by Praxis Implementer');
  expect(JSON.parse(fs.readFileSync(path.join(agentsDir, 'praxis-implementer', 'agent.json'), 'utf8')).type).toBe('gateway');
  expect(fs.existsSync(path.join(agentsDir, 'praxis-implementer', 'AGENT.md'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(agentsDir, 'praxis-implementer-addon', 'agent.json'), 'utf8')).replaces).toBe('praxis-implementer');

  // The new pin for the same agent takes over and removes the early one.
  const claude = window.locator('[data-testid="agent-marketplace-claude-implementer"]');
  await claude.getByRole('button', { name: 'Install' }).click();
  const dialog = window.getByRole('dialog', { name: 'Install Claude Implementer?' });
  await expect(dialog).toContainText('Praxis Implementer will be uninstalled.');
  await dialog.getByRole('button', { name: 'Install' }).click();
  await expect(builtIn).toContainText('Runs on Claude Code — set by Claude Implementer');
  await expect(row.getByRole('button', { name: 'Install' })).toBeVisible();
  expect(fs.existsSync(path.join(agentsDir, 'praxis-implementer-addon'))).toBe(false);
});
