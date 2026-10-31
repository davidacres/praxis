import { openSession } from './sessionNavigation';
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
import { chooseOption } from './chipSelect';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;
let replayTraceApp: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    if (test.info().status !== test.info().expectedStatus && !app.window.isClosed()) {
      const diagnostics = await app.window.evaluate(async () => ({
        sessions: await window.praxis.ai.listSessions(),
        logs: await window.praxis.log.getRecent()
      }));
      await test.info().attach('acp-state-and-logs', {
        body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json'
      });
    }
    if (replayTraceApp === app) {
      const failed = test.info().status !== test.info().expectedStatus;
      const tracePath = failed ? test.info().outputPath('acp-replay-trace.zip') : undefined;
      await app.electronApp.context().tracing.stop({ path: tracePath });
      if (tracePath) await test.info().attach('acp-replay-trace', { path: tracePath, contentType: 'application/zip' });
      replayTraceApp = undefined;
    }
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

  await openSession(win, 'APP-202');
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

test('ACP read-only permission denial survives neutral titles, missing kinds and allow-only wire options', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      issueKey: 'APP-202',
      provider: 'claude-code-cli',
      toolMode: 'read-only',
      permissionMode: 'auto',
      autoApprovePermissions: true,
      workingDirectory: '/private/tmp',
      task: { goal: 'PERMISSION_KIND_MATRIX', maxSteps: 20, timeoutMs: 15000 }
    });
  });
  await expect.poll(async () => (await readSession(win, 'APP-202'))?.state).toBe('completed');
  const session = await readSession(win, 'APP-202');
  expect(session?.toolMode).toBe('read-only');
  const outcomes = JSON.parse(session?.responseText ?? '[]') as Array<{ kind: string; outcome: string; optionId?: string }>;
  expect(outcomes).toHaveLength(8);
  for (const result of outcomes) {
    if (result.kind === 'read' || result.kind === 'search') {
      expect(result).toMatchObject({ outcome: 'selected', optionId: 'allow' });
    } else {
      expect(result.outcome).toBe('cancelled');
    }
  }
  await openSession(win, 'APP-202');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed');
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

test('a CLI-hosted turn shows the agent\'s thought in a collapsed Thought block', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-213', 'claude-code-cli', 'EMIT_THOUGHT then answer.');
  await expect.poll(async () => (await readSession(win, 'APP-213'))?.state, { timeout: 15000 }).toBe('completed');

  await openSession(win, 'APP-213');
  const thought = win.locator('[data-testid="session-thought-disclosure"]');
  await expect(thought).toHaveCount(1);
  // Collapsed by default, with the streamed chunks joined into one thought.
  await expect(thought).not.toHaveAttribute('open', '');
  await thought.getByTestId('session-thought-summary').click();
  await expect(thought.locator('[data-testid="session-thought-markdown"]')).toContainText('Checking the ACP thought path.');
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toHaveCount(1);
});

test('Codex CLI ACP updates appear as Activity with the latest update in the summary', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'codex-cli', FIXTURE_PATH);

  await delegate(win, 'APP-216', 'codex-cli', 'EMIT_CODEX_ACTIVITY then answer.');
  await expect.poll(async () => (await readSession(win, 'APP-216'))?.state, { timeout: 15000 }).toBe('completed');

  await openSession(win, 'APP-216');
  const activity = win.locator('[data-testid="session-activity-disclosure"]');
  await expect(activity).toHaveCount(1);
  await expect(activity).not.toHaveAttribute('open', '');
  await expect(activity.getByTestId('session-activity-summary')).toContainText('Activity');
  await expect(activity.getByTestId('session-activity-summary')).toContainText('Building project switcher');
  await activity.getByTestId('session-activity-summary').click();
  await expect(activity.getByTestId('session-activity-update')).toHaveCount(2);
  await expect(activity.getByTestId('session-activity-history')).toContainText('Inspecting project picker');
  await activity.screenshot({ path: test.info().outputPath('codex-activity.png') });
  await expect(win.locator('[data-testid="session-thought-disclosure"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toHaveCount(1);
});

