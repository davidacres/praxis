import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-009 / FX-BF-010 / FX-BF-011 — the Agent Hub.
 *
 * The user-facing model is Agent + Provider + Model + Skills: the sidebar
 * tree and its `+` menu only ever show agent profiles and skills. A launch
 * binding (the `agent.json` process that actually runs a custom agent) is
 * advanced/diagnostic plumbing that lives in Settings -> Agent Runtime —
 * except the canonical binding for a bundled/seeded profile (same id), which
 * merges into that profile's row so its lifecycle stays reachable from the
 * primary record.
 */

test.slow();

let app: TestApp;

function seedAgent(userDataDir: string, id: string, manifest: Record<string, unknown>): void {
  const dir = path.join(userDataDir, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2));
}

function seedSkill(userDataDir: string, name: string, body: string): void {
  const dir = path.join(userDataDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

/** Open Agents and rescan, so the files seeded after launch are discovered. */
async function openAgents(page: Page): Promise<void> {
  await page.getByTestId('nav-agents').click();
  await page.getByTestId('nav-agents-new').click();
  await page.getByTestId('rescan-agents').click();
  await expect(page.getByTestId('profile-nav-item').first()).toBeVisible();
}

/** Open Settings -> Agent Runtime, where launch bindings are managed. */
async function openAgentRuntimeSettings(page: Page): Promise<void> {
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-agent-runtime').click();
}

const record = (page: Page) => page.getByRole('main');
const runtime = (page: Page) => page.getByRole('region', { name: 'Agent runtime' });

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  seedAgent(app.userDataDir, 'praxis-reviewer', {
    schemaVersion: 1,
    id: 'praxis-reviewer',
    name: 'Praxis Reviewer',
    type: 'acp',
    entry: { command: 'node', args: ['review.js'] },
    activation: 'onDemand'
  });
  seedAgent(app.userDataDir, 'broken-agent', {
    schemaVersion: 1,
    id: 'broken-agent',
    name: 'Broken Agent',
    type: 'telepathy',
    entry: 'run.js'
  });
  seedAgent(app.userDataDir, 'live-agent', {
    schemaVersion: 1,
    id: 'live-agent',
    name: 'Live Agent',
    type: 'acp',
    entry: { command: '/usr/bin/true', args: [] }
  });
  seedSkill(
    app.userDataDir,
    'code-audit',
    '---\nname: code-audit\ndescription: Audits a diff for risky changes.\ntriggers: review, audit\n---\nInstructions.'
  );
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('the sidebar tree lists agent profiles and skills only; a profile shows its record and bound runtime', async () => {
  const page = app.window;
  await openAgents(page);

  const tree = page.getByRole('navigation', { name: 'Workspace' });
  await expect(tree.getByText('Global', { exact: true })).toBeVisible();
  // Broken Agent and Live Agent are launch bindings with no profile, so they
  // stay out of primary nav (Settings -> Agent Runtime only). Seeded Praxis
  // Reviewer shares its id with a bundled profile, so it merges into that
  // one row rather than adding a second. 5 bundled profiles total.
  await expect(tree.getByTestId('profile-nav-item')).toHaveCount(5);
  await expect(tree.getByTestId('agent-nav-item')).toHaveCount(0);
  await expect(tree.getByTestId('skill-nav-item')).toHaveCount(1);

  // A profile's record is the centre pane; the launch binding it runs on is
  // the right pane's runtime — no separate binding row to pick.
  await tree.getByTestId('profile-nav-item').filter({ hasText: 'Praxis Reviewer' }).click();
  await expect(record(page).getByRole('heading', { name: 'Praxis Reviewer', level: 1 })).toBeVisible();
  await expect(record(page).getByText('praxis-reviewer', { exact: true })).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeEnabled();

  // A skill record shows its package facts.
  await tree.getByTestId('skill-nav-item').click();
  await expect(record(page).getByRole('heading', { name: 'code-audit', level: 1 })).toBeVisible();
  await expect(record(page).getByText('Audits a diff for risky changes.')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: /^Activate/ })).toBeEnabled();
});

test('Agent Runtime settings separate AI runtimes from agent profiles, and manage standalone launch bindings', async () => {
  const page = app.window;
  // Rescanning via the sidebar (openAgents) refreshes the catalog the rest
  // of the shell reads from — Settings' own Refresh only updates its local
  // view, not the sidebar/record pane "Manage" navigates into.
  await openAgents(page);
  await openAgentRuntimeSettings(page);

  const panel = page.getByTestId('settings-agent-runtime');
  await expect(panel.getByRole('heading', { name: 'AI runtimes' })).toBeVisible();
  await expect(panel.getByTestId('agent-runtime-provider-claude-code-cli')).toContainText('Claude Code (local)');
  await expect(panel.getByTestId('agent-runtime-provider-codex-cli')).toContainText('Codex CLI (local)');

  const reviewer = panel.getByTestId('agent-runtime-profile-praxis-reviewer');
  await expect(reviewer).toContainText('Praxis Reviewer');
  await expect(reviewer).toContainText('uses the runtime selected for the session');
  await expect(reviewer).toContainText('ACP launch binding');
  await expect(panel.getByTestId('agent-runtime-host-praxis-reviewer')).toHaveCount(0);

  // A standalone binding (no matching profile) lists its manifest problem
  // inline, and "Manage" opens its full record — the same invalid-manifest
  // record that used to be reachable straight from the sidebar.
  const broken = panel.getByTestId('agent-runtime-binding-broken-agent');
  await expect(broken).toContainText('launch binding');
  await expect(broken).toContainText(/Unsupported transport/);

  await broken.getByRole('button', { name: 'Manage' }).click();
  await expect(record(page).getByText(/Unsupported transport/)).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeDisabled();
  await expect(runtime(page).getByText(/Manifest is invalid/)).toBeVisible();
});

