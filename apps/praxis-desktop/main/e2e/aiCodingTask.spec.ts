// End-to-end for the flow the onboarding calls "hand a ticket to an agent":
// a ticket describing a small coding task is delegated to a CLI-hosted agent,
// which reads the project's file, edits it, and reports back — and the change
// is really on disk afterwards.
//
// The agent is `fixtures/codingAcpAgent.mjs`, a real ACP subprocess that does
// a deterministic edit through Praxis's own `fs/read_text_file` /
// `fs/write_text_file` handlers (sandboxed to the session's working folder,
// gated by tool mode). No Claude Code / Codex install and no model call, so
// this runs in CI, but every layer between the ticket and the file is real.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const AGENT_FIXTURE = path.join(__dirname, 'fixtures', 'codingAcpAgent.mjs');

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

test('a ticket for a one-line fix is delegated to an agent and lands on disk', async () => {
  test.setTimeout(60000);
  // A tiny project with a bug: sum() subtracts instead of adding.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coding-task-'));
  const sumFile = path.join(repo, 'sum.js');
  fs.writeFileSync(sumFile, 'function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  app = await launchTestApp();
  const win = app.window;

  // Point the Claude Code provider's CLI path at the fixture agent — the same
  // field the Settings "CLI path" input writes.
  await win.evaluate(agentPath =>
    window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }),
    AGENT_FIXTURE
  );

  // The "fake ticket": a free-form goal, which the main process turns into a
  // synthesized session key. This is exactly what the New Session composer
  // sends when a session is started without a tracker issue behind it.
  const goal = 'Fix the sum() function in sum.js so it returns a + b, not a - b.';
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal, cwd: repo }
  );
  const issueKey = session.issueKey;
  expect(issueKey).toBeTruthy();

  // Wait for the agent's turn to finish.
  await expect
    .poll(
      async () =>
        win.evaluate(
          key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)?.state),
          issueKey
        ),
      { timeout: 20000 }
    )
    .toBe('completed');

  // The edit is really on disk...
  const edited = fs.readFileSync(sumFile, 'utf8');
  expect(edited).toContain('return a + b');
  expect(edited).not.toContain('return a - b');

  // ...and the fixed function actually computes a sum.
  const result = execFileSync('node', ['-e', 'process.stdout.write(String(require("./sum.js").sum(2, 3)))'], {
    cwd: repo
  }).toString();
  expect(result).toBe('5');

  // git sees exactly one modified file.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim();
  expect(status).toBe('M sum.js');

  // The agent's own summary of what it did.
  const record = await win.evaluate(
    key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)),
    issueKey
  );
  expect(record?.responseText ?? '').toContain('Ready for review');

  // The session is in the UI. A free-form session is listed by its goal, not
  // the synthesized key, which is what a user sees in the sidebar.
  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'Fix the sum() function' }).click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 10000 });

  // The edit renders as a red/green diff in the transcript.
  await win.locator('[data-testid="session-chat-tool"]').first().locator('summary').click();
  const diff = win.locator('[data-testid="session-tool-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.diff-add')).toContainText('return a + b');
  await expect(diff.locator('.diff-del')).toContainText('return a - b');
});

test('a read-only session cannot write the file', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coding-ro-'));
  const sumFile = path.join(repo, 'sum.js');
  const original = 'function sum(a, b) {\n  return a - b;\n}\n';
  fs.writeFileSync(sumFile, original);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(agentPath =>
    window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }),
    AGENT_FIXTURE
  );

  const goal = 'Fix sum.js to add instead of subtract.';
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal,
      workingDirectory: cwd,
      toolMode: 'read-only',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal, cwd: repo }
  );

  await expect
    .poll(
      async () =>
        win.evaluate(
          key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)?.state),
          session.issueKey
        ),
      { timeout: 20000 }
    )
    .toBe('completed');

  // The agent tried to write and the host refused it — the file is untouched,
  // and the session says why.
  expect(fs.readFileSync(sumFile, 'utf8')).toBe(original);
  const record = await win.evaluate(
    key => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === key)),
    session.issueKey
  );
  expect(record?.responseText ?? '').toMatch(/could not write|read-only/i);
});
