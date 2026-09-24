// Two previously-unhandled, stable ACP session updates — `available_commands_update`
// and `current_mode_update` — see the ACP section of packages/core/src/ai/AGENTS.md's table of what
// the protocol offers versus what this host reads. Neither is invented UI:
// `session/new` already returns modes on a real Claude Code/Codex session, and
// slash commands are how those CLIs already work — this just makes both
// discoverable from the composer instead of requiring the user to already know
// they exist and type them blind.

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

test('Session Modes advertised at start switch over the live connection and update the composer', async () => {
  app = await launchTestApp();
  const win = app.window;
  // HANG_UNTIL_CANCELLED keeps the task active — the mode chip only appears
  // while `AcpAgentHost` still holds a live connection for the session (see
  // `setAcpMode`'s guard), the same way the real protocol ties `session/set_mode`
  // to a session that hasn't been torn down.
  const key = await delegate(win, 'HANG_UNTIL_CANCELLED please');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'HANG_UNTIL_CANCELLED please' }).click();

  await win.getByTestId('session-composer-ask-btn').click();

  const modeChip = win.getByTestId('session-acp-mode');
  await expect(modeChip).toBeVisible();
  await expect(modeChip).toContainText('Ask');

  await modeChip.click();
  const codeOption = win.getByTestId('session-acp-mode-option-code');
  await expect(codeOption).toBeVisible();
  await codeOption.click();

  // The fixture's `session/set_mode` handler both applies the switch and
  // confirms it with `current_mode_update` — the same round trip a real
  // agent makes, so this exercises the request path and the notification
  // path (`handleSessionUpdate`'s `current_mode_update` case) together.
  await expect(modeChip).toContainText('Code');
  await win.screenshot({ path: 'output/playwright/acp-session-modes.png', fullPage: true });

  await win.evaluate(k => window.praxis.ai.abort(k), key);
});

test('the agent\'s own slash commands populate the composer and insert into the follow-up box', async () => {
  app = await launchTestApp();
  const win = app.window;
  const key = await delegate(win, 'WITH_COMMANDS please');

  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'WITH_COMMANDS please' }).click();

  const commandsChip = win.getByTestId('session-acp-commands');
  await expect(commandsChip).toBeVisible();
  await commandsChip.click();

  const planOption = win.getByTestId('session-acp-command-option-create_plan');
  await expect(planOption).toBeVisible();
  await expect(win.getByTestId('session-acp-command-option-research_codebase')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/acp-slash-commands.png', fullPage: true });
  await planOption.click();

  // Commands are plain prompt text over the same `session/prompt` — nothing to
  // invoke, just an insertion into the draft the user can still edit.
  await expect(win.getByTestId('session-follow-up-input')).toHaveValue('/create_plan ');
});

test('context compaction is offered only when the ACP provider advertises /compact', async () => {
  app = await launchTestApp();
  const win = app.window;
  const key = await delegate(win, 'WITH_USAGE WITH_COMMANDS please');

  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'WITH_USAGE WITH_COMMANDS please' }).click();
  await expect(win.getByTestId('session-context-chip')).toBeVisible();
  const commandsBox = await win.getByTestId('session-acp-commands').boundingBox();
  const contextChipBox = await win.getByTestId('session-context-chip').boundingBox();
  expect(commandsBox).not.toBeNull();
  expect(contextChipBox).not.toBeNull();
  expect(commandsBox!.x + commandsBox!.width).toBeLessThan(contextChipBox!.x);

  await win.getByTestId('session-context-chip').click();
  const context = win.getByTestId('session-context');
  const compact = context.getByTestId('session-context-compact');
  await expect(compact).toBeVisible();
  await expect(compact).toHaveAttribute('aria-label', 'Compact context');
  await compact.click();
  await expect(win.getByTestId('session-context')).toHaveCount(0);
  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(item => item.issueKey === k)?.state), key), { timeout: 20000 })
    .toBe('completed');
  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => {
      const session = l.find(item => item.issueKey === k);
      return session?.events.some(event => event.type === 'user_input_completed' && event.detail === '/compact');
    }), key), { timeout: 20000 })
    .toBe(true);
});
