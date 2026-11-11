import { openSession } from './sessionNavigation';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * TASK-440: a URL in a chat message is clickable and opens in the session's
 * in-app browser (an isolated WebContentsView) beside the conversation, never in
 * the app window. The page title only reaches `browser.getState()` from a real load.
 */
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;
let pages: http.Server | undefined;
let origin = '';

test.beforeAll(async () => {
  pages = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const name = (req.url ?? '/').replace(/[^\w-]/g, '') || 'root';
    res.end(`<!doctype html><title>Linked ${name}</title><h1>${name}</h1>`);
  });
  await new Promise<void>(resolve => pages!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(pages!.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => pages?.close(() => resolve())); });
test.afterEach(async () => { if (app) { await closeTestApp(app); app = undefined; } });

async function startLinkSession(extraEnv: Record<string, string>, linksText: string): Promise<TestApp['window']> {
  app = await launchTestApp(undefined, undefined, { FAKE_ACP_LINKS_TEXT: linksText, ...extraEnv });
  const win = app.window;
  await win.evaluate(async ({ cliPath, wd }) => {
    await window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath } } } });
    await window.praxis.ai.delegate({ provider: 'claude-code-cli', toolMode: 'full', workingDirectory: wd, task: { goal: 'EMIT_LINKS' } });
  }, { cliPath: FIXTURE_PATH, wd: app.userDataDir });
  await openSession(win);
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Open', { timeout: 20000 });
  return win;
}

const browserTitle = (win: TestApp['window']) => win.evaluate(async () => (await window.praxis.browser.getState())?.title ?? '');

test('markdown, autolink and bare URLs open in the in-app browser; file names stay plain text', async () => {
  const win = await startLinkSession(
    { PRAXIS_BROWSER_ALLOW_LOOPBACK: '1' },
    `Open [the docs](${origin}/docs) or <${origin}/auto> or ${origin}/bare. Edit README.md too.`
  );
  const thread = win.locator('[data-testid="session-chat-thread"]');

  // Trailing sentence punctuation stays prose, and a file name is not a link.
  await expect(thread.locator('a[href$="/bare"]')).toHaveText(`${origin}/bare`);
  await expect(thread.locator('a', { hasText: 'README.md' })).toHaveCount(0);
  const appUrl = win.url();

  await thread.locator('a', { hasText: 'the docs' }).click();
  await expect(win.locator('[data-testid="browser-pane"]')).toBeVisible();
  await expect.poll(() => browserTitle(win), { timeout: 15000 }).toBe('Linked docs');
  expect(win.url()).toBe(appUrl); // the app window never navigated

  // Browse on, then click the same link again: it must navigate back.
  await thread.locator('a[href$="/auto"]').click();
  await expect.poll(() => browserTitle(win), { timeout: 15000 }).toBe('Linked auto');
  await thread.locator('a', { hasText: 'the docs' }).click();
  await expect.poll(() => browserTitle(win), { timeout: 15000 }).toBe('Linked docs');
  await thread.locator('a', { hasText: 'the docs' }).click();
  await expect.poll(() => browserTitle(win), { timeout: 15000 }).toBe('Linked docs');

  // Chrome: reload and the system-browser hand-off exist and are labelled.
  await expect(win.locator('[data-testid="browser-pane"] [aria-label="Reload"]')).toBeVisible();
  await expect(win.locator('[data-testid="browser-open-external"]')).toBeEnabled();
  await expect(win.locator('[data-testid="browser-notice"]')).toHaveCount(0);
});

test('a link to a private host is refused with a visible reason', async () => {
  // No PRAXIS_BROWSER_ALLOW_LOOPBACK: the local server is a loopback address.
  const win = await startLinkSession({}, `Open [internal](${origin}/secret) please.`);
  await win.locator('[data-testid="session-chat-thread"] a', { hasText: 'internal' }).click();

  await expect(win.locator('[data-testid="browser-pane"]')).toBeVisible();
  const notice = win.locator('[data-testid="browser-notice"]');
  await expect(notice).toBeVisible({ timeout: 10000 });
  await expect(notice).not.toContainText('Error invoking remote method');
  expect(await browserTitle(win)).not.toBe('Linked secret');
});
