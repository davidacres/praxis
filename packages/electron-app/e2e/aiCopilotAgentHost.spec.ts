// e2e coverage for `CopilotAgentHost` — the `hostKind: 'copilot-sdk'`
// CLI-hosted-agent path (GitHub Copilot via `@github/copilot-sdk`). Uses a
// minimal fake Copilot runtime fixture (`fixtures/fakeCopilotRuntime.mjs`,
// speaking the SDK's real raw JSON-RPC wire protocol via `vscode-jsonrpc`)
// instead of a real Copilot CLI install/auth, so this runs in CI without
// either. Structurally mirrors `aiCliAgentHost.spec.ts` (the ACP peer of
// this suite) and `aiPermissions.spec.ts` (the permission-approval UI,
// which is provider-agnostic — both hosts write through the same
// `AiSessionManager` state machine, so the same approval card and
// `ai:respondToPermission` IPC apply here unchanged).

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeCopilotRuntime.mjs');

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/** Configures the Copilot provider's runtime path, matching what the Settings UI's "CLI path" field writes. */
async function configureCopilotProvider(win: TestApp['window'], cliPath: string): Promise<void> {
  await win.evaluate(
    async ({ cliPath }) => {
      const w = window as unknown as {
        ticketManager: {
          settings: { set: (patch: { ai: { providers: Record<string, { cliPath: string }> } }) => Promise<unknown> };
        };
      };
      await w.ticketManager.settings.set({ ai: { providers: { 'copilot-cli': { cliPath } } } });
    },
    { cliPath }
  );
}

async function delegate(win: TestApp['window'], issueKey: string, goal: string): Promise<void> {
  await win.evaluate(
    async ({ issueKey, goal }) => {
      const w = window as unknown as {
        ticketManager: {
          ai: {
            delegate: (input: {
              issueKey: string;
              provider: string;
              task: { goal: string; maxSteps: number; timeoutMs: number };
            }) => Promise<unknown>;
          };
        };
      };
      await w.ticketManager.ai.delegate({
        issueKey,
        provider: 'copilot-cli',
        task: { goal, maxSteps: 3, timeoutMs: 30000 }
      });
    },
    { issueKey, goal }
  );
}

async function readSession(
  win: TestApp['window'],
  issueKey: string
): Promise<{ state: string; responseText?: string } | undefined> {
  return win.evaluate(async issueKey => {
    const w = window as unknown as {
      ticketManager: {
        ai: { listSessions: () => Promise<Array<{ issueKey: string; state: string; responseText?: string }>> };
      };
    };
    const sessions = await w.ticketManager.ai.listSessions();
    return sessions.find(s => s.issueKey === issueKey);
  }, issueKey);
}

test('delegate completes a session against a fake Copilot runtime', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCopilotProvider(win, FIXTURE_PATH);

  await delegate(win, 'APP-203', 'Say hello via the Copilot SDK');

  await expect.poll(async () => (await readSession(win, 'APP-203'))?.state, { timeout: 15000 }).toBe('completed');

  const session = await readSession(win, 'APP-203');
  expect(session?.responseText).toContain('Hello from the fake Copilot runtime');
});

test('abort kills the Copilot runtime process cleanly', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCopilotProvider(win, FIXTURE_PATH);

  await delegate(win, 'APP-204', 'HANG_UNTIL_CANCELLED please');

  // The fixture holds the turn open, so the session stays non-terminal…
  await expect
    .poll(async () => (await readSession(win, 'APP-204'))?.state, { timeout: 10000 })
    .not.toBe('completed');

  // …and the runtime process is really running.
  const psBefore = execSync('ps aux').toString();
  expect(psBefore).toContain('fakeCopilotRuntime.mjs');

  await win.evaluate(async issueKey => {
    const w = window as unknown as { ticketManager: { ai: { abort: (issueKey: string) => Promise<void> } } };
    await w.ticketManager.ai.abort(issueKey);
  }, 'APP-204');

  await expect.poll(async () => (await readSession(win, 'APP-204'))?.state, { timeout: 10000 }).toBe('aborted');

  // No orphaned runtime process left behind.
  await expect
    .poll(() => execSync('ps aux').toString().includes('fakeCopilotRuntime.mjs'), { timeout: 10000 })
    .toBe(false);
});

test('a pending Copilot permission request resolves through the shared approval UI', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCopilotProvider(win, FIXTURE_PATH);
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');

  const composer = win.locator('[data-testid="new-session-view"]');
  await win.locator('[data-testid="new-session-provider-chip"]').click();
  await win.locator('[data-testid="new-session-provider-option-copilot-cli"]').click();
  await composer.locator('textarea').fill('WITH_PERMISSION please');
  await win.locator('[data-testid="new-session-submit"]').click();

  await win.locator('[data-testid="sessions-view"]').waitFor();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Awaiting approval', {
    timeout: 15000
  });

  const card = win.locator('[data-testid="session-permission-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Read file');

  await win.locator('[data-testid="session-permission-allow-once"]').click();

  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(card).toHaveCount(0);
});
