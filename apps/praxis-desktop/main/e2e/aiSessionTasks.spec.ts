import { openSession } from './sessionNavigation';
// ACP session reporting driven through the fake agent fixture. The agent's
// self-reported task list (ACP's `plan` update) used to be checked here too;
// the redesigned session page dropped that panel on purpose, so only the
// usage half remains.

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

test('an ACP agent reporting usage drives the context indicator and shows its cost', async () => {
  app = await launchTestApp();
  const win = app.window;
  await delegate(win, 'WITH_USAGE please');

  await openSession(win, 'WITH_USAGE please');

  // `used`/`size` from ACP feed exactly the pair the composer indicator reads,
  // so a CLI-hosted session gets the same details an API-provider one does.
  // This is the half of `usage_update` that was assumed impossible.
  await win.getByTestId('session-context-chip').click();
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
