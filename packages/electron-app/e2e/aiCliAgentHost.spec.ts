// e2e coverage for `AcpAgentHost` — the Phase 2 CLI-hosted-agent path
// (Claude Code / Codex CLI via the Agent Client Protocol). Uses a minimal
// real ACP agent fixture (`fixtures/fakeAcpAgent.mjs`, built on the same
// `@agentclientprotocol/sdk` real agents use) instead of a real Claude
// Code/Codex CLI install, so this runs in CI without either.
//
// electron-app has no permission-approval UI/IPC wired up yet (neither for
// this path nor for the pre-existing local-tools path — see
// `AcpAgentHost.respondToPermission`/`VercelAgentService.respondToPermission`,
// both currently uncalled from any IPC handler), so the fixture's
// `WITH_PERMISSION` marker — and the real `session/request_permission`
// round-trip it exercises — is verified separately via `AcpClientWrapper`
// directly, not through this app's `ai:delegate` IPC.

import * as path from 'node:path';
import { execSync } from 'node:child_process';
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

/** Configures a CLI-agent provider's executable path, matching what the Settings UI's "CLI path" field writes. */
async function configureCliProvider(win: TestApp['window'], provider: string, cliPath: string): Promise<void> {
  await win.evaluate(
    async ({ provider, cliPath }) => {
      const w = window as unknown as {
        ticketManager: {
          settings: { set: (patch: { ai: { providers: Record<string, { cliPath: string }> } }) => Promise<unknown> };
        };
      };
      await w.ticketManager.settings.set({ ai: { providers: { [provider]: { cliPath } } } });
    },
    { provider, cliPath }
  );
}

async function delegate(win: TestApp['window'], issueKey: string, provider: string, goal: string): Promise<void> {
  await win.evaluate(
    async ({ issueKey, provider, goal }) => {
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
        provider,
        task: { goal, maxSteps: 3, timeoutMs: 30000 }
      });
    },
    { issueKey, provider, goal }
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

test('delegate completes a session against a real ACP agent subprocess', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-202', 'claude-code-cli', 'Say hello via ACP');

  await expect.poll(async () => (await readSession(win, 'APP-202'))?.state, { timeout: 15000 }).toBe('completed');

  const session = await readSession(win, 'APP-202');
  expect(session?.responseText).toContain('Hello from the fake ACP agent');
});

test('abort kills the ACP agent subprocess cleanly', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-201', 'claude-code-cli', 'HANG_UNTIL_CANCELLED please');

  // The fixture holds the turn open, so the session stays non-terminal…
  await expect
    .poll(async () => (await readSession(win, 'APP-201'))?.state, { timeout: 10000 })
    .not.toBe('completed');

  // …and the subprocess is really running.
  const psBefore = execSync('ps aux').toString();
  expect(psBefore).toContain('fakeAcpAgent.mjs');

  await win.evaluate(async issueKey => {
    const w = window as unknown as { ticketManager: { ai: { abort: (issueKey: string) => Promise<void> } } };
    await w.ticketManager.ai.abort(issueKey);
  }, 'APP-201');

  await expect.poll(async () => (await readSession(win, 'APP-201'))?.state, { timeout: 10000 }).toBe('aborted');

  // No orphaned subprocess left behind.
  await expect
    .poll(() => execSync('ps aux').toString().includes('fakeAcpAgent.mjs'), { timeout: 10000 })
    .toBe(false);
});
