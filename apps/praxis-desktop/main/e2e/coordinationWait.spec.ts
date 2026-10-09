// FX-BF-048 journeys: waiting for another session, and a service an agent left running.
//
// 1. Another session (played by the test process, a follower at the app's broker) holds
//    sum.js. A gateway agent's write is refused; it calls wait_for_files once and is queued —
//    the inspector shows it waiting, the file untouched. When the holder releases, the agent is
//    woken with a fresh grant, writes, and its turn ending releases everything.
// 2. An agent's shell command starts a server in the background. The tool returns at once,
//    the processes stay claimed (with the port they listen on) after the turn, and Stop in the
//    inspector ends them and the claim.
// 3. A person clicking in the in-app browser takes it from the agent that held it: the agent
//    is told what it saw is out of date and is refused the browser until the person stops.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { openSession } from './sessionNavigation';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { joinCoordination, type CoordinationEndpoint } from '../src/main/coordinationHost';

const GATEWAY_ENV = {
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined,
  AI_GATEWAY_API_KEY: 'e2e-coordination-key'
};
const ARTIFACTS = path.resolve(__dirname, '../../.praxis/session-artifacts');

let app: TestApp | undefined;
let broker: CoordinationEndpoint | undefined;
let mock: MockGatewayServer | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await broker?.close();
  broker = undefined;
  await mock?.close();
  mock = undefined;
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

function gitRepo(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coord-wait-')));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}

test('an agent refused a held file waits for it once, is woken when it is released, and then writes', async () => {
  test.setTimeout(90000);
  const original = 'function sum(a, b) {\n  return a - b;\n}\n';
  const fixed = 'function sum(a, b) {\n  return a + b;\n}\n';
  repo = gitRepo({ 'sum.js': original });
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: [
      { content: 'Fixing sum.js.', toolCalls: [{ name: 'write_file', arguments: { path: 'sum.js', content: fixed } }] },
      { content: 'Another session has it; waiting once.', toolCalls: [{ name: 'wait_for_files', arguments: { paths: ['sum.js'], reason: 'fix sum()', seconds: 60 } }] },
      { content: 'It is mine now.', toolCalls: [{ name: 'write_file', arguments: { path: 'sum.js', content: fixed } }] }
    ],
    reply: 'Fixed sum.js after the other session finished.'
  });
  app = await launchTestApp(undefined, undefined, { ...GATEWAY_ENV, AI_GATEWAY_URL: mock.baseUrl });
  broker = await joinCoordination(path.join(app.userDataDir, 'coordination'));
  expect(broker.role).toBe('follower');
  await broker.send({ kind: 'register', session: { sessionKey: 'OTHER-SESSION', runtime: 'gateway', coverage: 'enforced', scope: fs.realpathSync(path.join(repo, '.git')), worktree: repo } });
  const held = await broker.send({ kind: 'acquire', requestId: 'other-1', owner: { sessionKey: 'OTHER-SESSION' }, items: [{ resource: { kind: 'file', worktree: repo, path: 'sum.js' }, mode: 'exclusive' }], reason: 'refactoring sum.js', lifetime: 'sequence', wait: false });
  expect(held.ok && held.acquire?.status).toBe('granted');

  const win = app.window;
  await win.evaluate(
    async workingDirectory => window.praxis.ai.delegate({ provider: 'vercel-gateway', toolMode: 'full', permissionMode: 'bypass', workingDirectory, task: { goal: 'Fix the sum() function in sum.js.' } }),
    repo
  );
  await openSession(win);

  // Waiting: queued at the broker and shown in the inspector; the file is untouched.
  const panel = win.locator('[data-testid="session-coordination"]');
  await expect(panel.locator('[data-testid="session-coordination-waiter"]')).toContainText('This session', { timeout: 15000 });
  await expect(panel.locator('[data-testid="session-coordination-waiter"]')).toContainText('fix sum()');
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toContainText('OTHER-SESSION');
  expect(fs.readFileSync(path.join(repo, 'sum.js'), 'utf8')).toBe(original);
  await panel.scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(ARTIFACTS, 'session-coordination-waiting.png') });
  // The refusal the agent read named the holder and offered the bounded wait.
  expect(mock.requests[1].body).toContain('held by OTHER-SESSION (refactoring sum.js)');
  expect(mock.requests[1].body).toContain('call wait_for_files to wait for it');

  // The holder finishes: the waiting agent is woken with a fresh grant, writes, and completes.
  await broker.send({ kind: 'release', owner: { sessionKey: 'OTHER-SESSION' }, requestId: 'other-1' });
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  expect(fs.readFileSync(path.join(repo, 'sum.js'), 'utf8')).toBe(fixed);
  expect(mock.requests[2].body).toContain('You now hold sum.js until your turn ends');
  await expect(panel.locator('[data-testid="session-coordination-waiter"]')).toHaveCount(0, { timeout: 10000 });
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toHaveCount(0, { timeout: 10000 });
  await win.screenshot({ path: path.join(ARTIFACTS, 'session-coordination-woken.png') });
  const state = (await broker.snapshot()) as { claims: unknown[]; waiters: unknown[]; events: Array<{ type: string; toSessionKey?: string }> };
  expect(state.claims).toHaveLength(0);
  expect(state.waiters).toHaveLength(0);
  expect(state.events.filter(event => event.type === 'resource-available')).toHaveLength(1);
});

