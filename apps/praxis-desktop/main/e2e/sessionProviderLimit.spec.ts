// SPDX-License-Identifier: MIT
//
// A normal session whose AI runs out of credits: the composer offers to carry
// on with another AI that is set up (a handover, so the new AI picks up where
// the old one stopped) or to stop. The fake ACP agent stands in for Codex.

import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await mock?.close();
  mock = undefined;
});

async function outOfBudgetSession(): Promise<TestApp['window']> {
  mock = await startMockGatewayServer({ mode: 'error' });
  app = await launchTestApp(
    {
      ai: {
        providers: {
          'codex-cli': { cliPath: path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs') },
          // Only Codex is offered, so a real CLI on this machine is never picked.
          'claude-code-cli': { enabled: false },
          'copilot-cli': { enabled: false },
          'antigravity-cli': { enabled: false },
          'cursor-cli': { enabled: false }
        }
      }
    },
    undefined,
    { VERCEL_OIDC_TOKEN: undefined, AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl }
  );
  const win = app.window;
  await win.evaluate(() => window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Summarise the release plan.' } }));
  await win.getByTestId('nav-conversations').click();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Failed', { timeout: 15000 });
  return win;
}

test('a session whose AI ran out can switch to another AI and carry on', async () => {
  const win = await outOfBudgetSession();
  const notice = win.getByTestId('session-limit-switch');
  await expect(notice).toContainText('Vercel AI Gateway reached its usage limit.');
  await expect(notice.getByTestId('session-limit-provider')).toContainText('Codex');
  await expect(win.getByTestId('session-follow-up-input')).toHaveCount(0);
  await expect(win.getByTestId('session-provider')).toHaveCount(0);
  await win.mouse.move(0, 0);
  await win.screenshot({ path: 'output/playwright/session-limit-switch.png' });

  await notice.getByTestId('session-limit-switch-go').click();
  await expect(win.getByTestId('session-chat-thread')).toContainText('Hello from the fake ACP agent', { timeout: 20000 });
  await expect(notice).toHaveCount(0);
  const provider = await win.evaluate(() => window.praxis.ai.listSessions().then(list => list[0]?.provider));
  expect(provider).toBe('codex-cli');
});

test('a session whose AI ran out can be stopped instead', async () => {
  const win = await outOfBudgetSession();
  const notice = win.getByTestId('session-limit-switch');
  await notice.getByTestId('session-limit-actions').click();
  await win.getByTestId('session-limit-stop').click();
  await expect(notice).toHaveCount(0);
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  await expect(win.getByTestId('session-provider')).toBeVisible();
  await expect(win.getByTestId('session-model')).toBeVisible();
  const provider = await win.evaluate(() => window.praxis.ai.listSessions().then(list => list[0]?.provider));
  expect(provider).toBe('vercel-gateway');
});
