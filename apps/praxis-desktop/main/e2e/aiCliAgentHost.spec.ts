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
        praxis: {
          settings: { set: (patch: { ai: { providers: Record<string, { cliPath: string }> } }) => Promise<unknown> };
        };
      };
      await w.praxis.settings.set({ ai: { providers: { [provider]: { cliPath } } } });
    },
    { provider, cliPath }
  );
}

async function delegate(
  win: TestApp['window'],
  issueKey: string,
  provider: string,
  goal: string,
  model?: string
): Promise<void> {
  await win.evaluate(
    async ({ issueKey, provider, goal, model }) => {
      const w = window as unknown as {
        praxis: {
          ai: {
            delegate: (input: {
              issueKey: string;
              provider: string;
              model?: string;
              task: { goal: string; maxSteps: number; timeoutMs: number };
            }) => Promise<unknown>;
          };
        };
      };
      await w.praxis.ai.delegate({
        issueKey,
        provider,
        model,
        task: { goal, maxSteps: 3, timeoutMs: 30000 }
      });
    },
    { issueKey, provider, goal, model }
  );
}

async function listCliModelOptions(
  win: TestApp['window'],
  provider: string
): Promise<{ currentValue: string; options: Array<{ value: string; name: string }> } | undefined> {
  return win.evaluate(async provider => {
    const w = window as unknown as {
      praxis: {
        ai: {
          listCliModelOptions: (
            provider: string
          ) => Promise<{ currentValue: string; options: Array<{ value: string; name: string }> } | undefined>;
        };
      };
    };
    return w.praxis.ai.listCliModelOptions(provider);
  }, provider);
}

async function readSession(
  win: TestApp['window'],
  issueKey: string
): Promise<{
  state: string;
  responseText?: string;
  workingDirectory?: string;
  toolMode?: string;
  runtimeSessionId?: string;
} | undefined> {
  return win.evaluate(async issueKey => {
    const w = window as unknown as {
      praxis: {
        ai: { listSessions: () => Promise<Array<{
          issueKey: string;
          state: string;
          responseText?: string;
          workingDirectory?: string;
          toolMode?: string;
          runtimeSessionId?: string;
        }>> };
      };
    };
    const sessions = await w.praxis.ai.listSessions();
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
  expect(session?.workingDirectory).toBeTruthy();
  expect(session?.toolMode).toBe('full');
  expect(session?.runtimeSessionId).toBeTruthy();

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-202' }).click();
  await win.locator('[data-testid="session-follow-up-input"]').fill('Explain that result.');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('Explain that result.');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText(
    'Hello from the fake ACP agent'
  );
});

test('an ACP diff tool call renders as a red/green diff in the console', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-203', 'claude-code-cli', 'WITH_DIFF please edit notes.md');
  await expect.poll(async () => (await readSession(win, 'APP-203'))?.state, { timeout: 15000 }).toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-203' }).click();

  const diff = win.locator('[data-testid="session-tool-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.diff-add')).toContainText('second line added by the agent');
});

test('ticket-selected Claude Code runs review and analysis without using Vercel', async () => {
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    FROSTY_VERCEL_API_KEY: undefined
  });
  const win = app.window;
  await win.evaluate(
    async ({ cliPath }) => {
      await window.praxis.settings.set({
        ai: {
          activeProvider: 'vercel-gateway',
          analysisPrompt: 'Assess this ticket carefully.',
          analysisGateEnabled: true,
          providers: { 'claude-code-cli': { cliPath } }
        }
      });
    },
    { cliPath: FIXTURE_PATH }
  );
  await win.reload();
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('[data-testid="board-nav-item"]').first().click();
  await win.locator('[data-testid="issue-card"]').first().click();
  const provider = win.locator('[data-testid="issue-detail-ai-provider"]');
  await provider.selectOption('claude-code-cli');

  await win.locator('[data-testid="issue-ai-review-btn"]').click();
  await expect(win.locator('[data-testid="review-runtime"]')).toContainText('claude-code-cli');
  await win.locator('[data-testid="ai-review-run"]').click();
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText(
    'Hello from the fake ACP agent',
    { timeout: 15000 }
  );
  await win.locator('[aria-label="Close review"]').click();

  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-provider"]')).toContainText('Claude Code');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText(
    'Hello from the fake ACP agent',
    { timeout: 15000 }
  );
  await expect(win.locator('[data-testid="session-analysis-confirm"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-tool-mode"]')).toContainText('Read only');
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
    const w = window as unknown as { praxis: { ai: { abort: (issueKey: string) => Promise<void> } } };
    await w.praxis.ai.abort(issueKey);
  }, 'APP-201');

  await expect.poll(async () => (await readSession(win, 'APP-201'))?.state, { timeout: 10000 }).toBe('aborted');

  // No orphaned subprocess left behind.
  await expect
    .poll(() => execSync('ps aux').toString().includes('fakeAcpAgent.mjs'), { timeout: 10000 })
    .toBe(false);
});

test('listCliModelOptions reads the real model list from session/new', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  const options = await listCliModelOptions(win, 'claude-code-cli');
  expect(options?.currentValue).toBe('fake-default');
  expect(options?.options.map(o => o.value)).toEqual(['fake-default', 'fake-fast']);
});

test('delegating with a model override applies it via session/set_config_option', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-203', 'claude-code-cli', 'Say hello with a specific model', 'fake-fast');

  await expect.poll(async () => (await readSession(win, 'APP-203'))?.state, { timeout: 15000 }).toBe('completed');

  const session = await readSession(win, 'APP-203');
  expect(session?.responseText).toContain('model=fake-fast');
});
