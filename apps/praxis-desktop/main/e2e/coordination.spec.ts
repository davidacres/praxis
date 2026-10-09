// FX-BF-048 journey: two sessions, one file. Another session (a second Praxis
// instance, played here by the test process) holds sum.js at the coordination
// broker. A real ACP agent session asked to fix sum.js is refused at Praxis's
// own write gate — the file is untouched — and the inspector shows who holds
// it. When the holder goes silent its claim waits for recovery rather than
// being handed over; a person confirms it in the inspector, and the same fix
// then lands.
//
// The app joins the broker at startup and leads it; the test process joins as
// a follower, so every command here crosses the authenticated local socket.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { openSession } from './sessionNavigation';
import { joinCoordination, type CoordinationEndpoint } from '../src/main/coordinationHost';

const AGENT_FIXTURE = path.join(__dirname, 'fixtures', 'codingAcpAgent.mjs');

let app: TestApp | undefined;
let broker: CoordinationEndpoint | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await broker?.close();
  broker = undefined;
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

async function runFix(win: TestApp['window'], cwd: string, goal: string): Promise<{ issueKey: string; responseText: string }> {
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal, workingDirectory: cwd, toolMode: 'full', task: { goal, maxSteps: 4, timeoutMs: 30000 } }),
    { goal, cwd }
  );
  await expect
    .poll(async () => win.evaluate(key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)?.state), session.issueKey), { timeout: 20000 })
    .toBe('completed');
  const record = await win.evaluate(key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)), session.issueKey);
  return { issueKey: session.issueKey, responseText: record?.responseText ?? '' };
}

test('a file another session holds is not written; recovery is a person\'s call, then the fix lands', async () => {
  test.setTimeout(90000);
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coord-')));
  const sumFile = path.join(repo, 'sum.js');
  const original = 'function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n';
  fs.writeFileSync(sumFile, original);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });
  const scope = fs.realpathSync(path.join(repo, '.git'));

  app = await launchTestApp();
  broker = await joinCoordination(path.join(app.userDataDir, 'coordination'));
  expect(broker.role).toBe('follower');
  await broker.send({ kind: 'register', session: { sessionKey: 'OTHER-SESSION', runtime: 'gateway', coverage: 'enforced', scope, worktree: repo } });
  const held = await broker.send({
    kind: 'acquire',
    requestId: 'other-1',
    owner: { sessionKey: 'OTHER-SESSION' },
    items: [{ resource: { kind: 'file', worktree: repo, path: 'sum.js' }, mode: 'exclusive' }],
    reason: 'refactoring sum.js',
    lifetime: 'sequence',
    wait: false
  });
  expect(held.ok && held.acquire?.status).toBe('granted');

  const win = app.window;
  await win.evaluate(agentPath => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }), AGENT_FIXTURE);

  // 1. Refused at the gate, before the write: the file is untouched and the agent was told who has it.
  const refused = await runFix(win, repo, 'Fix the sum() function in sum.js so it returns a + b.');
  expect(fs.readFileSync(sumFile, 'utf8')).toBe(original);
  expect(refused.responseText).toContain('Could not write');
  expect(refused.responseText).toContain('OTHER-SESSION');
  expect(refused.responseText).toContain('refactoring sum.js');

  // The inspector shows the session is coordinated cooperatively, and who holds what.
  await openSession(win, 'Fix the sum() function');
  const panel = win.locator('[data-testid="session-coordination"]');
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.locator('[data-testid="session-coordination-coverage"]')).toHaveText('cooperative');
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toContainText('sum.js');
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toContainText('OTHER-SESSION');
  await panel.scrollIntoViewIfNeeded();
  await win.screenshot({ path: 'output/playwright/session-coordination-held.png', fullPage: true });

  // 2. The holder ends without releasing: its claim waits for recovery, it is not handed over.
  await broker.send({ kind: 'end-session', sessionKey: 'OTHER-SESSION' });
  const stillHeld = await runFix(win, repo, 'Fix sum.js again so it returns a + b.');
  expect(fs.readFileSync(sumFile, 'utf8')).toBe(original);
  expect(stillHeld.responseText).toContain('Could not write');

  // 3. A person confirms it stopped, in the inspector.
  await openSession(win, 'Fix the sum() function');
  const recover = panel.locator('[data-testid="session-coordination-recover"]');
  await expect(recover).toBeVisible({ timeout: 10000 });
  await win.screenshot({ path: 'output/playwright/session-coordination-recovery.png', fullPage: true });
  await recover.click();
  await expect(panel.locator('[data-testid="session-coordination-claim"]')).toHaveCount(0, { timeout: 10000 });
  const state = (await broker.snapshot()) as { events: Array<{ type: string; text: string }> };
  expect(state.events.some(event => event.type === 'recovered' && event.text.includes('you, in Praxis'))).toBe(true);

  // 4. The same fix now lands, and its tool claim is released when the write is done.
  await runFix(win, repo, 'Fix sum.js one more time so it returns a + b.');
  expect(fs.readFileSync(sumFile, 'utf8')).toContain('return a + b');
  const after = (await broker.snapshot()) as { claims: unknown[] };
  expect(after.claims).toHaveLength(0);
});
