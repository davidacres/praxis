import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-009 — the Agent Hub catalog.
 *
 * Seeds the throwaway user-data profile with a valid agent, an invalid agent,
 * and a skill, then drives the Agents sidebar route: the catalog groups by
 * scope, detail shows the manifest, and an invalid manifest fails closed.
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
  // A trusted agent whose host actually starts, for the lifecycle test.
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

test('lists discovered agents and skills by scope with fail-closed detail', async () => {
  const page = app.window;

  await page.getByTestId('nav-agents').click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();

  // Discovery ran before the seed for the profile's first list(); Refresh picks it up.
  await page.getByRole('button', { name: /Refresh/ }).click();

  const catalog = page.getByRole('navigation', { name: 'Agent catalog' });
  await expect(catalog.getByRole('heading', { name: 'Global' })).toBeVisible();
  const reviewerRow = catalog.getByRole('button', { name: /Praxis Reviewer/ });
  const brokenRow = catalog.getByRole('button', { name: /Broken Agent/ });
  await expect(reviewerRow).toBeVisible();
  await expect(brokenRow).toBeVisible();
  await expect(catalog.getByRole('button', { name: /code-audit/ })).toBeVisible();

  // The valid agent's detail shows the manifest and can be started.
  await reviewerRow.click();
  const detail = page.getByRole('region', { name: 'Details' });
  await expect(detail.getByRole('heading', { name: 'Praxis Reviewer' })).toBeVisible();
  await expect(detail.getByText('praxis-reviewer', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start host' })).toBeEnabled();
  await expect(page.getByRole('main')).toHaveScreenshot('agent-hub-detail.png');

  // The invalid agent fails closed: Start is disabled and the reason is shown.
  await brokenRow.click();
  await expect(detail.getByRole('heading', { name: 'Broken Agent' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start host' })).toBeDisabled();
  await expect(detail.getByText(/Manifest is invalid/)).toBeVisible();

  // The skill detail lists its triggers and offers activation against the agent.
  await catalog.getByRole('button', { name: /code-audit/ }).click();
  await expect(detail.getByRole('heading', { name: 'code-audit' })).toBeVisible();
  await expect(detail.getByText('Audits a diff for risky changes.')).toBeVisible();
  await expect(detail.getByRole('button', { name: /^Activate/ })).toBeEnabled();
});

test('starting, restarting, and stopping an agent host moves its lifecycle state', async () => {
  const page = app.window;
  await page.getByTestId('nav-agents').click();
  await page.getByRole('button', { name: /Refresh/ }).click();

  const catalog = page.getByRole('navigation', { name: 'Agent catalog' });
  const detail = page.getByRole('region', { name: 'Details' });
  await catalog.getByRole('button', { name: /Live Agent/ }).click();
  await expect(detail.getByText('stopped')).toBeVisible();

  await detail.getByRole('button', { name: 'Start host' }).click();
  await expect(detail.getByText(/running/)).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Restart host' })).toBeVisible();
  await expect(page.getByText(/1 running/)).toBeVisible();

  await detail.getByRole('button', { name: 'Restart host' }).click();
  await expect(detail.getByText(/running/)).toBeVisible();

  await detail.getByRole('button', { name: 'Stop host' }).click();
  await expect(detail.getByText('stopped')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start host' })).toBeVisible();
});

test('activating a skill and opening a session carries the agent context', async () => {
  const page = app.window;
  await page.getByTestId('nav-agents').click();
  await page.getByRole('button', { name: /Refresh/ }).click();

  const catalog = page.getByRole('navigation', { name: 'Agent catalog' });
  const detail = page.getByRole('region', { name: 'Details' });

  // Activate the skill against Live Agent; the negotiated mode is shown.
  await catalog.getByRole('button', { name: /code-audit/ }).click();
  await detail.getByLabel('Activate with').selectOption({ label: 'Live Agent' });
  await detail.getByRole('button', { name: 'Activate' }).click();
  await expect(detail.getByText(/live-agent · \w+ mode/)).toBeVisible();

  // The agent detail lists the active skill and can open an attributed session.
  await catalog.getByRole('button', { name: /Live Agent/ }).click();
  await expect(detail.getByText(/code-audit \(\w+\)/)).toBeVisible();
  await detail.getByRole('button', { name: 'Open a session' }).click();
  const context = page.getByTestId('new-session-agent-context');
  await expect(context).toContainText('live-agent');
  await expect(context).toContainText('code-audit');
});

test('the Create agent wizard writes a validated, discoverable manifest', async () => {
  const page = app.window;
  await page.getByTestId('nav-agents').click();

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByLabel('Display name').fill('Scaffolded Agent');
  await dialog.getByLabel('ID', { exact: true }).fill('Bad Id');
  await expect(dialog.getByText(/lowercase letters, digits/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create agent' })).toBeDisabled();

  await dialog.getByLabel('ID', { exact: true }).fill('scaffolded-agent');
  await dialog.getByLabel('Command').fill('node');
  await dialog.getByLabel('Arguments (space-separated)').fill('index.js');
  await expect(dialog).toHaveScreenshot('agent-hub-create-dialog.png');
  await dialog.getByRole('button', { name: 'Create agent' }).click();

  await expect(dialog).toBeHidden();
  const catalog = page.getByRole('navigation', { name: 'Agent catalog' });
  await expect(catalog.getByRole('button', { name: /Scaffolded Agent/ })).toBeVisible();

  const manifest = JSON.parse(
    fs.readFileSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'agent.json'), 'utf8')
  );
  expect(manifest).toMatchObject({ schemaVersion: 1, id: 'scaffolded-agent', type: 'acp', entry: { command: 'node', args: ['index.js'] } });
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'scaffolded-agent', 'index.js'))).toBe(true);
});

test('import validates a folder without executing it and rejects a bad manifest', async () => {
  const page = app.window;
  await page.getByTestId('nav-agents').click();

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
  await page.getByRole('button', { name: /Refresh/ }).click();
  await expect(page.getByRole('navigation', { name: 'Agent catalog' }).getByRole('button', { name: /Imported Agent/ })).toBeVisible();
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'imported-agent', 'agent.json'))).toBe(true);
});
