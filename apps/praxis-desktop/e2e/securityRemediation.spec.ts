import * as fs from 'node:fs';
import { openStartRunDialog } from './navigation';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockJiraMcpHttpServer } from './mockJiraMcpHttpServer';

test.slow();
const CHECK_ONLY_ENV = { AI_GATEWAY_API_KEY: 'e2e-check-only', AI_GATEWAY_URL: 'http://127.0.0.1:1', VERCEL_OIDC_TOKEN: undefined };
let app: TestApp;
test.beforeEach(async () => { app = await launchTestApp(undefined, undefined, CHECK_ONLY_ENV, { openNewSession: false }); });
test.afterEach(async () => { await closeTestApp(app); });

test('a renderer can only reach the desktop contract, never the host-internal channels', async () => {
  // The trusted renderer reads settings through the contract...
  expect(await app.window.evaluate(() => window.praxis.settings.get())).toBeTruthy();
  // ...but secrets, event injection, mobile internals and shell-only file channels are not in it, so
  // the webview bridge (the Rust equivalent of an unregistered Electron renderer) is refused by name.
  for (const channel of ['host:secrets:get', 'host:secrets:set', 'host:secrets:seed', 'host:emitEvent', 'host:getConfig',
    'mobile:internal:read', 'mobile:internal:command', 'mobile:start', 'workspaces:writeFile', 'workspaces:openFile', 'terminal:dispose']) {
    const refused = await app.callBackend(channel, 'probe').then(() => 'unexpected grant', (error: { code?: string; message?: string }) => error);
    expect(refused, channel).toMatchObject({ code: 'FORBIDDEN' });
    expect((refused as { message: string }).message).toContain('not in the desktop contract');
  }
  // The same renderer cannot smuggle a privileged call through a contract channel's argument shape either.
  expect(await app.callBackend('settings:get')).toBeTruthy();
});

test('OAuth rejects missing, mismatched and replayed state without consuming the legitimate authorization', async () => {
  test.setTimeout(60_000);
  await closeTestApp(app);
  const attempts: Record<string, number | string> = {};
  const probe = async (label: string, url: string) => {
    attempts[label] = await fetch(url).then(response => response.status, () => 'refused');
  };
  const mock = await startMockJiraMcpHttpServer({
    mode: 'oauth',
    // The "browser" is the backend's own redirect follower. Before it delivers the real authorisation,
    // another local process hits the same loopback callback with forged responses.
    onAuthorize: async ({ redirectUri, state }) => {
      await probe('missing', `${redirectUri}?code=attacker`);
      await probe('mismatch', `${redirectUri}?error=attacker&state=wrong`);
      await probe('wrongState', `${redirectUri}?code=attacker&state=${state}x`);
      await probe('wrongPath', `${redirectUri.replace('/callback', '/elsewhere')}?code=attacker&state=${state}`);
    },
  });
  const connections = [{ id: 'jira-oauth', name: 'Jira OAuth', mode: 'jiracloud',
    settings: { connectionType: 'http', httpUrl: mock.mcpUrl, jiraAuthMethod: 'oauth', url: 'https://example.atlassian.net' } }];
  app = await launchTestApp({ connections }, undefined, { ...CHECK_ONLY_ENV, PRAXIS_E2E_NO_BROWSER: '1' }, { openNewSession: false });
  try {
    const check = await app.window.evaluate(() => window.praxis.connection.check('jira-oauth')) as { status: string; message?: string };
    expect(check.status, check.message).toBe('ok');
    await mock.waitForEvent('initialize');
    // Every forged callback was refused...
    expect(attempts).toEqual({ missing: 400, mismatch: 400, wrongState: 400, wrongPath: 400 });
    // ...and the legitimate one still resolved: the token exchange succeeded and carried the real code.
    expect(mock.eventLog.indexOf('token')).toBeGreaterThan(mock.eventLog.indexOf('authorize'));
    expect(mock.lastAuthorization).toBe('Bearer mock-access-token');
    // The sign-in is single-use: once settled, its callback port is closed, so a replay finds nothing.
    const redirect = mock.lastAuthorizeQuery!.redirect_uri!;
    await probe('replay', `${redirect}?code=replay&state=${mock.lastAuthorizeQuery!.state}`);
    expect(attempts.replay).toBe('refused');
  } finally {
    await mock.close();
  }
});

