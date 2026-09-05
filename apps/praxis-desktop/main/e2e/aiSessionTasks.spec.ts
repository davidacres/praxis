// The agent's self-reported task list (ACP's `plan` update — Claude Code's
// TodoWrite, Codex's plan tool). Lives in the sessions inspector rather than
// the transcript specifically so it stays visible and current while the
// centre pane keeps scrolling past new turns — this drives that end to end
// with a fixture that streams a real, evolving plan across one turn.

import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

async function delegate(win: TestApp['window'], goal: string): Promise<string> {
  await win.evaluate(
    p => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: p } } } }),
    FIXTURE_PATH
  );
  const session = await win.evaluate(
    async ({ goal }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli', goal, toolMode: 'read-only',
      task: { goal, maxSteps: 4, timeoutMs: 30000 }
    }),
    { goal }
  );
  return session.issueKey;
}

test('the task list updates live as the agent works through it, then settles once the turn ends', async () => {
  app = await launchTestApp();
  const win = app.window;
  const key = await delegate(win, 'WITH_PLAN STOP_PLAN_MIDWAY please');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'WITH_PLAN STOP_PLAN_MIDWAY' }).click();

  const tasks = win.getByTestId('session-tasks');
  await expect(tasks).toBeVisible();
  await expect(tasks.getByTestId('session-task')).toHaveCount(3);

  // Watch it move through the same three snapshots the fixture streams,
  // rather than only checking the state after the turn settles — a host that
  // replaced only on the final event and dropped the ones in between would
  // still pass an end-state-only check.
  await expect(tasks.getByTestId('session-tasks-count')).toHaveText('0/3');
  await expect.poll(() => tasks.getByTestId('session-tasks-count').textContent()).toBe('1/3');
  await expect.poll(() => tasks.getByTestId('session-tasks-count').textContent()).toBe('2/3');

  const rows = tasks.getByTestId('session-task');
  await expect(rows.nth(0)).toHaveClass(/is-completed/);
  await expect(rows.nth(1)).toHaveClass(/is-completed/);
  await expect(rows.nth(2)).toHaveClass(/is-in_progress/);
  await expect(rows.nth(2)).toContainText('Re-run the suite');

  await win.screenshot({ path: 'output/playwright/session-tasks-inflight.png', fullPage: true });

  // The turn is still running (STOP_PLAN_MIDWAY held the third task open) —
  // confirm the list stayed exactly as the fixture left it, then let the turn
  // finish and check nothing about it changes on its own afterward.
  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');
  await expect(tasks.getByTestId('session-tasks-count')).toHaveText('2/3');
});

test('a fully completed plan shows all three done', async () => {
  app = await launchTestApp();
  const win = app.window;
  const key = await delegate(win, 'WITH_PLAN please');

  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'WITH_PLAN please' }).click();

  const tasks = win.getByTestId('session-tasks');
  await expect(tasks.getByTestId('session-tasks-count')).toHaveText('3/3');
  const rows = tasks.getByTestId('session-task');
  for (const i of [0, 1, 2]) await expect(rows.nth(i)).toHaveClass(/is-completed/);
});

test('a session that never reports a plan shows no Tasks block at all', async () => {
  app = await launchTestApp();
  const win = app.window;
  // No WITH_PLAN marker — the ordinary "hello" turn every other fixture test
  // exercises. An empty "Tasks" heading here would be noise every session
  // that never uses TodoWrite would pay for.
  const key = await delegate(win, 'just say hello');

  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'just say hello' }).click();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed');
  await expect(win.getByTestId('session-tasks')).toHaveCount(0);
});

test('an ACP agent reporting usage drives the context banner and shows its cost', async () => {
  app = await launchTestApp();
  const win = app.window;
  await delegate(win, 'WITH_USAGE please');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'WITH_USAGE please' }).click();

  // `used`/`size` from ACP feed exactly the pair the composer banner reads, so
  // a CLI-hosted session now gets the same warning an API-provider one does.
  // This is the half of `usage_update` that was assumed impossible.
  const context = win.getByTestId('session-context');
  await expect(context).toBeVisible();
  await expect(context.getByTestId('session-context-figure')).toHaveText('74% of 100k context used');

  // Cost is cumulative and real, so it shows. Asserted loosely on purpose:
  // Intl renders USD as "$0.42" or "US$0.42" depending on the machine's
  // locale, and pinning one would fail on the other developer's laptop.
  await expect(win.getByTestId('session-cost')).toContainText('0.42');
  await expect(win.getByTestId('session-cost')).toContainText('$');
  // ...while the cumulative *token* total stays absent, because ACP reports no
  // such number. Showing a 0 or reusing `used` here would both be inventions.
  await expect(win.getByTestId('session-tokens')).toHaveCount(0);
  expect(
    await win.evaluate(() => window.praxis.ai.listSessions().then(l => l[0]?.tokenUsage))
  ).toBeUndefined();

  await win.screenshot({ path: 'output/playwright/acp-usage-context-and-cost.png', fullPage: true });
});