test('MCP servers the user added reach a CLI agent at session start', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);
  await win.evaluate(async () => {
    await window.praxis.settings.set({
      ai: {
        mcpServers: [
          { id: 'remote-1', name: 'Docs Search', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' }, requireApproval: true },
          { id: 'local-1', name: 'Files', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'some-server', '/tmp'], env: { TOKEN: 'secret' }, requireApproval: true },
          { id: 'off-1', name: 'Switched Off', enabled: false, transport: 'stdio', command: 'nope', requireApproval: true }
        ]
      }
    });
  });

  await delegate(win, 'APP-214', 'claude-code-cli', 'ECHO_MCP_SERVERS please.');
  await expect.poll(async () => (await readSession(win, 'APP-214'))?.state, { timeout: 15000 }).toBe('completed');

  const reply = (await readSession(win, 'APP-214'))?.responseText ?? '';
  const received = JSON.parse(reply.slice(reply.indexOf('MCP_SERVERS:') + 'MCP_SERVERS:'.length)) as Array<Record<string, unknown>>;
  const byName = Object.fromEntries(received.map(server => [server.name as string, server]));
  // Names are slugged the way tool names are; a switched-off server is not sent.
  // praxis-coordination is Praxis's own: a full-tools session can see and claim what other sessions hold (FX-BF-048).
  // Code and knowledge tools are also built in when the local service runtime is
  // installed. Their presence must not make this user-added-server test host-dependent.
  expect(Object.keys(byName).filter(name => name !== 'code_intelligence').sort()).toEqual(['docs_search', 'files', 'praxis-coordination', 'praxis-tracker']);
  expect(byName.docs_search).toMatchObject({
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer abc' }]
  });
  expect(byName.files).toMatchObject({
    command: 'npx',
    args: ['-y', 'some-server', '/tmp'],
    env: [{ name: 'TOKEN', value: 'secret' }]
  });
  await openSession(win, 'APP-214');
  await expect(win.getByTestId('session-chat-assistant').last()).toContainText('MCP_SERVERS:');
  await win.screenshot({ path: test.info().outputPath('mcp-session.png') });
});

test('ACP resume replay does not duplicate the previous answer into a follow-up', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, { FAKE_ACP_REPLAY_ON_RESUME: '1' });
  await app.electronApp.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  replayTraceApp = app;
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-212', 'claude-code-cli', 'Give the original response.');
  await expect.poll(async () => (await readSession(win, 'APP-212'))?.state, { timeout: 15000 }).toBe('completed');

  await openSession(win, 'APP-212');
  // Keep launch-phase evidence for the CI-only stall without changing its timing or assertions.
  await app.electronApp.evaluate((_electron, modulePaths) => {
    const require = process.getBuiltinModule('module')!.createRequire(modulePaths.log);
    const log = require(modulePaths.log).getLogBus();
    const observe = (target: Record<string, any>, name: string) => {
      const original = target[name].bind(target);
      target[name] = async (...args: unknown[]) => {
        const started = Date.now();
        log.appendLine(`[e2e:ACP follow-up] ${name} started`);
        try {
          return await original(...args);
        } finally {
          log.appendLine(`[e2e:ACP follow-up] ${name} finished after ${Date.now() - started}ms`);
        }
      };
    };
    observe(require(modulePaths.launch), 'preparePersistedAgentLaunch');
    observe(require(modulePaths.instructions), 'sessionInstructionsFor');
    observe(require(modulePaths.browser), 'browserMcpServerForSession');
    observe(require(modulePaths.tracker), 'trackerMcpServerForSession');
    const host = require(modulePaths.host).getAcpAgentHost();
    observe(host, 'continueTask');
    observe(host, 'cleanupTask');
  }, {
    log: require.resolve('../out/main/logBusInstance'),
    launch: require.resolve('../out/main/agentSessionLauncher'),
    instructions: require.resolve('../out/main/nativeSourcesInstance'),
    browser: require.resolve('../out/main/browserMcp'),
    tracker: require.resolve('../out/main/trackerMcp'),
    host: require.resolve('../out/main/aiInstance')
  });
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await expect(input).toBeEnabled({ timeout: 15000 });
  await input.fill('DISTINCT_FOLLOW_UP answer only this question.');
  await win.locator('[data-testid="session-follow-up-send"]').click();

  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('DISTINCT_FOLLOW_UP');
  const replies = win.locator('[data-testid="session-chat-assistant"]');
  await expect(replies).toHaveCount(2, { timeout: 30000 });
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 30000 });
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

  await openSession(win, 'APP-215');
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
  const project = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create({ name: 'CLI ticket review', key: 'CLI', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      starterTickets: [{ summary: 'Review a CLI ticket', description: 'Check this ticket.', issueType: 'Task', status: 'Todo' }],
      workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], defaultAiToolMode: 'read-only' }, workspace.id);
  });
  await win.reload();
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill(project.name);
  await palette.getByRole('option').filter({ hasText: project.name }).filter({ hasText: 'Board' }).click();
  await win.locator('[data-testid="issue-card"]').first().click();
  const provider = win.locator('[data-testid="issue-detail-ai-provider"]');
  await chooseOption(provider, 'claude-code-cli');

  await win.locator('[data-testid="issue-ai-review-btn"]').click();
  await expect(win.locator('[data-testid="review-runtime"]')).toContainText('claude-code-cli');
  await win.locator('[data-testid="ai-review-run"]').click();
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText(
    'Hello from the fake ACP agent',
    { timeout: 15000 }
  );
  await win.locator('[aria-label="Close review"]').click();

  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  await expect(win.locator('[data-testid="agent-details-page"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-provider"]')).toContainText('Claude Code');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText(
    'Hello from the fake ACP agent',
    { timeout: 15000 }
  );
  await expect(win.locator('[data-testid="session-analysis-confirm"]')).toBeVisible();
  await win.screenshot({ path: '../.praxis/session-artifacts/session-analysis-confirm-verified.png' });
  await expect(win.locator('[data-testid="session-tool-mode"]')).toContainText('Read only');
  await win.getByTestId('session-analysis-confirm').click();
  await expect(win.getByTestId('session-chat-thread')).toContainText('I confirm the analysis and implementation plan.');
  await expect(win.getByTestId('session-analysis-banner')).toContainText('Analysis confirmed');
});

