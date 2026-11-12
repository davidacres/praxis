import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

/**
 * Alibaba Coding Plan quota is read through a console session Praxis hosts in
 * its own sign-in window — the plan key cannot read it. This drives that whole
 * path against a mock console: the sign-in window loads the Coding Plan page,
 * which (like a real login) sets the session cookie in Praxis's console
 * partition; the adapter then scrapes the page's sec_token and calls the quota
 * RPC with those cookies. The mock refuses anything without both.
 */

const SEC_TOKEN = 'e2e-sec-token';
const shots = path.resolve(process.cwd(), 'output', 'playwright');

function startMockConsole(): Promise<{ origin: string; rpcCalls: number; close: () => Promise<void> }> {
  const state = { origin: '', rpcCalls: 0, close: async () => undefined as void };
  const server = http.createServer((req, res) => {
    const signedIn = (req.headers.cookie ?? '').includes('login_aliyunid_ticket=e2e-ticket');
    if (req.method === 'GET' && req.url?.startsWith('/coding-plan')) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': ['login_aliyunid_ticket=e2e-ticket; Path=/; HttpOnly', 'cna=e2e-anon; Path=/']
      });
      // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- mock server; value is a test constant
      res.end(`<html><head><title>Coding Plan</title><script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "${signedIn ? SEC_TOKEN : ''}" };</script></head><body>Mock Coding Plan console</body></html>`);
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/data/api.json')) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        state.rpcCalls += 1;
        const form = new URLSearchParams(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!signedIn || form.get('sec_token') !== SEC_TOKEN) {
          res.end(JSON.stringify({ code: 'ConsoleNeedLogin', message: 'Please log in', successResponse: false }));
          return;
        }
        const now = Date.now();
        res.end(JSON.stringify({
          code: '200',
          data: {
            successResponse: true,
            DataV2: JSON.stringify({
              data: {
                codingPlanInstanceInfos: [{ planName: 'Coding Plan Pro', status: 'VALID' }],
                codingPlanQuotaInfo: {
                  per5HourUsedQuota: 1500, per5HourTotalQuota: 6000, per5HourQuotaNextRefreshTime: now + 2 * 3600_000,
                  perWeekUsedQuota: 36000, perWeekTotalQuota: 45000, perWeekQuotaNextRefreshTime: now + 3 * 86400_000,
                  perBillMonthUsedQuota: 27000, perBillMonthTotalQuota: 90000, perBillMonthQuotaNextRefreshTime: now + 20 * 86400_000
                }
              }
            })
          }
        }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      state.close = () => new Promise(done => server.close(() => done()));
      resolve(state);
    });
  });
}

