// e2e coverage for the permission-approval UI/IPC (`ai:respondToPermission`,
// the Sessions console's approval card). Neither agent host previously had
// any way for the renderer to resolve a permission request — a session
// hitting `awaiting_approval` (a non-allowlisted shell command, a file write
// outside the safe patterns for the local-tools path; any tool call for the
// ACP path) just hung forever. This drives the new UI through a real
// permission round-trip end to end.
//
// Uses the ACP fixture (`fixtures/fakeAcpAgent.mjs`, real
// `@agentclientprotocol/sdk` agent, not a stub) as the trigger mechanism
// because it can request a permission on demand via its `WITH_PERMISSION`
// prompt marker — the approval card and `ai:respondToPermission` IPC it
// exercises are provider-agnostic, the same code path the local-tools
// (Vercel/OpenAI/Anthropic) sessions use.

import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

async function selectCliProvider(win: TestApp['window']): Promise<void> {
  await win.locator('[data-testid="new-session-provider-chip"]').click();
  await win.locator('[data-testid="new-session-provider-option-claude-code-cli"]').click();
}

test('allowing a pending permission lets the session continue to completion', async () => {
  app = await launchTestApp();
  const win = app.window;

  await win.evaluate(
    async ({ cliPath }) => {
      const w = window as unknown as {
        praxis: {
          settings: { set: (patch: { ai: { providers: Record<string, { cliPath: string }> } }) => Promise<unknown> };
        };
      };
      await w.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath } } } });
    },
    { cliPath: FIXTURE_PATH }
  );
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');

  const composer = win.locator('[data-testid="new-session-view"]');
  await selectCliProvider(win);
  await composer.locator('textarea').fill('WITH_PERMISSION please');
  await win.locator('[data-testid="new-session-submit"]').click();

  await win.locator('[data-testid="sessions-view"]').waitFor();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Awaiting approval', {
    timeout: 15000
  });

  const card = win.locator('[data-testid="session-permission-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Read a file');

  await win.locator('[data-testid="session-permission-allow-once"]').click();

  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  // The approval card disappears once resolved.
  await expect(card).toHaveCount(0);
  // The completed tool run shows as a single collapsed row (no `tool_start` row).
  await expect(win.locator('[data-testid="session-chat-tool"]')).toHaveCount(1);
});

test('denying a pending permission is honored by the agent', async () => {
  app = await launchTestApp();
  const win = app.window;

  await win.evaluate(
    async ({ cliPath }) => {
      const w = window as unknown as {
        praxis: {
          settings: { set: (patch: { ai: { providers: Record<string, { cliPath: string }> } }) => Promise<unknown> };
        };
      };
      await w.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath } } } });
    },
    { cliPath: FIXTURE_PATH }
  );
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');

  const composer = win.locator('[data-testid="new-session-view"]');
  await selectCliProvider(win);
  // The fixture asserts (via stderr) that a REJECT_ME prompt gets a denied
  // decision — a genuine behavioral check, not just "the button exists".
  await composer.locator('textarea').fill('WITH_PERMISSION and REJECT_ME please');
  await win.locator('[data-testid="new-session-submit"]').click();

  await win.locator('[data-testid="sessions-view"]').waitFor();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Awaiting approval', {
    timeout: 15000
  });

  await win.locator('[data-testid="session-permission-deny"]').click();

  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });

  // The fixture only writes to stderr (piped into the app's log bus with an
  // `[acp:stderr]` prefix by `AcpClientWrapper`) if its own outcome
  // assertion FAILS — i.e. if it saw an allow when it expected a deny. Give
  // the log a moment to arrive, then confirm that never happened.
  await win.waitForTimeout(500);
  await win.locator('[aria-label="Toggle panel"]').click();
  await win.locator('[data-testid="panel-tab-output"]').click();
  await expect(win.locator('[data-testid="output-log"]')).not.toContainText('FAKE_ACP_ASSERTION_FAILED');
});
