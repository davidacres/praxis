// SPDX-License-Identifier: MIT
//
// Choosing which AI runs an agent ("Runs on"), and the working style every AI
// is asked to follow. The fake ACP agent stands in for Codex and echoes the
// prompt it received, so the test sees exactly what the chosen runtime got.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

async function echoFromImplementer(win: TestApp['window'], cwd: string): Promise<string> {
  const session = await win.evaluate(
    async ({ cwd }) =>
      window.praxis.ai.delegate({
        goal: 'ECHO_PROMPT',
        workingDirectory: cwd,
        toolMode: 'read-only',
        profileId: 'praxis-implementer',
        hostId: 'praxis-implementer',
        task: { goal: 'ECHO_PROMPT', maxSteps: 2, timeoutMs: 30000 }
      }),
    { cwd }
  );
  const transcript = () =>
    win.evaluate(key => window.praxis.ai.listSessions().then(list => JSON.stringify(list.find(item => item.issueKey === key) ?? {})), session.issueKey);
  await expect.poll(transcript, { timeout: 20000 }).toContain('PROMPT_ECHO:');
  // The full echo event, not a truncated summary of it.
  const echoes = (await transcript()).split('PROMPT_ECHO:').slice(1);
  return echoes.reduce((longest, echo) => (echo.length > longest.length ? echo : longest), '');
}

test('an agent runs on the AI chosen for it, with its own instructions and the working style', async () => {
  app = await launchTestApp({ ai: { providers: { 'codex-cli': { cliPath: FAKE_AGENT } } } });
  const win = app.window;
  const panel = win.getByTestId('settings-agent-runtime');

  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  const runsOn = panel.getByTestId('agent-runs-on-praxis-implementer');
  await expect(runsOn).toHaveValue('');
  await expect(runsOn.locator('option')).toContainText(['Session’s runtime', 'Codex']);
  await runsOn.selectOption({ label: 'Codex' });
  await expect(runsOn).toHaveValue('codex-cli');
  await win.mouse.move(0, 0);
  await win.screenshot({ path: 'output/playwright/agent-runs-on.png' });
  await win.getByRole('button', { name: 'Done' }).click();

  // The session is on an API provider; the implementer still runs on Codex,
  // with its own brief and Praxis's working style.
  let echo = await echoFromImplementer(win, app.userDataDir);
  expect(echo).toContain('You are the Praxis implementation agent.');
  expect(echo).toContain('## Working style');
  expect(echo).toContain('Finish with a short summary');

  // Your own wording replaces Praxis's.
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await win.getByTestId('agent-runtime-tab-instructions').click();
  const habits = panel.getByLabel('Working style', { exact: true });
  await expect(habits).toHaveValue(/Finish with a short summary/);
  await habits.fill('- Always name the file you changed. HAIKU_MARK');
  await expect(panel.getByTestId('working-style-reset')).toBeVisible();
  await win.mouse.move(0, 0);
  await win.screenshot({ path: 'output/playwright/working-style.png' });
  await win.getByRole('button', { name: 'Done' }).click();
  echo = await echoFromImplementer(win, app.userDataDir);
  expect(echo).toContain('HAIKU_MARK');
  expect(echo).not.toContain('Finish with a short summary');

  // Off: no working style at all.
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await win.getByTestId('agent-runtime-tab-instructions').click();
  await panel.getByTestId('working-style-toggle').click();
  await expect(panel.getByLabel('Working style', { exact: true })).toHaveCount(0);

  // Back to the session's runtime.
  await win.getByTestId('agent-runtime-tab-agents').click();
  await runsOn.selectOption({ label: 'Session’s runtime' });
  await expect(runsOn).toHaveValue('');
  await win.getByRole('button', { name: 'Done' }).click();
  const host = await win.evaluate(() =>
    window.praxis.agentRuntime.list().then(snapshot => snapshot.runtimeHosts?.find(item => item.manifest.id === 'praxis-implementer'))
  );
  expect(host?.pinnedBy).toBeUndefined();
  expect(host?.manifest.type).toBe('gateway');
  const settings = await win.evaluate(() => window.praxis.settings.get());
  expect(settings.ai.agentRuntimes).toEqual({});
  expect(settings.ai.workingStyle.enabled).toBe(false);
});

test('Praxis’s retired runtime-pin add-ons become the "Runs on" setting', async () => {
  // Installed before the setting existed: an enabled Codex pin and a disabled
  // early package that reused the built-in planner's id.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-e2e-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  fs.writeFileSync(settingsPath, '{}');
  const install = (id: string, packageName: string, enabled: boolean, agent: Record<string, unknown>) => {
    const dir = path.join(userDataDir, 'addons', 'agent', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agent));
    fs.writeFileSync(
      path.join(dir, '.praxis-addon.json'),
      JSON.stringify({
        manifest: { schemaVersion: 1, kind: 'agent', id, name: agent.name, ...(agent.replaces ? { replaces: agent.replaces } : {}) },
        packageName,
        version: '1.0.0',
        installedAt: '2026-09-22T00:00:00.000Z',
        enabled
      })
    );
  };
  install('codex-implementer', '@davidacres/praxis-addon-agent-codex-implementer', true, {
    schemaVersion: 1, id: 'codex-implementer', name: 'Codex Implementer', type: 'acp', entry: { command: 'codex-acp' }, replaces: 'praxis-implementer'
  });
  install('praxis-planner', '@davidacres/praxis-addon-agent-planner', false, {
    schemaVersion: 1, id: 'praxis-planner', name: 'Praxis Planner', type: 'acp', entry: { command: 'claude-agent-acp' }
  });
  // A third party's pin is theirs to keep.
  install('acme-reviewer', '@acme/praxis-addon-agent-reviewer', true, {
    schemaVersion: 1, id: 'acme-reviewer', name: 'Acme Reviewer', type: 'acp', entry: { command: 'claude-agent-acp' }, replaces: 'praxis-reviewer'
  });

  app = await launchTestApp(undefined, { userDataDir, settingsPath });
  const win = app.window;
  await expect
    .poll(() => win.evaluate(() => window.praxis.settings.get().then(settings => settings.ai.agentRuntimes)), { timeout: 15000 })
    .toEqual({ 'praxis-implementer': 'codex-cli' });
  expect(fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'codex-implementer'))).toBe(false);
  expect(fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'praxis-planner'))).toBe(false);
  expect(fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'acme-reviewer'))).toBe(true);

  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await expect(win.getByTestId('agent-runs-on-praxis-implementer')).toHaveValue('codex-cli');
  await expect(win.getByTestId('agent-runtime-profile-praxis-reviewer')).toContainText('Runs on Claude Code — set by Acme Reviewer');
});
