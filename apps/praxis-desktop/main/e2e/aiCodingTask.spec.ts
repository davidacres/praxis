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

test('each turn records its reply once, and follow-ups carry the earlier answer', async () => {
  test.setTimeout(60000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coding-turns-'));
  fs.writeFileSync(path.join(repo, 'sum.js'), 'function sum(a, b) {\n  return a - b;\n}\n');

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(agentPath =>
    window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }),
    AGENT_FIXTURE
  );

  const goal = 'Fix the sum() function in sum.js so it returns a + b.';
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli', goal, workingDirectory: cwd, toolMode: 'full',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal, cwd: repo }
  );
  const key = session.issueKey;
  const stateOf = () =>
    win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key);
  const messageEvents = async () =>
    win.evaluate(
      k => window.praxis.ai.listSessions().then(
        l => (l.find(s => s.issueKey === k)?.events ?? []).filter(e => e.type === 'message').map(e => e.detail ?? '')
      ),
      key
    );

  await expect.poll(stateOf, { timeout: 20000 }).toBe('completed');

  // The first turn records its reply as a conversation event — it used to live
  // only in `responseText`, which kept it out of the follow-up's transcript.
  expect(await messageEvents()).toHaveLength(1);
  expect((await messageEvents())[0]).toContain('Ready for review');

  // It now renders as a proper assistant turn rather than a trailing stream.
  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'Fix the sum() function' }).click();
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText('Ready for review');

  // Two follow-ups: each adds exactly one reply. The retroactive flush this
  // replaced re-appended the previous answer, so the second follow-up used to
  // leave a duplicate behind.
  for (const [index, text] of ['Is that all?', 'Thanks.'].entries()) {
    await win.locator('[data-testid="session-follow-up-input"]').fill(text);
    await win.locator('[data-testid="session-follow-up-send"]').click();
    await expect.poll(stateOf, { timeout: 20000 }).toBe('completed');
    expect(await messageEvents()).toHaveLength(index + 2);
  }
});

test('a finished session shows its changeset and can commit it', async () => {
  test.setTimeout(60000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coding-commit-'));
  const sumFile = path.join(repo, 'sum.js');
  fs.writeFileSync(sumFile, 'function sum(a, b) {\n  return a - b;\n}\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  const app_ = app = await launchTestApp();
  const win = app_.window;
  await win.evaluate(agentPath =>
    window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }),
    AGENT_FIXTURE
  );

  const goal = 'Fix the sum() function in sum.js so it returns a + b.';
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli', goal, workingDirectory: cwd, toolMode: 'full',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal, cwd: repo }
  );
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'Fix the sum() function' }).click();

  // The changeset is read from the working tree, not reconstructed from the
  // transcript — so it reports what is actually on disk.
  const changes = win.locator('[data-testid="session-changes"]');
  await expect(changes).toBeVisible();
  await expect(changes.getByTestId('session-changes-count')).toContainText('1 file');
  await expect(changes.getByTestId('session-changes-file')).toContainText('sum.js');

  // A file opens its own diff in place, so reviewing does not mean leaving the
  // app for an editor.
  await changes.getByTestId('session-changes-open').click();
  const inlineDiff = changes.getByTestId('session-changes-diff');
  await expect(inlineDiff).toBeVisible();
  await expect(inlineDiff.locator('.diff-addition')).toContainText('return a + b');
  await expect(inlineDiff.locator('.diff-deletion')).toContainText('return a - b');

  await changes.getByTestId('session-commit').click();
  const dialog = win.getByRole('dialog', { name: 'Commit these changes' });
  await expect(dialog).toBeVisible();
  // Pre-filled from the session's goal, so the common case is one click.
  await expect(dialog.getByRole('textbox')).toHaveValue(goal);
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();

  // The commit landed, using the session's goal as its message, and the tree is
  // clean afterwards — so the panel takes itself away.
  await expect(changes).toHaveCount(0, { timeout: 10000 });
  const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo }).toString().trim();
  expect(log).toBe('Fix the sum() function in sum.js so it returns a + b.');
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim()).toBe('');
});

test('a CLI-agent session reports no token count rather than a misleading zero', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-coding-tokens-'));
  fs.writeFileSync(path.join(repo, 'sum.js'), 'function sum(a, b) {\n  return a - b;\n}\n');

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(agentPath =>
    window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: agentPath } } } }),
    AGENT_FIXTURE
  );

  const goal = 'Fix the sum() function in sum.js so it returns a + b.';
  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli', goal, workingDirectory: cwd, toolMode: 'full',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal, cwd: repo }
  );
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'Fix the sum() function' }).click();

  // A CLI agent runs on its own account and reports no usage over ACP. The
  // header therefore shows steps and duration and simply omits tokens — a "0
  // tokens" here would read as "this was free".
  const meta = win.getByTestId('session-meta');
  await expect(meta).toContainText('step');
  await expect(win.getByTestId('session-tokens')).toHaveCount(0);
  expect(
    await win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.tokenUsage), session.issueKey)
  ).toBeUndefined();
});
