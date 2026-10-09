// Cancel means stop. A person sends "add a button to the page", then presses Cancel:
// nothing more of that request may happen — not the agent's next step, not a command it
// had already started, not the request itself if the agent was still starting up.
//
// The CLI agent is `slowWorkAcpAgent.mjs`, which records everything it does in its working
// folder: a tick every 100 ms while it works, and a subprocess that writes late.txt 4 s
// after the prompt. Before the fixes these were observed to fail: a cancel during startup
// still delivered the request (and ended "failed"); late.txt appeared after every cancel; an
// API agent's running command finished anyway. A message queued while the agent was busy
// was put back only because sending it failed while the agent shut down; once, under load,
// shutdown won the race and it was sent. The composer now never sends after a cancel.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

const AGENT = path.join(__dirname, 'fixtures', 'slowWorkAcpAgent.mjs');
let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let dir: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await mock?.close();
  mock = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const read = (name: string) => (fs.existsSync(path.join(dir!, name)) ? fs.readFileSync(path.join(dir!, name), 'utf8') : '');
const ticks = () => read('ticks.txt').split('\n').filter(Boolean).length;
const prompts = () => read('agent-log.txt').split('\n').filter(line => line.endsWith('prompt-received')).length;
const stateOf = (win: TestApp['window'], key: string) => win.evaluate(k => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === k)?.state), key);

async function cliAgent(env: Record<string, string> = {}): Promise<TestApp['window']> {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-cancel-')));
  app = await launchTestApp(undefined, undefined, env);
  await app.window.evaluate(p => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: p } } } }), AGENT);
  return app.window;
}

/** Nothing more happens: no new ticks, and the command the agent started never finishes. */
async function expectStopped(at: number) {
  await sleep(5000);
  expect(ticks() - at, 'the agent did no more work').toBeLessThanOrEqual(2);
  expect(fs.existsSync(path.join(dir!, 'late.txt')), 'the command the agent started was stopped too').toBe(false);
}

test('cancelling a CLI agent mid-request stops it and the commands it started', async () => {
  test.setTimeout(60000);
  const win = await cliAgent();
  const session = await win.evaluate(cwd => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal: 'add a button to the page', workingDirectory: cwd, toolMode: 'full', task: { goal: 'add a button to the page' } }), dir!);
  await expect.poll(ticks, { timeout: 15000 }).toBeGreaterThanOrEqual(5);
  await win.evaluate(k => window.praxis.ai.abort(k), session.issueKey);
  await expectStopped(ticks());
  expect(await stateOf(win, session.issueKey)).toBe('aborted');
  expect(read('agent-log.txt')).toContain('cancel-received');
});

test('a CLI agent that ignores the cancel is stopped anyway, commands included', async () => {
  test.setTimeout(60000);
  const win = await cliAgent({ IGNORE_CANCEL: '1' });
  const session = await win.evaluate(cwd => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal: 'add a button to the page', workingDirectory: cwd, toolMode: 'full', task: { goal: 'add a button to the page' } }), dir!);
  await expect.poll(ticks, { timeout: 15000 }).toBeGreaterThanOrEqual(5);
  await win.evaluate(k => window.praxis.ai.abort(k), session.issueKey);
  // abort() returns once the agent is gone: it is given 2 s to stop on its own, then killed
  // with everything it started — before its 4 s command can finish.
  await expectStopped(ticks());
  expect(await stateOf(win, session.issueKey)).toBe('aborted');
});

test('a follow-up cancelled while the CLI agent is still starting is never delivered', async () => {
  test.setTimeout(60000);
  const win = await cliAgent({ SLOW_START_MS: '1500' });
  const session = await win.evaluate(cwd => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal: 'Tidy the page', workingDirectory: cwd, toolMode: 'full', task: { goal: 'Tidy the page' } }), dir!);
  await expect.poll(ticks, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await win.evaluate(k => window.praxis.ai.abort(k), session.issueKey);
  await expect.poll(() => stateOf(win, session.issueKey)).toBe('aborted');
  expect(prompts()).toBe(1);

  await win.evaluate(k => window.praxis.ai.continueSession(k, 'add a button to the page'), session.issueKey);
  await sleep(300);
  await win.evaluate(k => window.praxis.ai.abort(k), session.issueKey);
  await sleep(4000);
  expect(prompts(), 'the follow-up never reached the agent').toBe(1);
  expect(await stateOf(win, session.issueKey), 'cancelled, not failed').toBe('aborted');
});

for (const when of ['working', 'starting'] as const) {
  test(`a message queued while the agent is busy is not sent when the person cancels (agent ${when}); it goes back to the composer`, async () => {
    test.setTimeout(60000);
    // Cancelled while starting, shutdown is quick: the other side of that race.
    const win = await cliAgent(when === 'starting' ? { SLOW_START_MS: '3000' } : {});
    const session = await win.evaluate(cwd => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal: 'Tidy the page', workingDirectory: cwd, toolMode: 'full', task: { goal: 'Tidy the page' } }), dir!);
    await openSession(win);
    await win.getByTestId('session-composer-ask-btn').click();
    await win.getByTestId('session-follow-up-input').fill('add a button to the page');
    await win.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
    await expect(win.getByTestId('session-queued-pill')).toBeVisible();
    if (when === 'working') await expect.poll(ticks, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    await win.getByRole('button', { name: 'Cancel response', exact: true }).click();
    await expect.poll(() => stateOf(win, session.issueKey), { timeout: 10000 }).toBe('aborted');
    // Long enough for an auto-sent follow-up to reach the agent, had it been sent.
    await sleep(6000);
    expect(prompts(), 'the queued request never reached the agent').toBe(when === 'working' ? 1 : 0);
    expect(await stateOf(win, session.issueKey)).toBe('aborted');
    const sent = await win.evaluate(k => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === k)?.events.filter(e => e.type === 'user_input_completed').length), session.issueKey);
    expect(sent, 'the queued message was not sent').toBe(0);
    await expect(win.getByTestId('session-follow-up-input')).toHaveValue('add a button to the page');
    await expect(win.getByTestId('session-queued-pill')).toHaveCount(0);
    await expect(win.getByTestId('session-error-banner')).toHaveCount(0);
  });
}

test('cancelling an API agent stops the shell command it is running and its next step', async () => {
  test.setTimeout(60000);
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-cancel-')));
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: [
      { content: 'Building.', toolCalls: [{ name: 'run_shell', arguments: { command: 'for i in $(seq 1 40); do echo tick$i >> ticks.txt; sleep 0.1; done; echo late > late.txt' } }] },
      { content: 'Next.', toolCalls: [{ name: 'write_file', arguments: { path: 'button.html', content: '<button>Go</button>' } }] }
    ],
    reply: 'Added the button.'
  });
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'e2e-cancel-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined });
  const win = app.window;
  const session = await win.evaluate(cwd => window.praxis.ai.delegate({ provider: 'vercel-gateway', toolMode: 'full', permissionMode: 'bypass', workingDirectory: cwd, task: { goal: 'add a button to the page' } }), dir);
  await expect.poll(ticks, { timeout: 15000 }).toBeGreaterThanOrEqual(5);
  await win.evaluate(k => window.praxis.ai.abort(k), session.issueKey);
  await expectStopped(ticks());
  expect(fs.existsSync(path.join(dir, 'button.html')), 'the next step never ran').toBe(false);
  expect(mock.requests).toHaveLength(1);
  expect(await stateOf(win, session.issueKey)).toBe('aborted');
});
