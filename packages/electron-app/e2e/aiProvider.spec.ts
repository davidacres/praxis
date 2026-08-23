import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { startMockAnthropicServer, type MockAnthropicServer } from './mockAnthropicServer';

/**
 * Phase D — AI foundation. Covers the two halves of the desktop AI plumbing:
 *
 * 1. Provider setup UI: the Settings → AI Provider section stores the Vercel
 *    gateway API key via the OS-keychain secrets store (never the settings
 *    file) and reports the resolved status, persisting across a relaunch.
 * 2. Session plumbing against a mock gateway: `ai:delegate` starts an agent
 *    session for a demo issue, session updates stream to the renderer over
 *    the `ai:sessionChanged` push channel, and `ai:abort` stops a hung task.
 *    No live API key is needed — the mock speaks the OpenAI-compatible SSE
 *    wire protocol (`mockGatewayServer.ts`).
 *
 * AI gateway env vars are explicitly scrubbed or set per test so a developer
 * machine's real credentials can never leak in.
 */

/** Env that guarantees "no key anywhere" for the not-configured assertions. */
const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let anthropicMock: MockAnthropicServer | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (anthropicMock) {
    await anthropicMock.close();
    anthropicMock = undefined;
  }
});

async function openAiSettings(win: TestApp['window']): Promise<void> {
  await win.locator('[data-testid="nav-settings"]').click();
  await win.locator('[data-testid="settings-nav-ai"]').click();
  await win.locator('[data-testid="ai-provider-status"]').waitFor({ state: 'visible' });
}

test('AI provider settings store the API key in the keychain and persist across relaunch', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  await openAiSettings(app.window);

  await expect(app.window.locator('[data-testid="ai-provider-status"]')).toContainText(
    'Not configured'
  );

  await app.window.locator('[data-testid="ai-api-key-input"]').fill('e2e-secret-key');
  await app.window.locator('[data-testid="ai-api-key-save"]').click();
  await expect(app.window.locator('[data-testid="ai-provider-status"]')).toContainText(
    'OS keychain'
  );

  // Gateway URL + model persist as plain settings.
  await app.window.getByLabel('AI gateway URL').fill('http://gateway.example.test');
  await app.window.getByLabel('AI default model').fill('mock/model');
  await expect(app.window.getByLabel('AI gateway URL')).toHaveValue('http://gateway.example.test');

  // The key must NOT land in the plain settings file (which now exists,
  // written by the gateway URL/model commits above).
  const fs = await import('node:fs');
  await expect
    .poll(() => fs.existsSync(app!.settingsPath) && fs.readFileSync(app!.settingsPath, 'utf8'))
    .toBeTruthy();
  const settingsRaw = fs.readFileSync(app.settingsPath, 'utf8');
  expect(settingsRaw).not.toContain('e2e-secret-key');

  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, { ...NO_GATEWAY_ENV });
  await openAiSettings(app.window);

  await expect(app.window.locator('[data-testid="ai-provider-status"]')).toContainText(
    'OS keychain'
  );
  await expect(app.window.getByLabel('AI gateway URL')).toHaveValue('http://gateway.example.test');
  await expect(app.window.getByLabel('AI default model')).toHaveValue('mock/model');

  // Clear removes the key again.
  await app.window.locator('[data-testid="ai-api-key-clear"]').click();
  await expect(app.window.locator('[data-testid="ai-provider-status"]')).toContainText(
    'Not configured'
  );
});

test('delegate streams session events over the push channel and completes against the mock gateway', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // Collect push-channel updates before delegating.
  await win.evaluate(() => {
    const w = window as unknown as {
      ticketManager: {
        ai: {
          onSessionChanged: (listener: (record: { state: string }) => void) => () => void;
        };
      };
      __aiUpdates: string[];
    };
    w.__aiUpdates = [];
    w.ticketManager.ai.onSessionChanged(record => {
      w.__aiUpdates.push(record.state);
    });
  });

  const sessionId = await win.evaluate(async () => {
    const w = window as unknown as {
      ticketManager: {
        ai: {
          delegate: (input: {
            issueKey: string;
            task: { goal: string; maxSteps: number; timeoutMs: number };
          }) => Promise<{ sessionId: string }>;
        };
      };
    };
    const record = await w.ticketManager.ai.delegate({
      issueKey: 'APP-100',
      task: { goal: 'Smoke-test the desktop agent pipeline', maxSteps: 3, timeoutMs: 30000 }
    });
    return record.sessionId;
  });
  expect(sessionId).toBeTruthy();

  // The session runs to completion against the mock gateway.
  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const w = window as unknown as {
          ticketManager: {
            ai: { listSessions: () => Promise<Array<{ issueKey: string; state: string }>> };
          };
        };
        const sessions = await w.ticketManager.ai.listSessions();
        return sessions.find(s => s.issueKey === 'APP-100')?.state;
      })
    )
    .toBe('completed');

  // The push channel streamed live updates into the renderer.
  const updates = await win.evaluate(
    () => (window as unknown as { __aiUpdates: string[] }).__aiUpdates
  );
  expect(updates).toContain('planning');
  expect(updates).toContain('completed');

  // The mock saw the API key as a Bearer token on the wire.
  expect(mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests[0]!.authorization).toBe('Bearer e2e-gateway-key');
  expect(mock.requests[0]!.body).toContain('Smoke-test the desktop agent pipeline');
});

