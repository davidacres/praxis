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
import * as fs from 'node:fs';
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
  runtimeLaunch?: { adapter: string; transport: string; hostId?: string; command?: string };
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

test('an Agent Hub ACP binding launches its declared host entry point', async () => {
  app = await launchTestApp();
  const win = app.window;
  const hostRoot = path.join(app.userDataDir, 'agents', 'bound-acp-host');
  const profileRoot = path.join(app.userDataDir, 'profiles', 'bound-profile');
  fs.mkdirSync(hostRoot, { recursive: true });
  fs.mkdirSync(profileRoot, { recursive: true });
  fs.writeFileSync(
    path.join(hostRoot, 'agent.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'bound-acp-host',
      name: 'Bound ACP Host',
      type: 'acp',
      entry: { command: process.execPath, args: [FIXTURE_PATH] }
    })
  );
  fs.writeFileSync(
    path.join(profileRoot, 'AGENT.md'),
    '---\nid: bound-profile\nname: Bound Profile\n---\nUse the declared host transport.\n'
  );
  // If the old provider-only route is still used, this deliberately invalid
  // provider command fails. The selected host entry is the only valid route.
  await configureCliProvider(win, 'claude-code-cli', '/definitely/not-the-selected-host');
  await win.evaluate(async () => window.praxis.agentRuntime.refresh());
  await win.evaluate(async () => {
    const w = window as unknown as {
      praxis: { ai: { delegate: (input: Record<string, unknown>) => Promise<unknown> } };
    };
    await w.praxis.ai.delegate({
      issueKey: 'APP-214',
      provider: 'claude-code-cli',
      profileId: 'bound-profile',
      hostId: 'bound-acp-host',
      task: { goal: 'Prove the selected Agent Hub host is the session transport.', maxSteps: 3, timeoutMs: 30000 }
    });
  });
  await expect.poll(async () => (await readSession(win, 'APP-214'))?.state, { timeout: 15000 }).toBe('completed');
  const session = await readSession(win, 'APP-214');
  expect(session?.responseText).toContain('Hello from the fake ACP agent');
  expect(session?.runtimeLaunch).toMatchObject({
    adapter: 'acp',
    transport: 'acp',
    hostId: 'bound-acp-host',
    command: process.execPath
  });
});

test('ACP resume replay does not duplicate the previous answer into a follow-up', async () => {
  app = await launchTestApp(undefined, undefined, { FAKE_ACP_REPLAY_ON_RESUME: '1' });
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-212', 'claude-code-cli', 'Give the original response.');
  await expect.poll(async () => (await readSession(win, 'APP-212'))?.state, { timeout: 15000 }).toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-212' }).click();
  await win.locator('[data-testid="session-follow-up-input"]').fill('DISTINCT_FOLLOW_UP answer only this question.');
  await win.locator('[data-testid="session-follow-up-send"]').click();

  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('DISTINCT_FOLLOW_UP');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  const replies = win.locator('[data-testid="session-chat-assistant"]');
  await expect(replies).toHaveCount(2);
  await expect(replies.last()).toContainText('Fresh response to the current question.');
  await expect(replies.last()).not.toContainText('replayed');
  const session = await readSession(win, 'APP-212');
  expect(session?.responseText).toBe('Fresh response to the current question.');
});

test('a pasted image reaches an ACP agent as an image content block', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-215', 'claude-code-cli', 'Start of the conversation.');
  await expect.poll(async () => (await readSession(win, 'APP-215'))?.state, { timeout: 15000 }).toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-215' }).click();
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await input.waitFor();

  // Paste a real (decodable) 2x2 PNG into the composer, then send with text.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  await input.evaluate((node, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    (node as HTMLTextAreaElement).focus();
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pngBase64);
  await expect(win.locator('[data-testid="session-image-chip"]')).toBeVisible();

  await input.fill('IMAGE_ECHO describe this image.');
  await win.locator('[data-testid="session-follow-up-send"]').click();

  // The fixture reports the image blocks it actually received over the ACP wire.
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText('IMAGES_RECEIVED:1:image/png');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
});

test('an ACP diff tool call renders as a red/green diff in the console', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-203', 'claude-code-cli', 'WITH_DIFF please edit notes.md');
  await expect.poll(async () => (await readSession(win, 'APP-203'))?.state, { timeout: 15000 }).toBe('completed');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-203' }).click();

  // The grouped completion gadget keeps the diff behind one selected-run
  // detail surface rather than duplicating a transcript disclosure.
  await win.locator('[data-testid="session-tab-activity"]').click();
  await win.locator('[data-testid="tool-completion-gadget"] [data-testid="tool-completion-item"]').first().click();
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

test('an in-flight turn shows one live status line, not streamed tool blocks', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-206', 'claude-code-cli', 'HANG_UNTIL_CANCELLED please');
  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]', { hasText: 'APP-206' }).click();

  const status = win.locator('[data-testid="session-activity-status"]');
  await expect(status).toBeVisible({ timeout: 10000 });
  await expect(status).toContainText(/Working…|Thinking…|Planning…|Running/);

  await win.evaluate(async issueKey => {
    const w = window as unknown as { praxis: { ai: { abort: (issueKey: string) => Promise<void> } } };
    await w.praxis.ai.abort(issueKey);
  }, 'APP-206');
  // Once the turn ends the status line is gone.
  await expect(status).toHaveCount(0, { timeout: 10000 });
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