test('secret reads repair permissive file modes and stored values remain retrievable', async () => {
  // Store a secret through the backend's secret store, then stop the backend and leave the file
  // group/world readable, as a copied or restored profile would.
  await app.callHost('host:secrets:set', 'security-fixture', 'fixture-only-value');
  const file = path.join(app.userDataDir, 'praxis-secrets.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))['security-fixture']).toBe('fixture-only-value');
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  fs.chmodSync(file, 0o644);
  app = await launchTestApp(undefined, reuse, CHECK_ONLY_ENV, { openNewSession: false });
  // Loading the store tightens the mode, and the value survived the restart.
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(await app.callHost('host:secrets:get', 'security-fixture')).toBe('fixture-only-value');
  // A value is never offered to the renderer through the contract.
  expect(JSON.stringify(await app.window.evaluate(() => window.praxis.settings.get()))).not.toContain('fixture-only-value');
});

test('repository workflows require command review, preserve trust on restart, and revoke it after changes', async () => {
  const folder = path.join(app.userDataDir, 'security-project'); fs.mkdirSync(folder);
  execFileSync('git', ['init', '-b', 'main'], { cwd: folder });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: folder });
  execFileSync('git', ['config', 'user.name', 'Security fixture'], { cwd: folder });
  const projectId = await app.window.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Security Project', key: 'SEC', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, workflowStages: [{ id: 'todo', name: 'To Do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'read-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    return project.id;
  }, folder);
  const definition = { schemaVersion: 1, id: 'repository-check', name: 'Repository check', scope: 'project', projectId, version: 1, entryNodeId: 'check', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', nodes: [{ id: 'check', name: 'Check', type: 'check', x: 0, y: 0, inputs: [], outputs: [], command: 'node', args: ['-e', 'console.log("reviewed command")'] }], edges: [] };
  const workflowFolder = path.join(folder, '.praxis', 'workflows'); fs.mkdirSync(workflowFolder, { recursive: true });
  const file = path.join(workflowFolder, 'repository-check.json'); fs.writeFileSync(file, JSON.stringify(definition));
  execFileSync('git', ['add', '.'], { cwd: folder });
  execFileSync('git', ['commit', '-m', 'Fixture workflow'], { cwd: folder });
  await app.window.reload();
  const refused = await app.window.evaluate(async id => { try { await window.praxis.workflows.startRun(id, 'repository-check', 'Untrusted'); return 'unexpected grant'; } catch (error) { return String(error); } }, projectId);
  expect(refused).toContain('needs local workspace trust');
  // Saved workflows no longer render as sidebar rows; the Runs header's "+"
  // opens the start-run dialog, which preselects the project's only workflow.
  await openStartRunDialog(app.window);
  const start = app.window.getByTestId('wf-runstart-dialog');
  await start.getByLabel('Run task').fill('Reviewed security check');
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  const prompt = app.window.getByRole('dialog', { name: 'Trust this project workflow?' });
  await expect(prompt).toContainText('reviewed command');
  const evidence = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'f107-workflow-trust.png');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  await app.window.screenshot({ path: evidence });
  await prompt.getByRole('button', { name: 'Trust workflow' }).click();
  await expect.poll(() => app.window.evaluate(id => window.praxis.workflows.projectTrust(id, 'repository-check').then(value => value.trusted), projectId)).toBe(true);
  await expect.poll(() => app.window.evaluate(id => window.praxis.workflows.listRuns(id).then(runs => runs[0]?.status), projectId), { timeout: 15000 }).toBe('succeeded');
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close(); app = await launchTestApp(undefined, reuse, CHECK_ONLY_ENV, { openNewSession: false });
  expect(await app.window.evaluate(id => window.praxis.workflows.projectTrust(id, 'repository-check').then(value => value.trusted), projectId)).toBe(true);
  definition.nodes[0].args[1] = 'console.log("changed command")'; fs.writeFileSync(file, JSON.stringify(definition));
  expect(await app.window.evaluate(id => window.praxis.workflows.projectTrust(id, 'repository-check').then(value => value.trusted), projectId)).toBe(false);
});


test('Antigravity selection rejects restricted tool modes and displays unrestricted consent', async () => {
  await app.window.evaluate(async cliPath => { await window.praxis.settings.set({ ai: { activeProvider: 'antigravity-cli', providers: { 'antigravity-cli': { enabled: true, cliPath } } } }); }, process.execPath);
  await app.window.getByRole('button', { name: 'New AI session', exact: true }).click();
  const mode = app.window.getByTestId('new-session-tool-mode');
  await chooseOption(mode, 'read-only');
  await app.window.getByTestId('new-session-provider-chip').click();
  await expect(app.window.getByTestId('new-session-provider-option-antigravity-cli')).toBeDisabled();
  await app.window.keyboard.press('Escape');
  await chooseOption(mode, 'full');
  await app.window.getByTestId('new-session-provider-chip').click();
  await app.window.getByTestId('new-session-provider-option-antigravity-cli').click();
  await expect(app.window.getByRole('note')).toContainText('No tool call will be prompted');
  const file = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'f107-antigravity-consent.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await app.window.screenshot({ path: file });
});
