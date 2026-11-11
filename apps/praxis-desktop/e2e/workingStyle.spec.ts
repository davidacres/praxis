// SPDX-License-Identifier: MIT
//
// The working style every AI is asked to follow, and the clean-up of Praxis's
// retired runtime-pin add-ons. The fake ACP agent stands in for Codex and echoes
// the prompt it received, so the test sees exactly what the AI got.

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

async function echo(win: TestApp['window'], cwd: string): Promise<string> {
  const session = await win.evaluate(
    async ({ cwd }) =>
      window.praxis.ai.delegate({ provider: 'codex-cli', goal: 'ECHO_PROMPT', workingDirectory: cwd, toolMode: 'read-only', task: { goal: 'ECHO_PROMPT', maxSteps: 2, timeoutMs: 30000 } }),
    { cwd }
  );
  const transcript = () =>
    win.evaluate(key => window.praxis.ai.listSessions().then(list => JSON.stringify(list.find(item => item.issueKey === key) ?? {})), session.issueKey);
  await expect.poll(transcript, { timeout: 20000 }).toContain('PROMPT_ECHO:');
  // The full echo event, not a truncated summary of it.
  return (await transcript()).split('PROMPT_ECHO:').slice(1).reduce((longest, part) => (part.length > longest.length ? part : longest), '');
}

test('every AI gets the working style; your own wording replaces it, and it can be turned off', async () => {
  app = await launchTestApp({ ai: { providers: { 'codex-cli': { cliPath: FAKE_AGENT } } } });
  const win = app.window;
  const panel = win.getByTestId('settings-agent-runtime');

  let prompt = await echo(win, app.userDataDir);
  expect(prompt).toContain('## Working style');
  expect(prompt).toContain('Finish with a short summary');

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
  prompt = await echo(win, app.userDataDir);
  expect(prompt).toContain('HAIKU_MARK');
  expect(prompt).not.toContain('Finish with a short summary');

  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await win.getByTestId('agent-runtime-tab-instructions').click();
  await panel.getByTestId('working-style-toggle').click();
  await expect(panel.getByLabel('Working style', { exact: true })).toHaveCount(0);
  await win.getByRole('button', { name: 'Done' }).click();
  prompt = await echo(win, app.userDataDir);
  expect(prompt).not.toContain('## Working style');
  // Agents have no "Runs on" any more: which AI runs a stage is chosen on the stage.
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await expect(panel.getByTestId('agent-runs-on-praxis-implementer')).toHaveCount(0);
});

test('Praxis’s retired runtime-pin add-ons are removed and never shadow a built-in agent', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-e2e-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ai: { agentRuntimes: { 'praxis-implementer': 'codex-cli' } } }));
  const install = (id: string, packageName: string, enabled: boolean, agent: Record<string, unknown>) => {
    const dir = path.join(userDataDir, 'addons', 'agent', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agent));
    fs.writeFileSync(
      path.join(dir, '.praxis-addon.json'),
      JSON.stringify({ manifest: { schemaVersion: 1, kind: 'agent', id, name: agent.name }, packageName, version: '1.0.0', installedAt: '2026-09-22T00:00:00.000Z', enabled })
    );
  };
  install('codex-implementer', '@davidacres/praxis-addon-agent-codex-implementer', true, {
    schemaVersion: 1, id: 'codex-implementer', name: 'Codex Implementer', type: 'acp', entry: { command: 'codex-acp' }, replaces: 'praxis-implementer'
  });
  install('praxis-planner', '@davidacres/praxis-addon-agent-planner', false, {
    schemaVersion: 1, id: 'praxis-planner', name: 'Praxis Planner', type: 'acp', entry: { command: 'claude-agent-acp' }
  });
  // Someone else's add-on that reuses a built-in id stays installed but is not used over the built-in.
  install('praxis-reviewer', '@acme/praxis-addon-agent-reviewer', true, {
    schemaVersion: 1, id: 'praxis-reviewer', name: 'Acme Reviewer', type: 'acp', entry: { command: 'claude-agent-acp' }
  });

  app = await launchTestApp(undefined, { userDataDir, settingsPath });
  const agents = path.join(userDataDir, 'agents');
  await expect.poll(() => fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'codex-implementer')), { timeout: 15000 }).toBe(false);
  expect(fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'praxis-planner'))).toBe(false);
  expect(fs.existsSync(path.join(userDataDir, 'addons', 'agent', 'praxis-reviewer'))).toBe(true);
  for (const id of ['praxis-implementer', 'praxis-planner', 'praxis-reviewer']) {
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(agents, id, 'agent.json'), 'utf8')).type, { timeout: 15000 }).toBe('gateway');
    expect(fs.existsSync(path.join(agents, id, 'AGENT.md'))).toBe(true);
  }
  expect(fs.existsSync(path.join(agents, 'codex-implementer'))).toBe(false);
  const settings = await app.window.evaluate(() => window.praxis.settings.get());
  expect('agentRuntimes' in settings.ai).toBe(false);
});
