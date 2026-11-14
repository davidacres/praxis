// SPDX-License-Identifier: MIT
//
// Codex reports a dropped model stream as reply text and still ends the turn normally. The
// session must read as failed with a plain-language reason, keep the partial reply, keep the
// raw transport error out of the assistant bubble, and still accept a follow-up to retry.
// The fake ACP agent stands in for Codex and sends Codex's exact wording.

import * as path from 'node:path';
import { openFromPalette } from './navigation';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('a CLI agent whose model stream dropped fails the turn with a clear reason', async () => {
  app = await launchTestApp({
    ai: {
      providers: {
        'codex-cli': { cliPath: path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs') },
        'claude-code-cli': { enabled: false },
        'copilot-cli': { enabled: false },
        'antigravity-cli': { enabled: false },
        'cursor-cli': { enabled: false }
      }
    }
  });
  const win = app.window;
  await win.evaluate(() => window.praxis.ai.delegate({
    provider: 'codex-cli',
    task: { goal: 'Execute STREAM_DISCONNECT test' }
  }));
  await openFromPalette(win, 'Conversations');
  await expect(win.getByTestId('session-state-badge')).toHaveText('Failed', { timeout: 15000 });

  const banner = win.getByTestId('session-error-banner');
  await expect(banner).toContainText('Session Failed');
  await expect(banner).toContainText('The connection to the model dropped before the reply finished');

  const thread = win.getByTestId('session-chat-thread');
  await expect(thread).toContainText('I will start with the layout.');
  await expect(thread).not.toContainText('close_notify');
  await expect(thread).not.toContainText('Falling back from WebSockets');

  const session = await win.evaluate(() => window.praxis.ai.listSessions().then(list => list[0]));
  expect(session?.responseText).toBe('I will start with the layout.');
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/session-stream-disconnect.png' });
});
