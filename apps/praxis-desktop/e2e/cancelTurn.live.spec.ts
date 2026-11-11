/**
 * Live: cancelling a real Claude Code turn stops the shell command it is running.
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent cancelTurn.live.spec.ts
 *
 * Claude Code is asked to run a slow command that writes a line every 200 ms and, at the
 * end, done.txt. Once the lines start, the turn is cancelled. Nothing more may be written.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const AGENT_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';
let app: TestApp | undefined;
let dir: string | undefined;

test.beforeAll(() => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'Live agent test: set PRAXIS_LIVE_AGENT=1 to spend real model calls.');
});
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const lines = () => (fs.existsSync(path.join(dir!, 'progress.txt')) ? fs.readFileSync(path.join(dir!, 'progress.txt'), 'utf8').split('\n').filter(Boolean).length : 0);

test('cancelling a real Claude Code turn stops the command it is running', async () => {
  test.setTimeout(240000);
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-cancel-')));
  fs.writeFileSync(path.join(dir, 'build.sh'), 'for i in $(seq 1 150); do echo "line $i" >> progress.txt; sleep 0.2; done\necho done > done.txt\n');
  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(command => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: command } } } }), AGENT_COMMAND);
  const goal = 'Run exactly this shell command and wait for it to finish: sh build.sh. Do nothing else.';
  const session = await win.evaluate(
    ({ goal, cwd }) => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal, workingDirectory: cwd, toolMode: 'full', permissionMode: 'bypass', task: { goal, maxSteps: 5, timeoutMs: 180000 } }),
    { goal, cwd: dir }
  );
  await expect.poll(lines, { timeout: 150000, intervals: [500] }).toBeGreaterThanOrEqual(5);
  await win.evaluate(key => window.praxis.ai.abort(key), session.issueKey);
  const atCancel = lines();
  await new Promise(resolve => setTimeout(resolve, 8000));
  const after = lines();
  console.log(`lines at cancel ${atCancel}, 8 s later ${after}, done.txt ${fs.existsSync(path.join(dir, 'done.txt'))}`);
  expect(after - atCancel, 'the command stopped with the turn').toBeLessThanOrEqual(15);
  expect(fs.existsSync(path.join(dir, 'done.txt'))).toBe(false);
  expect(await win.evaluate(key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)?.state), session.issueKey)).toBe('aborted');
});