test('an in-flight turn shows one live status line, not streamed tool blocks', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-206', 'claude-code-cli', 'HANG_UNTIL_CANCELLED please');
  await openSession(win, 'APP-206');

  const status = win.getByTestId('session-composer-activity-chip');
  await expect(win.getByTestId('session-activity-status')).toHaveCount(0);
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

test('ACP model menus show context sizes and published pricing for model aliases', async () => {
  const codexHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'praxis-codex-menu-'));
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'fake-fast', context_window: 272000, max_context_window: 872000 },
    { slug: 'fake-default', context_window: 272000 }
  ] }));
  try {
    app = await launchTestApp(undefined, undefined, { CODEX_HOME: codexHome, PRAXIS_FAKE_ACP_MODEL_CHOICES: JSON.stringify([
      { value: 'fake-default', name: 'Opus 5.5' }, { value: 'fake-fast', name: 'Sonnet 5.5' },
      { value: 'claude-opus-5-5', name: 'Claude Opus 5.5 — extended reasoning and large repository work' }
    ]) });
    const win = app.window;
    await configureCliProvider(win, 'codex-cli', FIXTURE_PATH);
    await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);
    await win.reload();
    await win.getByTestId('new-session-provider-chip').click();
    await win.getByTestId('new-session-provider-option-codex-cli').click();
    await win.getByTestId('new-session-model-chip').click();
    const fast = win.getByTestId('new-session-model-option-fake-fast');
    await expect(fast).toContainText('272k');
    await expect(fast).toContainText('$2.00 / $10.00 /1M');
    await expect(fast).not.toContainText('API base');
    await expect(fast.locator('.is-cost')).toHaveAttribute('title', /API reference rates/);
    await expect(win.getByTestId('new-session-model-option-default')).toContainText('272k');
    await expect(win.getByTestId('new-session-model-option-default')).toContainText('$4.00 / $20.00 /1M');
    const menu = win.getByRole('listbox', { name: 'Model', exact: true });
    expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(600);
    const longName = win.getByTestId('new-session-model-option-claude-opus-5-5').locator('.composer-model-option-name');
    expect(await longName.evaluate(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).whiteSpace !== 'nowrap')).toBe(true);
    const columns = await menu.locator('[role="option"]').evaluateAll(rows => rows.map(row => ({
      context: row.querySelector('.is-context')?.getBoundingClientRect().left,
      price: row.querySelector('.is-cost')?.getBoundingClientRect().left
    })));
    expect(columns.every(row => row.context === columns[0].context && row.price === columns[0].price)).toBe(true);
    await win.screenshot({ path: test.info().outputPath('codex-model-metadata.png') });
    await fast.click();
    await win.getByTestId('new-session-provider-chip').click();
    await win.getByTestId('new-session-provider-option-claude-code-cli').click();
    await win.getByTestId('new-session-model-chip').click();
    await expect(fast).toContainText('1M');
    await expect(fast).toContainText('$2.00 / $10.00 /1M');
    await expect(win.getByTestId('new-session-model-option-default')).toContainText('1M');
    await fast.click();
    await win.setViewportSize({ width: 800, height: 700 });
    await win.getByTestId('new-session-model-chip').click();
    const bounded = (await menu.boundingBox())!;
    expect(bounded.x).toBeGreaterThanOrEqual(12);
    expect(bounded.x + bounded.width).toBeLessThanOrEqual(788);
    expect(bounded.y).toBeGreaterThanOrEqual(12);
    expect(bounded.y + bounded.height).toBeLessThanOrEqual(688);
    await win.screenshot({ path: test.info().outputPath('model-menu-window-boundaries.png') });
    await fast.click();
    await delegate(win, 'APP-203', 'claude-code-cli', 'Say hello', 'fake-fast');
    await expect.poll(async () => (await readSession(win, 'APP-203'))?.state, { timeout: 15000 }).toBe('completed');
    await openSession(win, 'APP-203');
    await win.getByTestId('session-model').click();
    const sessionMenu = win.getByTestId('session-model-menu');
    expect((await sessionMenu.boundingBox())!.width).toBeGreaterThanOrEqual(600);
    await expect(sessionMenu).not.toContainText('API base');
    await expect(sessionMenu.getByTestId('session-model-option-fake-fast')).toContainText('$2.00 / $10.00 /1M');
    await win.screenshot({ path: test.info().outputPath('existing-session-model-menu.png') });
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
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

