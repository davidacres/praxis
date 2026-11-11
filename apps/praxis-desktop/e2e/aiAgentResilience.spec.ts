// The agent host must never let a misbehaving agent hang the session.
//
// A dead subprocess is already handled: killing the child closes the transport
// and the SDK surfaces that, so the turn rejects on its own. The case with no
// transport-level signal is an agent that accepts a turn, never answers it, and
// ignores `session/cancel` while staying alive — nothing closes, nothing
// errors. `AcpAgentHost.stopTask()` awaited both that turn and the cancel
// notification with no timeout, so aborting such a session blocked forever.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const DEAF_FIXTURE = path.join(__dirname, 'fixtures', 'deafAcpAgent.mjs');

let app: TestApp | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

async function startDeafSession(win: TestApp['window'], cwd: string, goal: string): Promise<string> {
  await win.evaluate(
    p => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: p } } } }),
    DEAF_FIXTURE
  );
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: { goal, maxSteps: 4, timeoutMs: 120000 }
    }),
    { goal, cwd }
  );
  return session.issueKey;
}

const stateOf = (win: TestApp['window'], key: string) =>
  win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key);

test('aborting an agent that ignores cancel returns promptly', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-deaf-abort-'));
  app = await launchTestApp();
  const win = app.window;

  const key = await startDeafSession(win, repo, 'never answer this');

  // Abort has to come back on its own. The agent will never answer the turn and
  // never acknowledges `session/cancel`, so the only way out is the host's own
  // grace periods, after which it kills the child regardless.
  const elapsed = await win.evaluate(async k => {
    const started = Date.now();
    await window.praxis.ai.abort(k);
    return Date.now() - started;
  }, key);
  expect(elapsed, 'abort should not wait on a dead agent').toBeLessThan(15000);

  await expect.poll(() => stateOf(win, key), { timeout: 15000 }).toMatch(/failed|aborted|completed/);
});
