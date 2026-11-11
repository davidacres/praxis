// e2e coverage for the `copilot-cli` provider specifically. GitHub Copilot
// used to have its own bespoke `hostKind: 'copilot-sdk'` path through
// `@github/copilot-sdk` (`packages/core/src/ai/copilot/`, now deleted).
// Live testing against a real `copilot --acp` process confirmed it speaks
// standard ACP — including reporting its model list via a `model`-category
// `session/new` config option, the same shape Claude Code/Codex report — so
// Copilot was migrated onto the shared `AcpAgentHost` path used by
// `aiCliAgentHost.spec.ts`, and this spec now exists only to prove that
// migration holds for the `copilot-cli` provider id specifically (correct
// descriptor wiring, `--acp` default arg, model listing, delegate/abort),
// reusing the same real ACP fixture (`fixtures/fakeAcpAgent.mjs`) rather than
// a Copilot-specific fake runtime.

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
): Promise<{ state: string; responseText?: string; runtimeSessionId?: string } | undefined> {
  return win.evaluate(async issueKey => {
    const w = window as unknown as {
      praxis: {
        ai: {
          listSessions: () => Promise<
            Array<{ issueKey: string; state: string; responseText?: string; runtimeSessionId?: string }>
          >;
        };
      };
    };
    const sessions = await w.praxis.ai.listSessions();
    return sessions.find(s => s.issueKey === issueKey);
  }, issueKey);
}

test('copilot-cli delegates over ACP just like the other CLI-hosted agents', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'copilot-cli', FIXTURE_PATH);

  await delegate(win, 'APP-210', 'copilot-cli', 'Say hello via ACP');

  await expect.poll(async () => (await readSession(win, 'APP-210'))?.state, { timeout: 15000 }).toBe('completed');

  const session = await readSession(win, 'APP-210');
  expect(session?.responseText).toContain('Hello from the fake ACP agent');
  expect(session?.runtimeSessionId).toBeTruthy();
});

test('copilot-cli reports its model list via session/new, same as Claude/Codex', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'copilot-cli', FIXTURE_PATH);

  const options = await listCliModelOptions(win, 'copilot-cli');
  expect(options?.currentValue).toBe('fake-default');
  expect(options?.options.map(o => o.value)).toEqual(['fake-default', 'fake-fast']);
});

test('abort kills the copilot-cli subprocess cleanly', async () => {
  app = await launchTestApp();
  const win = app.window;
  await configureCliProvider(win, 'copilot-cli', FIXTURE_PATH);

  await delegate(win, 'APP-211', 'copilot-cli', 'HANG_UNTIL_CANCELLED please');

  await expect
    .poll(async () => (await readSession(win, 'APP-211'))?.state, { timeout: 10000 })
    .not.toBe('completed');

  const psBefore = execSync('ps aux').toString();
  expect(psBefore).toContain('fakeAcpAgent.mjs');

  await win.evaluate(async issueKey => {
    const w = window as unknown as { praxis: { ai: { abort: (issueKey: string) => Promise<void> } } };
    await w.praxis.ai.abort(issueKey);
  }, 'APP-211');

  await expect.poll(async () => (await readSession(win, 'APP-211'))?.state, { timeout: 10000 }).toBe('aborted');

  await expect
    .poll(() => execSync('ps aux').toString().includes('fakeAcpAgent.mjs'), { timeout: 10000 })
    .toBe(false);
});
