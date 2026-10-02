import { openSession } from './sessionNavigation';
// A spend limit the *user* sets, checked against the cost agents actually
// report. Deliberately not a credit balance: nothing Praxis talks to reports
// one, so there is no "remaining credits" to show and the wording never
// implies there is.

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

async function setLimit(win: TestApp['window'], spendLimit: number): Promise<void> {
  await win.evaluate(limit => window.praxis.settings.set({ ai: { spendLimit: limit } }), spendLimit);
}

async function runSession(win: TestApp['window'], goal: string): Promise<void> {
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
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');
}

async function openSessions(win: TestApp['window'], rowText: string): Promise<void> {
  await openSession(win, rowText);
}

test('spend well under the limit says nothing', async () => {
  app = await launchTestApp();
  const win = app.window;
  await setLimit(win, 100);
  await runSession(win, 'WITH_USAGE please');
  await openSessions(win, 'WITH_USAGE please');

  // $0.42 of $100. A budget bar that is always on screen is one nobody reads.
  await expect(win.getByTestId('session-spend')).toHaveCount(0);
});

test('approaching the limit warns, and totals across sessions rather than per session', async () => {
  app = await launchTestApp();
  const win = app.window;
  await setLimit(win, 1);
  // Two sessions at $0.42 each — neither alone crosses two-thirds of $1, so a
  // per-session check would stay silent. The budget is the user's, not the
  // session's, so it is the total that matters.
  await runSession(win, 'WITH_USAGE first');
  await runSession(win, 'WITH_USAGE second');
  await openSessions(win, 'WITH_USAGE second');

  const spend = win.getByTestId('session-spend');
  await expect(spend).toBeVisible();
  await expect(spend.getByTestId('session-spend-figure')).toContainText('0.84');
  await expect(spend.getByTestId('session-spend-figure')).toContainText('spend limit');
  await expect(spend).toContainText('Approaching the spend limit');

  await win.screenshot({ path: 'output/playwright/spend-limit-warn.png', fullPage: true });
});

test('over the limit says so, and is honest that nothing is blocked', async () => {
  app = await launchTestApp();
  const win = app.window;
  await setLimit(win, 5);
  await runSession(win, 'WITH_USAGE COST_BIG please');
  await openSessions(win, 'WITH_USAGE COST_BIG please');

  const spend = win.getByTestId('session-spend');
  await expect(spend).toContainText('cost more than the limit');
  // Praxis cannot stop an agent spending, and the copy must not pretend it can.
  await expect(spend).toContainText('Nothing is blocked');
  // The bar caps at 100% rather than overflowing its track at 180%.
  await expect(spend.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
});

test('mixed currencies show no total rather than a meaningless one', async () => {
  app = await launchTestApp();
  const win = app.window;
  // A limit of 0.5 is deliberate: either currency's 0.42 alone is 84% of it, so
  // if the code fell back to "pick the first currency" the banner would appear.
  // Its absence is therefore evidence, not just the default state.
  await setLimit(win, 0.5);
  await runSession(win, 'WITH_USAGE in usd');
  await runSession(win, 'WITH_USAGE COST_EUR in euros');
  await openSessions(win, 'WITH_USAGE COST_EUR in euros');

  // $0.42 + €0.42 is not 0.84 of anything. Rather than pick a currency and
  // quietly add unlike numbers, the warning declines to appear at all.
  await expect(win.getByTestId('session-spend')).toHaveCount(0);
  const summary = await win.evaluate(() => window.praxis.ai.listSessions().then(
    list => list.filter(s => s.cost).map(s => s.cost!.currency).sort()
  ));
  expect(summary).toEqual(['EUR', 'USD']);
});
