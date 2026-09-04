// Re-running a finished session in a different mode (Chat/Analysis/Review),
// driven from the composer chip row it moved into. This never had e2e
// coverage before — the control existed only in the sidebar inspector, and
// nothing exercised it there either.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

test('switching a finished session to Review sends the mode transition and resumes it', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-session-mode-'));
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined
  });
  const win = app.window;

  const session = await win.evaluate(
    async ({ cwd }) => window.praxis.ai.delegate({
      goal: 'Draft the release notes.',
      workingDirectory: cwd,
      toolMode: 'read-only',
      task: { goal: 'Draft the release notes.', maxSteps: 2, timeoutMs: 30000 }
    }),
    { cwd: repo }
  );
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]').first().click();

  // Lives among the composer's other chips, not in the sidebar.
  const toggle = win.locator('.composer-controls .session-mode-toggle');
  await expect(toggle).toBeVisible();
  await expect(win.locator('[data-testid="session-switch-mode-chat"]')).toHaveClass(/active/);

  await win.locator('[data-testid="session-switch-mode-review"]').click();

  // Picking Review sends the mode-transition prompt as a real turn: the
  // session leaves its terminal state, and the button reflects the new mode
  // once the switch has taken.
  await expect(win.locator('[data-testid="session-switch-mode-review"]')).toHaveClass(/active/);
  await expect.poll(() => win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
  ), { timeout: 20000 }).toBe('completed');

  const sentBody = JSON.parse(mock.requests.at(-1)!.body) as { messages: Array<{ role: string; content: string }> };
  const lastUserMessage = [...sentBody.messages].reverse().find(message => message.role === 'user');
  expect(lastUserMessage?.content).toContain('Switch this conversation into Review mode');

  await win.screenshot({ path: 'output/playwright/session-mode-chip.png', fullPage: true });
});