test('abort stops an in-flight session', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  const readState = () =>
    win.evaluate(async () => {
      const w = window as unknown as {
        ticketManager: {
          ai: { listSessions: () => Promise<Array<{ issueKey: string; state: string }>> };
        };
      };
      const sessions = await w.ticketManager.ai.listSessions();
      return sessions.find(s => s.issueKey === 'APP-101')?.state;
    });

  await win.evaluate(async () => {
    const w = window as unknown as {
      ticketManager: {
        ai: {
          delegate: (input: {
            issueKey: string;
            task: { goal: string; timeoutMs: number };
          }) => Promise<unknown>;
        };
      };
    };
    await w.ticketManager.ai.delegate({
      issueKey: 'APP-101',
      task: { goal: 'Hang until aborted', timeoutMs: 60000 }
    });
  });

  // The mock holding the stream open keeps the session in-flight…
  await expect.poll(readState).not.toBe('completed');

  await win.evaluate(async () => {
    const w = window as unknown as {
      ticketManager: { ai: { abort: (issueKey: string) => Promise<void> } };
    };
    await w.ticketManager.ai.abort('APP-101');
  });

  await expect.poll(readState).toBe('aborted');
});

/** Configures one provider's base URL (as settings) and API key (as a keychain secret), matching how the Settings UI does it. */
async function configureProvider(
  win: TestApp['window'],
  provider: 'openai' | 'anthropic',
  baseUrl: string,
  apiKey: string
): Promise<void> {
  await win.evaluate(
    async ({ provider, baseUrl, apiKey }) => {
      const w = window as unknown as {
        ticketManager: {
          settings: {
            set: (patch: {
              ai: { providers: Record<string, { baseUrl: string }> };
            }) => Promise<unknown>;
          };
          ai: { setProviderApiKey: (provider: string, value: string) => Promise<unknown> };
        };
      };
      await w.ticketManager.settings.set({ ai: { providers: { [provider]: { baseUrl } } } });
      await w.ticketManager.ai.setProviderApiKey(provider, apiKey);
    },
    { provider, baseUrl, apiKey }
  );
}

test('delegate completes against an OpenAI-provider mock (same wire format as Vercel)', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await configureProvider(win, 'openai', mock.baseUrl, 'e2e-openai-key');

  await win.evaluate(async () => {
    const w = window as unknown as {
      ticketManager: {
        ai: {
          delegate: (input: {
            issueKey: string;
            provider: string;
            task: { goal: string; maxSteps: number; timeoutMs: number };
          }) => Promise<{ sessionId: string }>;
        };
      };
    };
    await w.ticketManager.ai.delegate({
      issueKey: 'APP-102',
      provider: 'openai',
      task: { goal: 'Smoke-test the OpenAI provider', maxSteps: 3, timeoutMs: 30000 }
    });
  });

  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const w = window as unknown as {
          ticketManager: {
            ai: { listSessions: () => Promise<Array<{ issueKey: string; state: string }>> };
          };
        };
        const sessions = await w.ticketManager.ai.listSessions();
        return sessions.find(s => s.issueKey === 'APP-102')?.state;
      })
    )
    .toBe('completed');

  expect(mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests[0]!.authorization).toBe('Bearer e2e-openai-key');
});

test('delegate completes against an Anthropic-provider mock (Messages API wire format)', async () => {
  anthropicMock = await startMockAnthropicServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await configureProvider(win, 'anthropic', anthropicMock.baseUrl, 'e2e-anthropic-key');

  await win.evaluate(async () => {
    const w = window as unknown as {
      ticketManager: {
        ai: {
          delegate: (input: {
            issueKey: string;
            provider: string;
            task: { goal: string; maxSteps: number; timeoutMs: number };
          }) => Promise<{ sessionId: string }>;
        };
      };
    };
    await w.ticketManager.ai.delegate({
      issueKey: 'APP-103',
      provider: 'anthropic',
      task: { goal: 'Smoke-test the Anthropic provider', maxSteps: 3, timeoutMs: 30000 }
    });
  });

  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const w = window as unknown as {
          ticketManager: {
            ai: { listSessions: () => Promise<Array<{ issueKey: string; state: string }>> };
          };
        };
        const sessions = await w.ticketManager.ai.listSessions();
        return sessions.find(s => s.issueKey === 'APP-103')?.state;
      })
    )
    .toBe('completed');

  expect(anthropicMock.requests.length).toBeGreaterThan(0);
  expect(anthropicMock.requests[0]!.apiKey).toBe('e2e-anthropic-key');
  expect(anthropicMock.requests[0]!.anthropicVersion).toBe('2023-06-01');
  // Anthropic's request shape carries the system prompt as a top-level field, not a message.
  const parsedBody = JSON.parse(anthropicMock.requests[0]!.body) as { system?: string; messages: unknown[] };
  expect(parsedBody.system).toBeTruthy();
});

test('the New Session composer lists configured providers and can start a session on a non-default one', async () => {
  anthropicMock = await startMockAnthropicServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await configureProvider(win, 'anthropic', anthropicMock.baseUrl, 'e2e-anthropic-key');
  // Reload so the composer's provider list picks up the freshly-configured provider.
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');

  await win.locator('[data-testid="new-session-provider-chip"]').click();
  await win.locator('[data-testid="new-session-provider-option-anthropic"]').click();

  const composer = win.locator('[data-testid="new-session-view"] textarea');
  await composer.fill('Try the composer provider picker');
  await win.locator('[data-testid="new-session-submit"]').click();

  await expect
    .poll(async () =>
      win.evaluate(async () => {
        const w = window as unknown as {
          ticketManager: {
            ai: {
              listSessions: () => Promise<Array<{ state: string; issueKey: string }>>;
            };
          };
        };
        const sessions = await w.ticketManager.ai.listSessions();
        return sessions.find(s => s.issueKey.startsWith('SESSION-'))?.state;
      })
    )
    .toBe('completed');

  expect(anthropicMock.requests.length).toBeGreaterThan(0);
});
