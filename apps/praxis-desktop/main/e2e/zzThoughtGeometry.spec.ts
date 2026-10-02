import * as path from 'node:path';
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined, AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined, FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
  if (mock) { await mock.close(); mock = undefined; }
});

test('measure thought + turn geometry', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
    roundTrips: ['Let me check the sessions header', 'SessionInspector is the details pane'].map(content => ({
      content, toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }]
    })),
    reply: 'Here is the summary you asked for.'
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const s = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway', permissionMode: 'auto',
    task: { goal: 'Review the details pane summary.' }
  }));
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });

  const geo = await win.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s));
    const out: any = {};
    out.cards = q('[data-testid="session-chat-assistant"]').map(el => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) };
    });
    out.thoughts = q('[data-testid="session-thought-disclosure"]').map(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), border: cs.borderTopWidth + ' ' + cs.borderTopColor };
    });
    out.telemetry = q('.session-chat-telemetry-bar').map(el => {
      const r = el.getBoundingClientRect();
      return { h: Math.round(r.height), text: (el.textContent||'').slice(0,60) };
    });
    const th = document.querySelector('.session-chat-telemetry-bar');
    if (th) out.stackH = Math.round((th.closest('[data-testid="session-chat-assistant"]') as HTMLElement).getBoundingClientRect().height);
    return out;
  });
  console.log('GEOMETRY', JSON.stringify(geo, null, 2));

  const dir = path.join(process.cwd(), '..', 'renderer', '.praxis', 'session-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  await win.screenshot({ path: path.join(dir, 'measure-full.png') });
  await win.evaluate(k => window.praxis.ai.abort(k), s.issueKey).catch(() => undefined);
});