test('a CLI model reasoning default applies through ACP thought_level', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);
  await win.evaluate(async () => {
    await window.praxis.settings.set({
      ai: {
        providers: {
          'claude-code-cli': {
            modelReasoningDefaults: { 'fake-fast': 'high' }
          }
        }
      }
    });
  });

  await delegate(win, 'APP-204', 'claude-code-cli', 'Use the configured reasoning default', 'fake-fast');
  await expect.poll(async () => (await readSession(win, 'APP-204'))?.state, { timeout: 15000 }).toBe('completed');

  const session = await readSession(win, 'APP-204');
  expect(session?.responseText).toContain('model=fake-fast, effort=high');
});

test('a CLI agent\'s reply shows the turn\'s time, tokens, cost and model, and the session total grows', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'claude-code-cli', FIXTURE_PATH);

  await delegate(win, 'APP-201', 'claude-code-cli', 'REPORT_USAGE please');
  await expect.poll(async () => (await readSession(win, 'APP-201'))?.state, { timeout: 15000 }).toBe('completed');

  await openSession(win, 'APP-201');
  const bar = win.locator('[data-testid="session-chat-telemetry"]').last();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1,234 tok');
  await expect(bar).toContainText('claude-sonnet-5-5');
  await expect(bar).not.toContainText('haiku');
  await expect(bar).toContainText(/\$0\.01/);
  const artifacts = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
  await win.screenshot({ path: path.join(artifacts, 'acp-reply-telemetry.png'), fullPage: true });

  const tokens = () => win.evaluate(async () => {
    const w = window as unknown as { praxis: { ai: { listSessions: () => Promise<Array<{ issueKey: string; tokenUsage?: { totalTokens?: number }; contextTokens?: number }>> } } };
    const sessions = await w.praxis.ai.listSessions();
    const found = sessions.find(s => s.issueKey === 'APP-201');
    return { total: found?.tokenUsage?.totalTokens, context: found?.contextTokens };
  });
  expect(await tokens()).toEqual({ total: 1234, context: 1500 });

  await win.locator('[data-testid="session-follow-up-input"]').fill('REPORT_USAGE again');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await expect(win.locator('[data-testid="session-chat-telemetry"]')).toHaveCount(2);
  // Tokens add up per turn; the window's occupancy stays what the agent said it is.
  expect(await tokens()).toEqual({ total: 2468, context: 1500 });
});


test('custom activity words persist and replace composer narration during a Codex turn', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'codex-cli', FIXTURE_PATH);
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-tab-behaviour').click();
  const words = win.getByRole('textbox', { name: 'Session activity words', exact: true });
  await expect(words).toHaveValue('Thinking, Working, Pondering');
  await words.fill('Musing, Tinkering');
  await expect.poll(() => win.evaluate(async () => (await window.praxis.settings.get()).ai.activityWords))
    .toEqual(['Musing', 'Tinkering']);
  await win.getByTestId('ai-tab-providers').click();
  await win.getByTestId('ai-tab-behaviour').click();
  await expect(words).toHaveValue('Musing, Tinkering');
  await win.getByTestId('ai-tabpanel-behaviour').screenshot({ path: path.resolve('../../../.praxis/session-artifacts/activity-words-settings.png') });
  await win.getByRole('button', { name: 'Close settings', exact: true }).click();
  await delegate(win, 'APP-219', 'codex-cli', 'EMIT_CODEX_ACTIVITY HANG_UNTIL_CANCELLED');
  await openSession(win, 'APP-219');
  const activity = win.getByTestId('session-activity-disclosure');
  await expect(activity).toHaveCount(1);
  await expect(activity).not.toHaveAttribute('open', '');
  const label = win.getByTestId('session-composer-activity-chip').locator('.session-activity-label');
  await expect(label).toHaveText('Musing…');
  await expect(label).toHaveText('Tinkering…', { timeout: 12000 });
  await activity.getByTestId('session-activity-summary').click();
  await expect(activity.getByTestId('session-activity-history')).toBeVisible();
  await activity.getByTestId('session-activity-summary').click();
  await win.screenshot({ path: path.resolve('../../../.praxis/session-artifacts/activity-words-session.png') });
  await win.evaluate(async () => { await window.praxis.ai.abort('APP-219'); });
  await expect(label).toHaveCount(0);
});
