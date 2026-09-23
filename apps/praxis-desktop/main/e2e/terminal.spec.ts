import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { chooseOption, chipOptionValues } from './chipSelect';

let app: TestApp;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
});

test('runs a real PTY and preserves it when the panel is closed', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.getByLabel('Toggle panel').click();
  const terminal = win.getByTestId('integrated-terminal');
  await expect(terminal).toBeVisible();
  const liveSession = await win.evaluate(async () => (await window.praxis.terminal.list()).find(session => !session.exited)?.id);
  if (liveSession) await chooseOption(win.getByLabel('Active terminal'), liveSession);

  await win.waitForTimeout(400);
  await terminal.locator('.xterm-screen').click();
  await win.keyboard.type("printf 'TM_PTY_OK\\n'");
  await win.keyboard.press('Enter');
  const currentContext = async () => win.evaluate(async sessionId =>
    (await window.praxis.terminal.getContext(sessionId)).output, liveSession);
  await expect.poll(currentContext).toContain('TM_PTY_OK');
  await win.keyboard.type('printf "\\033[31mRED\\033[0m \\033[38;2;255;100;0mTRUECOLOR\\033[0m [$TERM/$COLORTERM]\\n"');
  await win.keyboard.press('Enter');
  await expect.poll(currentContext).toContain('RED TRUECOLOR [xterm-256color/truecolor]');

  const context = await win.evaluate(async sessionId => window.praxis.terminal.getContext(sessionId), liveSession);
  expect(context.output).toContain('TM_PTY_OK');

  await win.getByLabel('Close panel').click();
  await win.getByLabel('Toggle panel').click();
  await expect(win.getByTestId('integrated-terminal')).toBeVisible();
  await expect.poll(currentContext).toContain('TM_PTY_OK');
});

test('captures shell-integrated command records and exposes failed-command actions', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.getByLabel('Toggle panel').click();
  const liveSession = await win.evaluate(async () => (await window.praxis.terminal.list()).find(session => !session.exited)?.id);
  if (liveSession) await chooseOption(win.getByLabel('Active terminal'), liveSession);
  const terminal = win.getByTestId('integrated-terminal');
  await win.waitForTimeout(400);
  await terminal.locator('.xterm-screen').click();
  await win.keyboard.type("printf 'TM_COMMAND_RECORD\\n'; false");
  await win.keyboard.press('Enter');
  const command = async () => win.evaluate(async sessionId => {
    const commands = await window.praxis.terminal.listCommands(sessionId);
    return commands.at(-1);
  }, liveSession);
  await expect.poll(command, { timeout: 8_000 }).toMatchObject({ status: 'failed', exitCode: 1 });
  await expect(win.getByTestId('terminal-command-failure')).toBeVisible();
});

test('creates and kills terminal sessions from the panel toolbar', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.getByLabel('Toggle panel').click();
  await win.waitForTimeout(500);
  const before = (await chipOptionValues(win.getByLabel('Active terminal'))).length;
  await win.getByLabel('New terminal').click();
  await expect.poll(async () => (await chipOptionValues(win.getByLabel('Active terminal'))).length).toBe(before + 1);
  await win.getByLabel('Kill terminal').click();
  await expect.poll(async () => (await chipOptionValues(win.getByLabel('Active terminal'))).length).toBe(before);
});

test('opens per-terminal settings and applies an active-session override', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.getByLabel('Toggle panel').click();
  await win.getByLabel('Terminal session settings').click();
  const settings = win.getByTestId('terminal-session-settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByText(/zsh|bash|PowerShell/).first()).toBeVisible();
  await settings.getByLabel('Session font size').fill('17');
  await chooseOption(settings.getByLabel('Session cursor style'), 'underline');
  await expect(settings.getByLabel('Session font size')).toHaveValue('17');
  await expect(settings.getByLabel('Session cursor style')).toHaveAttribute('data-value', 'underline');
  await settings.getByRole('button', { name: 'Reset to global defaults' }).click();
  await expect(settings.getByLabel('Session font size')).toHaveValue('13');
});

test('detects installed shell profiles and launches a selected profile', async () => {
  app = await launchTestApp();
  const win = app.window;
  const profiles = await win.evaluate(() => window.praxis.terminal.listProfiles());
  expect(profiles.some(profile => profile.name === 'zsh')).toBe(process.platform === 'darwin');
  if (process.platform === 'win32') {
    expect(profiles.some(profile => ['PowerShell', 'Command Prompt'].includes(profile.name))).toBe(true);
  } else {
    expect(profiles.some(profile => profile.name === 'bash')).toBe(true);
  }
  expect(profiles.filter(profile => profile.isDefault)).toHaveLength(1);

  await win.getByLabel('Toggle panel').click();
  await win.getByLabel('Launch terminal profile').click();
  await expect(win.getByTestId('terminal-profile-menu')).toBeVisible();
  const before = (await chipOptionValues(win.getByLabel('Active terminal'))).length;
  const selectedProfileId = process.platform === 'win32'
    ? profiles.find(profile => !profile.isDefault)?.id ?? profiles[0].id
    : 'bash';
  await win.getByTestId(`terminal-profile-${selectedProfileId}`).click();
  await expect.poll(async () => (await chipOptionValues(win.getByLabel('Active terminal'))).length).toBe(before + 1);
  await expect(win.getByLabel('Active terminal')).toContainText(
    profiles.find(profile => profile.id === selectedProfileId)?.name ?? ''
  );
});