test('a server an agent left running stays claimed after its turn, and Stop in the inspector ends it', async () => {
  test.setTimeout(60000);
  repo = gitRepo({ 'server.js': "require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1');\n" });
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: [{ content: 'Starting the server.', toolCalls: [{ name: 'run_shell', arguments: { command: 'node server.js > /dev/null 2>&1 & echo started' } }] }],
    reply: 'The server is running.'
  });
  app = await launchTestApp(undefined, undefined, { ...GATEWAY_ENV, AI_GATEWAY_URL: mock.baseUrl });
  const win = app.window;
  await win.evaluate(
    async workingDirectory => window.praxis.ai.delegate({ provider: 'vercel-gateway', toolMode: 'full', permissionMode: 'bypass', workingDirectory, task: { goal: 'Start the server.' } }),
    repo
  );
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  // The server is usually still starting when the shell returns: its port is claimed when it opens.
  expect(mock.requests[1].body).toMatch(/Still running in the background: 1 process \(group \d+\)/);

  const panel = win.locator('[data-testid="session-coordination"]');
  const service = panel.locator('[data-testid="session-coordination-claim"]', { hasText: 'processes (group' });
  await expect(service).toBeVisible({ timeout: 10000 });
  await expect(panel.locator('[data-testid="session-coordination-claim"]', { hasText: /^port \d+/ })).toBeVisible({ timeout: 10000 });
  const pgid = Number(/group (\d+)/.exec((await service.textContent()) ?? '')?.[1]);
  expect(() => process.kill(-pgid, 0)).not.toThrow();
  await panel.scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(ARTIFACTS, 'session-coordination-service.png') });

  await service.locator('[data-testid="session-coordination-stop"]').click();
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toHaveCount(0, { timeout: 10000 });
  expect(() => process.kill(-pgid, 0)).toThrow();
});

test('a person clicking in the in-app browser takes it from the agent driving it', async () => {
  test.setTimeout(60000);
  const page = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Login</h1><input id="name">'));
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', () => resolve()));
  const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
  app = await launchTestApp(undefined, undefined, { PRAXIS_BROWSER_ALLOW_LOOPBACK: '1' });
  const pid = app.electronApp.process().pid!;
  broker = await joinCoordination(path.join(app.userDataDir, 'coordination'));
  const surface = `in-app:${pid}`;
  await broker.send({ kind: 'register', session: { sessionKey: 'BROWSING-AGENT', runtime: 'acp', coverage: 'cooperative' } });
  const held = await broker.send({ kind: 'acquire', requestId: 'agent-browser', owner: { sessionKey: 'BROWSING-AGENT' }, items: [{ resource: { kind: 'browser', surface }, mode: 'exclusive' }], reason: 'checking the login page', lifetime: 'sequence', wait: false });
  expect(held.ok && held.acquire?.status).toBe('granted');

  // The in-app browser exists once something attaches it; then a real input event reaches it.
  await app.window.evaluate(async () => {
    await window.praxis.browser.attach();
    await window.praxis.browser.setBounds({ x: 300, y: 120, width: 600, height: 400 });
    await window.praxis.browser.setVisible(true);
  });
  await app.window.evaluate(url => window.praxis.browser.navigate(url), pageUrl);
  // A real click and keypress through Electron's input pipeline — what a person produces.
  // (Agents drive the page with executeJavaScript, which never reaches this pipeline.)
  const delivered = await app.electronApp.evaluate(({ BrowserWindow, webContents }) => {
    const hosts = new Set(BrowserWindow.getAllWindows().map(win => win.webContents.id));
    const browser = webContents.getAllWebContents().find(candidate => !hosts.has(candidate.id) && candidate.getURL().startsWith('http://127.0.0.1'));
    if (!browser) return false;
    browser.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    browser.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    return true;
  });
  expect(delivered).toBe(true);

  await expect
    .poll(async () => ((await broker!.snapshot()) as { claims: Array<{ owner: { sessionKey: string }; resource: { kind: string } }> }).claims.find(claim => claim.resource.kind === 'browser')?.owner.sessionKey, { timeout: 10000 })
    .toBe(`person:${pid}`);
  const state = (await broker.snapshot()) as { events: Array<{ type: string; toSessionKey?: string; text: string }> };
  expect(state.events.find(event => event.type === 'taken-over')?.toSessionKey).toBe('BROWSING-AGENT');
  const again = await broker.send({ kind: 'acquire', requestId: 'agent-browser-2', owner: { sessionKey: 'BROWSING-AGENT' }, items: [{ resource: { kind: 'browser', surface }, mode: 'exclusive' }], reason: 'continue', lifetime: 'sequence', wait: false });
  expect(again.ok && again.acquire?.status === 'blocked' ? again.acquire.reason : '').toContain('a person is using the in-app browser');
  page.close();
});
