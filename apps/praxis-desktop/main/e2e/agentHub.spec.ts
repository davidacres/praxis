import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-009 / FX-BF-010 / FX-BF-011 — the Agent Hub.
 *
 * Navigation is the sidebar tree under the Agents destination; the centre is the
 * catalog record; the shell's right pane is the runtime (lifecycle, activation,
 * sessions). Creation and import hang off the tree's `+` menu.
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
  await expect(page.getByTestId('agent-nav-item').first()).toBeVisible();
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

test('the sidebar tree lists the catalog and the centre shows the selected record', async () => {
  const page = app.window;
  await openAgents(page);

  // The tree groups by scope and marks trust / validity.
  const tree = page.getByRole('navigation', { name: 'Workspace' });
  await expect(tree.getByText('Global', { exact: true })).toBeVisible();
  await expect(tree.getByTestId('agent-nav-item')).toHaveCount(3);
  await expect(tree.getByTestId('skill-nav-item')).toHaveCount(1);

  // A valid agent's record is the centre pane; its runtime is the right pane.
  await tree.getByTestId('agent-nav-item').filter({ hasText: 'Praxis Reviewer' }).click();
  await expect(record(page).getByRole('heading', { name: 'Praxis Reviewer', level: 1 })).toBeVisible();
  await expect(record(page).getByText('praxis-reviewer', { exact: true })).toBeVisible();
  await expect(record(page).getByText('node review.js')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeEnabled();
  await expect(page).toHaveScreenshot('agent-hub-record.png');

  // An invalid manifest fails closed, with the reason in the record.
  await tree.getByTestId('agent-nav-item').filter({ hasText: 'Broken Agent' }).click();
  await expect(record(page).getByText(/Unsupported transport/)).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeDisabled();
  await expect(runtime(page).getByText(/Manifest is invalid/)).toBeVisible();

  // A skill record shows its package facts.
  await tree.getByTestId('skill-nav-item').click();
  await expect(record(page).getByRole('heading', { name: 'code-audit', level: 1 })).toBeVisible();
  await expect(record(page).getByText('Audits a diff for risky changes.')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: /^Activate/ })).toBeEnabled();
});

test('starting, restarting, and stopping a host moves its lifecycle state', async () => {
  const page = app.window;
  await openAgents(page);
  const tree = page.getByRole('navigation', { name: 'Workspace' });

  await tree.getByTestId('agent-nav-item').filter({ hasText: 'Live Agent' }).click();
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

  await tree.getByTestId('agent-nav-item').filter({ hasText: 'Live Agent' }).click();
  await expect(runtime(page).getByText(/code-audit \(\w+\)/)).toBeVisible();
  await runtime(page).getByRole('button', { name: 'Open a session' }).click();
  const context = page.getByTestId('new-session-agent-context');
  await expect(context).toContainText('live-agent');
  await expect(context).toContainText('code-audit');
});

test('the Create agent wizard writes a validated, discoverable manifest', async () => {
  const page = app.window;
  await openAgents(page);

  await page.getByTestId('nav-agents-new').click();
  await page.getByTestId('new-agent').click();
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

  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByTestId('agent-nav-item').filter({ hasText: 'Scaffolded Agent' })
  ).toBeVisible();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'agent.json'), 'utf8')
  );
  expect(manifest).toMatchObject({ schemaVersion: 1, id: 'scaffolded-agent', type: 'acp', entry: { command: 'node', args: ['index.js'] } });
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'index.js'))).toBe(true);
});

test('import validates a folder without executing it and rejects a bad manifest', async () => {
  const page = app.window;
  await openAgents(page);

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
  await page.getByTestId('nav-agents-new').click();
  await page.getByTestId('rescan-agents').click();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByTestId('agent-nav-item').filter({ hasText: 'Imported Agent' })
  ).toBeVisible();
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'imported-agent', 'agent.json'))).toBe(true);
});
