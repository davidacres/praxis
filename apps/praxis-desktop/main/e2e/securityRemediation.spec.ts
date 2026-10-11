import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

test.slow();
const CHECK_ONLY_ENV = { AI_GATEWAY_API_KEY: 'e2e-check-only', AI_GATEWAY_URL: 'http://127.0.0.1:1', VERCEL_OIDC_TOKEN: undefined };
let app: TestApp;
test.beforeEach(async () => { app = await launchTestApp(undefined, undefined, CHECK_ONLY_ENV, { openNewSession: false }); });
test.afterEach(async () => { await closeTestApp(app); });

test('unregistered renderers cannot read settings or emit privileged one-way messages', async () => {
  expect(await app.window.evaluate(() => window.praxis.settings.get())).toBeTruthy();
  const result = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    try {
      await win.loadURL('data:text/html,<html>untrusted</html>');
      return await win.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('settings:get').then(()=>'unexpected grant',error=>error.message)`);
    } finally { win.destroy(); }
  });
  expect(result).toContain('not a trusted application renderer');
});

test('OAuth rejects missing, mismatched and replayed state without consuming the legitimate authorization', async () => {
  const result = await app.electronApp.evaluate(async () => {
    const require = process.getBuiltinModule('module')!.createRequire(process.cwd() + '/out/main/index.js');
    const { DesktopMcpOAuthManager } = require(pathForMain('mcpOAuthManager'));
    function pathForMain(name: string) { return require('node:path').join(process.cwd(), 'out', 'main', name + '.js'); }
    const manager = new DesktopMcpOAuthManager();
    const provider = manager.createProvider('https://example.test/mcp');
    const state = provider.state();
    const pending = manager.waitForAuthorizationCode();
    const missing = manager.settlePending(new URL('praxis://oauth-callback?code=attacker'));
    const mismatch = manager.settlePending(new URL('praxis://oauth-callback?error=attacker&state=wrong'));
    const valid = manager.settlePending(new URL('praxis://oauth-callback?code=legitimate&state=' + state));
    const code = await pending;
    const replay = manager.settlePending(new URL('praxis://oauth-callback?code=replay&state=' + state));
    const nextState = provider.state();
    const next = manager.waitForAuthorizationCode().catch(() => 'cancelled');
    manager.settlePending(new URL('praxis://oauth-callback?error=access_denied&state=' + nextState));
    await next;
    return { missing, mismatch, valid, code, replay, distinct: state !== nextState };
  });
  expect(result).toEqual({ missing: 'none', mismatch: 'none', valid: 'resolved', code: 'legitimate', replay: 'none', distinct: true });
});

test('secret reads repair permissive file modes and encrypted values remain retrievable', async () => {
  const result = await app.electronApp.evaluate(async ({ app, safeStorage }) => {
    const require = process.getBuiltinModule('module')!.createRequire(process.cwd() + '/out/main/index.js');
    const fs = require('node:fs'); const path = require('node:path');
    const { ElectronSecretsStore } = require(path.join(process.cwd(), 'out', 'main', 'adapters', 'electronSecretsStore.js'));
    const file = path.join(app.getPath('userData'), 'security-fixture-secrets.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    const store = new ElectronSecretsStore(file);
    await store.get('missing');
    const repaired = fs.statSync(file).mode & 0o777;
    const encrypted = safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
    if (encrypted) { await store.store('fixture', 'fixture-only-value'); }
    return { repaired, value: encrypted ? await store.get('fixture') : undefined, plain: fs.readFileSync(file, 'utf8').includes('fixture-only-value'), encrypted, windows: process.platform === 'win32' };
  });
  if (!result.windows) expect(result.repaired).toBe(0o600);
  expect(result.plain).toBe(false);
  if (result.encrypted) expect(result.value).toBe('fixture-only-value');
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
  await app.window.getByTestId('project-workflow-nav-item').hover();
  await app.window.getByTestId('project-workflow-run-repository-check').click();
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
