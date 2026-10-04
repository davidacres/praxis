import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/**
 * FX-BF-009 / FX-BF-010 / FX-BF-011 — the Agent Hub.
 *
 * The user-facing model is Agent + Provider + Model + Skills. Profile, skill
 * and launch-binding navigation lives in Settings -> Agent Runtime.
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

/** Refresh files seeded after launch so Agent Runtime sees the current catalog. */
async function refreshAgentCatalog(page: Page): Promise<void> {
  await page.evaluate(async () => window.praxis.agentRuntime.refresh());
  await page.reload();
}

type RuntimeTab = 'agents' | 'skills' | 'runtimes' | 'advanced';

/** Open Settings -> Agent Runtime (optionally on a tab; launch bindings live under Advanced). */
async function openAgentRuntimeSettings(page: Page, tab?: RuntimeTab): Promise<void> {
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-agent-runtime').click();
  if (tab) await showRuntimeTab(page, tab);
}

async function showRuntimeTab(page: Page, tab: RuntimeTab): Promise<void> {
  await page.getByTestId(`agent-runtime-tab-${tab}`).click();
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

test('Agent Runtime record buttons follow the app theme', async () => {
  const page = app.window;
  await refreshAgentCatalog(page);
  await openAgentRuntimeSettings(page);
  const panel = page.getByTestId('settings-agent-runtime');
  const artifactDir = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  // Compare painted styles to a standard app button, including hover. Removing
  // the base btn class fails on native background/border/radius (proven against
  // the original profile button), even though btn-compact still sizes it.
  for (const mode of ['light', 'dark'] as const) {
    await page.getByTestId('settings-nav-appearance-themes').click();
    await page.getByTestId(`theme-card-praxis-${mode}`).click();
    await page.getByRole('button', { name: mode === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', `praxis-${mode}`);
    await page.getByTestId('settings-nav-agent-runtime').click();
    for (const tab of ['agents', 'skills', 'advanced'] as const) {
      await showRuntimeTab(page, tab);
      const buttons = panel.locator('button.btn-compact');
      await expect(buttons.first()).toBeVisible();
      for (const button of await buttons.all()) {
        await panel.locator('.settings-section-title').hover();
        const styles = await button.evaluate(element => {
          const actual = getComputedStyle(element);
          const reference = getComputedStyle(document.querySelector('[data-testid="agent-runtime-refresh"]')!);
          return {
            actual: [actual.color, actual.backgroundColor, actual.borderTopColor, actual.borderTopStyle, actual.borderRadius],
            reference: [reference.color, reference.backgroundColor, reference.borderTopColor, reference.borderTopStyle, reference.borderRadius]
          };
        });
        expect(styles.actual).toEqual(styles.reference);
        await button.hover();
        const hoverBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor);
        await page.getByTestId('agent-runtime-refresh').hover();
        await expect(page.getByTestId('agent-runtime-refresh')).toHaveCSS('background-color', hoverBackground);
      }
      if (tab === 'agents') {
        await panel.screenshot({ path: path.join(artifactDir, `agent-runtime-buttons-${mode}.png`) });
      }
    }
  }
});

test('Agent Runtime lists profiles and skills and opens their Agent Hub records', async () => {
  const page = app.window;
  await refreshAgentCatalog(page);
  await openAgentRuntimeSettings(page);
  const panel = page.getByTestId('settings-agent-runtime');
  await expect(panel.getByTestId('agent-runtime-profile-praxis-reviewer')).toBeVisible();
  await panel.getByTestId('agent-runtime-profile-praxis-reviewer').getByRole('button', { name: 'Open' }).click();
  await expect(record(page).getByRole('heading', { name: 'Praxis Reviewer', level: 1 })).toBeVisible();
  await expect(record(page).getByText('praxis-reviewer', { exact: true })).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: 'Start host' })).toBeEnabled();

  await openAgentRuntimeSettings(page, 'skills');
  await panel.getByTestId('agent-runtime-skill-code-audit').getByRole('button', { name: 'Open' }).click();
  await expect(record(page).getByRole('heading', { name: 'Code Audit', level: 1 })).toBeVisible();
  await expect(record(page).getByText('code-audit', { exact: true })).toBeVisible();
  await expect(record(page).getByText('Audits a diff for risky changes.')).toBeVisible();
  await expect(runtime(page).getByRole('button', { name: /^Activate(?! with)/ })).toBeEnabled();
});

test('Agent Runtime settings separate AI runtimes from agent profiles, and manage standalone launch bindings', async () => {
  const page = app.window;
  // Refresh the shell catalog before Settings opens records from it; Settings'
  // own Refresh updates only the dialog's local view.
  await refreshAgentCatalog(page);
  await openAgentRuntimeSettings(page);

  const panel = page.getByTestId('settings-agent-runtime');
  await showRuntimeTab(page, 'runtimes');
  await expect(panel.getByTestId('agent-runtime-provider-claude-code-cli')).toContainText('Claude Code (local)');
  await expect(panel.getByTestId('agent-runtime-provider-codex-cli')).toContainText('OpenAI Codex (local)');

  await showRuntimeTab(page, 'agents');
  const reviewer = panel.getByTestId('agent-runtime-profile-praxis-reviewer');
  await expect(reviewer).toContainText('Praxis Reviewer');
  await expect(reviewer).toContainText('ACP launch binding');
  await expect(panel.getByTestId('agent-runtime-host-praxis-reviewer')).toHaveCount(0);

  await showRuntimeTab(page, 'advanced');

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
  await refreshAgentCatalog(page);
  await openAgentRuntimeSettings(page, 'advanced');
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
  await refreshAgentCatalog(page);
  await openAgentRuntimeSettings(page, 'skills');
  await page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-skill-code-audit').getByRole('button', { name: 'Open' }).click();
  await chooseOption(runtime(page).getByLabel('Activate with'), { label: 'Live Agent' });
  await runtime(page).getByRole('button', { name: /^Activate(?! with)/ }).click();
  await expect(runtime(page).getByText(/live-agent · \w+ mode/)).toBeVisible();

  // Live Agent has no profile, so its record is reached through Settings.
  await openAgentRuntimeSettings(page, 'advanced');
  await page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-live-agent').getByRole('button', { name: 'Manage' }).click();
  await expect(runtime(page).getByText(/code-audit \(\w+\)/)).toBeVisible();
  await runtime(page).getByRole('button', { name: 'Open a session' }).click();
  const context = page.getByTestId('new-session-agent-context');
  await expect(context).toContainText('live-agent');
  await expect(context).toContainText('code-audit');
});

test('the New launch binding wizard writes a validated, discoverable manifest', async () => {
  const page = app.window;
  await openAgentRuntimeSettings(page, 'advanced');
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

  // The new binding has no profile, so it belongs in Agent Runtime settings.
  await openAgentRuntimeSettings(page, 'advanced');
  await expect(page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-scaffolded-agent')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByTestId('nav-agents-toggle')).toHaveCount(0);
  await expect(page.getByTestId('nav-agents')).toHaveCount(0);

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
  await showRuntimeTab(page, 'advanced');
  await expect(
    page.getByTestId('settings-agent-runtime').getByTestId('agent-runtime-binding-imported-agent')
  ).toBeVisible();
  expect(fs.existsSync(path.join(app.userDataDir, 'agents', 'imported-agent', 'agent.json'))).toBe(true);
});