test('starting, restarting, and stopping a host moves its lifecycle state', async () => {
  const page = app.window;
  await openAgents(page);
  await openAgentRuntimeSettings(page);
  const panel = page.getByTestId('settings-agent-runtime');
  await panel.getByTestId('agent-runtime-binding-live-agent').getByRole('button', { name: 'Manage' }).click();

  await expect(runtime(page).getByText('Stopped')).toBeVisible();

  await runtime(page).getByRole('button', { name: 'Start host' }).click();
  await expect(runtime(page).getByText('Running')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Restart host' })).toBeVisible();

  await runtime(page).getByRole('button', { name: 'Restart host' }).click();
  await expect(runtime(page).getByText('Running')).toBeVisible();

  await runtime(page).getByRole('button', { name: 'Stop host' }).click();
  await expect(runtime(page).getByText('Stopped')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeVisible();
});

test('activating a skill and opening a session carries the agent context', async () => {
  const page = app.window;
  await openAgents(page);
  const tree = page.getByRole('navigation', { name: 'Workspace' });

  await tree.getByTestId('skill-nav-item').click();
  await runtime(page).getByLabel('Activate with').selectOption({ label: 'Live Agent' });
  await runtime(page).getByRole('button', { name: 'Activate' }).click();
  await expect(runtime(page).getByText(/live-agent · \w+ mode/)).toBeVisible();

  // Live Agent has no profile, so its record is reached through Settings.
  await openAgentRuntimeSettings(page);
  await page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-live-agent').getByRole('button', { name: 'Manage' }).click();
  await expect(runtime(page).getByText(/code-audit \(\w+\)/)).toBeVisible();
  await runtime(page).getByRole('button', { name: 'Open a session' }).click();
  const context = page.getByTestId('new-session-agent-context');
  await expect(context).toContainText('live-agent');
  await expect(context).toContainText('code-audit');
});

test('the New launch binding wizard writes a validated, discoverable manifest', async () => {
  const page = app.window;
  await openAgentRuntimeSettings(page);
  await page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-new-binding').click();

  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByLabel('Display name').fill('Scaffolded Agent');
  await dialog.getByLabel('ID', { exact: true }).fill('Bad Id');
  await expect(dialog.getByText(/lowercase letters, digits/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create agent' })).toBeDisabled();

  await dialog.getByLabel('ID', { exact: true }).fill('scaffolded-agent');
  await dialog.getByLabel('Command').fill('node');
  await dialog.getByLabel('Arguments (space-separated)').fill('index.js');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(dialog).toBeHidden();

  // The new binding has no profile, so it belongs in Settings, not the
  // primary sidebar tree.
  await openAgentRuntimeSettings(page);
  await expect(page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-scaffolded-agent')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await openAgents(page);
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByTestId('profile-nav-item').filter({ hasText: 'Scaffolded Agent' })
  ).toHaveCount(0);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'agent.json'), 'utf8')
  );
  expect(manifest).toMatchObject({ schemaVersion: 1, id: 'scaffolded-agent', type: 'acp', entry: { command: 'node', args: ['index.js'] } });
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'index.js'))).toBe(true);
});

test('import validates a folder without executing it and rejects a bad manifest', async () => {
  const page = app.window;
  await openAgentRuntimeSettings(page);

  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-good-'));
  fs.writeFileSync(
    path.join(good, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id: 'imported-agent', name: 'Imported Agent', type: 'acp', entry: 'run.js' })
  );
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-bad-'));
  fs.writeFileSync(path.join(bad, 'agent.json'), JSON.stringify({ schemaVersion: 1, id: 'x', name: 'X', type: 'telepathy', entry: 'run.js' }));

  const badPreview = await page.evaluate(dir => window.praxis.agentRuntime.previewImport('agent', dir, 'global'), bad);
  expect(badPreview.errors.length).toBeGreaterThan(0);
  await expect(
    page.evaluate(dir => window.praxis.agentRuntime.importItem('agent', dir, 'global', 'block'), bad)
  ).rejects.toThrow();

  await page.evaluate(dir => window.praxis.agentRuntime.importItem('agent', dir, 'global', 'block'), good);
  // Settings is already open from the top of the test — re-clicking the
  // titlebar toggle here would close it instead.
  await page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-refresh').click();
  await expect(
    page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-imported-agent')
  ).toBeVisible();
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'imported-agent', 'agent.json'))).toBe(true);
});