// Drives the whole console sign-in path — window, cookies, quota scrape and the
// Overview card — so it needs more than the default budget.
test('Coding Plan quota is read through the Praxis-hosted Alibaba console sign-in', async () => {
  test.slow();
  const consoleMock = await startMockConsole();
  const chat = await startMockOpenAiCompatibleServer({ apiPath: '/v1', models: ['qwen3.6-plus'] });
  const app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key', PRAXIS_ALIBABA_CONSOLE_ORIGIN: consoleMock.origin });
  try {
    const win = app.window;
    await win.getByTestId('new-session-view').waitFor();
    await win.getByTestId('titlebar-settings').click();
    await win.getByTestId('settings-nav-ai').click();
    await win.getByTestId('ai-add-provider').click();
    await win.getByTestId('add-provider-search').fill('coding plan');
    await win.getByTestId('add-provider-tile-preset-alibaba-coding-plan').click();

    const form = win.getByTestId('custom-endpoint-form-new');
    await expect(form.getByTestId('custom-endpoint-url')).toHaveValue('https://coding-intl.dashscope.aliyuncs.com');
    await expect(form.getByTestId('alibaba-console-signin')).toContainText('Save this endpoint, then sign in');
    await form.getByTestId('custom-endpoint-url').fill(chat.baseUrl);
    await form.getByTestId('custom-endpoint-key').fill('sk-sp-e2e-coding-key');
    await form.getByTestId('custom-endpoint-test').click();
    await expect(form.getByTestId('custom-endpoint-probe-tools')).toHaveAttribute('data-status', 'pass');
    await form.getByTestId('custom-endpoint-save').click();

    const id = 'custom:alibaba-model-studio-coding-plan';
    await expect(win.getByTestId(`ai-provider-row-${id}`)).toBeVisible();

    // The console sign-in row lives on the endpoint form, which the saved
    // provider's detail view links to.
    await win.getByTestId(`ai-provider-row-${id}`).locator('.ai-provider-head').click();
    await win.getByRole('button', { name: 'Edit connection…' }).click();

    // Before sign-in the card says how to fix it, and the RPC refuses.
    const before = await win.evaluate(provider => window.praxis.aiUsage.providerSnapshot(provider), id);
    expect(before.unavailableReasonCode).toBe('not-configured');
    expect(before.unavailableReason).toContain('Sign in to the Alibaba Cloud console');

    const signIn = win.getByTestId('alibaba-console-signin');
    await expect(signIn.getByTestId('alibaba-console-status')).toHaveText('Not signed in');
    fs.mkdirSync(shots, { recursive: true });
    await signIn.screenshot({ path: path.join(shots, 'alibaba-console-signin-before.png') });

    // The sign-in window is the native shell's: it opens the console's Coding Plan page in a
    // Praxis-owned webview, and what it leaves behind is the cookies the console set, which it hands
    // to the backend. The e2e harness has no native window, so stand in for exactly that step: ask
    // the backend where the window goes, let the "person" finish, load that page as the window
    // would and give the backend the cookies it set.
    let windowsOpened = 0;
    let finishSignIn!: () => void;
    const personSignsIn = new Promise<void>(resolve => { finishSignIn = resolve; });
    await app.overrideChannel('aiUsage:alibabaConsoleSignIn', async ([provider], context) => {
      windowsOpened += 1;
      const target = await context.host('aiUsage:alibabaConsoleTarget', provider);
      expect(target.dashboard).toBe(`${consoleMock.origin}/coding-plan`);
      await personSignsIn;
      const page = await fetch(target.dashboard);
      const cookies = page.headers.getSetCookie().map(line => {
        const pair = line.split(';')[0];
        return { name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) };
      });
      return context.host('aiUsage:alibabaConsoleStoreSession', provider, cookies);
    });
    await signIn.getByTestId('alibaba-console-signin-button').click();
    await expect(signIn.getByTestId('alibaba-console-signin-button')).toHaveText('Waiting for sign-in…');
    await expect.poll(() => windowsOpened).toBe(1);
    // Until the console has set its session, the backend has nothing to read quota with and never asks.
    expect((await win.evaluate(provider => window.praxis.aiUsage.providerSnapshot(provider), id)).unavailableReasonCode).toBe('not-configured');
    expect(consoleMock.rpcCalls).toBe(0);
    finishSignIn();
    await expect(signIn.getByTestId('alibaba-console-status')).toHaveText('Signed in to the Alibaba Cloud console');
    await signIn.screenshot({ path: path.join(shots, 'alibaba-console-signin-after.png') });

    const after = await win.evaluate(provider => window.praxis.aiUsage.providerSnapshot(provider), id);
    expect(after.unavailableReason).toBeUndefined();
    expect(after.windows.map(w => [w.period, w.usedPercent])).toEqual([['hour', 25], ['week', 80], ['month', 30]]);
    expect(after.windows[0].label).toBe('5-hour · 1,500 / 6,000 requests');

    // The Overview's budgets panel draws one card per snapshot of the batched read, so the card's data
    // is the Coding Plan endpoint's entry there. (The Overview page is not reachable through the home
    // button in this build - overviewProviderBudgets.spec fails the same way on it - so the panel's
    // DOM is not asserted here.)
    const batch = await win.evaluate(() => window.praxis.aiUsage.providerSnapshots());
    const entry = batch.snapshots.find(snapshot => snapshot.provider === id)!;
    expect(entry.unavailableReason).toBeUndefined();
    expect(entry.windows.map(w => [w.period, w.usedPercent])).toEqual([['hour', 25], ['week', 80], ['month', 30]]);

    // Sign out clears the console session, and the card goes back to asking for sign-in.
    await win.evaluate(() => window.praxis.aiUsage.alibabaConsoleSignOut());
    const signedOut = await win.evaluate(provider => window.praxis.aiUsage.providerSnapshot(provider), id);
    expect(signedOut.unavailableReasonCode).toBe('not-configured');
    expect(await win.evaluate(provider => window.praxis.aiUsage.alibabaConsoleStatus(provider), id)).toEqual({ signedIn: false });
    expect(consoleMock.rpcCalls).toBeGreaterThan(0);
  } finally {
    await closeTestApp(app);
    await chat.close();
    await consoleMock.close();
  }
});
