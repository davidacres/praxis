import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedBrowserUrlReason,
  browserHostAllowed,
  createBrowserToolExtension,
  type BrowserBridge,
  type BrowserPageState
} from './browserTools';

const page = (over: Partial<BrowserPageState> = {}): BrowserPageState => ({
  url: 'https://example.com/',
  title: 'Example',
  text: 'hello world',
  ...over
});

function fakeBridge(): BrowserBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async navigate(url) {
      calls.push(`navigate ${url}`);
      return page({ url });
    },
    async read() {
      calls.push('read');
      return page();
    },
    async snapshot(filter) {
      calls.push(`snapshot ${filter ?? ''}`.trim());
      return { state: page(), elements: [{ ref: 'e1', role: 'button', name: 'Go' }] };
    },
    async click(ref) {
      calls.push(`click ${ref}`);
      return page();
    },
    async type(ref, text, submit) {
      calls.push(`type ${ref} ${text} ${submit}`);
      return page();
    }
  };
}

test('blockedBrowserUrlReason refuses non-http, loopback and private hosts', () => {
  assert.ok(blockedBrowserUrlReason('file:///etc/passwd'));
  assert.ok(blockedBrowserUrlReason('ftp://example.com'));
  assert.ok(blockedBrowserUrlReason('http://localhost:3000'));
  assert.ok(blockedBrowserUrlReason('http://127.0.0.1/x'));
  assert.ok(blockedBrowserUrlReason('http://192.168.1.5/'));
  assert.ok(blockedBrowserUrlReason('http://10.0.0.1/'));
  assert.equal(blockedBrowserUrlReason('https://example.com/path'), undefined);
  assert.equal(blockedBrowserUrlReason('http://127.0.0.1/x', { allowPrivateHosts: true }), undefined);
});

test('browserHostAllowed matches exact hosts and *. wildcards', () => {
  assert.equal(browserHostAllowed('https://docs.example.com/x', ['docs.example.com']), true);
  assert.equal(browserHostAllowed('https://docs.example.com/x', ['*.example.com']), true);
  assert.equal(browserHostAllowed('https://example.com/x', ['*.example.com']), true);
  assert.equal(browserHostAllowed('https://evil.com/x', ['*.example.com']), false);
  assert.equal(browserHostAllowed('not a url', ['example.com']), false);
});

test('browser_navigate prompts for an unlisted host and honours the decision', async () => {
  const bridge = fakeBridge();
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });

  const denied = await ext.execute('browser_navigate', { url: 'https://example.com/' }, async () => 'deny');
  assert.equal(denied.ok, false);
  assert.deepEqual(bridge.calls, []);

  let seen: string | undefined;
  const allowed = await ext.execute('browser_navigate', { url: 'https://example.com/' }, async req => {
    seen = req.kind;
    return 'allow_once';
  });
  assert.equal(allowed.ok, true);
  assert.equal(seen, 'browser-navigate');
  assert.deepEqual(bridge.calls, ['navigate https://example.com/']);
});

test('browser_navigate skips the prompt for an allow-listed host and reports allow_always', async () => {
  const bridge = fakeBridge();
  const remembered: string[] = [];
  const ext = createBrowserToolExtension({
    bridge,
    allowedHosts: ['*.example.com'],
    onHostAllowed: host => remembered.push(host)
  });

  let prompted = false;
  const res = await ext.execute('browser_navigate', { url: 'https://docs.example.com/' }, async () => {
    prompted = true;
    return 'deny';
  });
  assert.equal(res.ok, true);
  assert.equal(prompted, false);
  assert.deepEqual(remembered, []);
});

test('browser_navigate rejects a blocked url before prompting', async () => {
  const bridge = fakeBridge();
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_navigate', { url: 'http://localhost/' }, async () => 'allow_once');
  assert.equal(res.ok, false);
  assert.match(res.content, /loopback/);
  assert.deepEqual(bridge.calls, []);
});

test('read / snapshot / click / type dispatch to the bridge and format output', async () => {
  const bridge = fakeBridge();
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });

  assert.match((await ext.execute('browser_read', {}, async () => 'deny')).content, /Example/);
  assert.match((await ext.execute('browser_snapshot', {}, async () => 'deny')).content, /\[e1\] button "Go"/);
  assert.equal((await ext.execute('browser_click', {}, async () => 'deny')).ok, false); // missing ref
  assert.equal((await ext.execute('browser_click', { ref: 'e1' }, async () => 'deny')).ok, true);
  assert.equal((await ext.execute('browser_type', { ref: 'e1', text: 'hi', submit: true }, async () => 'deny')).ok, true);
  assert.equal((await ext.execute('nope', {}, async () => 'deny')).ok, false);

  assert.deepEqual(bridge.calls, ['read', 'snapshot', 'click e1', 'type e1 hi true']);
});

test('navigate/click/type return a brief; only browser_read returns the full body', async () => {
  const long = 'X'.repeat(5000);
  const bridge: BrowserBridge = {
    async navigate() { return page({ text: long }); },
    async read() { return page({ text: long }); },
    async snapshot() { return { state: page(), elements: [] }; },
    async click() { return page({ text: long }); },
    async type() { return page({ text: long }); }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: ['example.com'] });

  const nav = await ext.execute('browser_navigate', { url: 'https://example.com/' }, async () => 'deny');
  assert.ok(nav.content.length < 1200, 'navigate result should be a brief, not the 5000-char body');
  assert.match(nav.content, /call browser_read for the full text/);

  const read = await ext.execute('browser_read', {}, async () => 'deny');
  assert.ok(read.content.includes(long), 'browser_read returns the full body');
});

test('browser_diagnostics reports unsupported rather than inventing an empty result on a bridge without it', async () => {
  const bridge = fakeBridge(); // no getDiagnostics
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_diagnostics', {}, async () => 'deny');
  assert.equal(res.ok, false);
  assert.match(res.content, /not supported/);
});

test('browser_screenshot reports unsupported rather than inventing a capture on a bridge without it', async () => {
  const bridge = fakeBridge(); // no captureScreenshot
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_screenshot', {}, async () => 'deny');
  assert.equal(res.ok, false);
  assert.match(res.content, /not supported/);
});

test('browser_diagnostics formats console and network entries from a bridge that supports it', async () => {
  const bridge: BrowserBridge = {
    ...fakeBridge(),
    async getDiagnostics() {
      return {
        console: [{ level: 'error', message: 'TypeError: fetch failed', at: '2026-09-09T00:00:00.000Z' }],
        network: [
          { url: 'http://127.0.0.1:5000/api/orders', method: 'GET', status: 500, at: '2026-09-09T00:00:00.000Z' },
          { url: 'http://127.0.0.1:5000/api/x', method: 'POST', error: 'net::ERR_CONNECTION_REFUSED', at: '2026-09-09T00:00:00.000Z' }
        ],
        truncated: false
      };
    }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_diagnostics', {}, async () => 'deny');
  assert.equal(res.ok, true);
  assert.match(res.content, /TypeError: fetch failed/);
  assert.match(res.content, /HTTP 500/);
  assert.match(res.content, /net::ERR_CONNECTION_REFUSED/);
  assert.doesNotMatch(res.content, /older entries were dropped/);
});

test('browser_diagnostics notes when the capture was truncated', async () => {
  const bridge: BrowserBridge = {
    ...fakeBridge(),
    async getDiagnostics() {
      return { console: [], network: [], truncated: true };
    }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_diagnostics', {}, async () => 'deny');
  assert.match(res.content, /older entries were dropped/);
});

test('browser_diagnostics reports empty console/network plainly, not as an error', async () => {
  const bridge: BrowserBridge = {
    ...fakeBridge(),
    async getDiagnostics() {
      return { console: [], network: [], truncated: false };
    }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_diagnostics', {}, async () => 'deny');
  assert.equal(res.ok, true);
  assert.match(res.content, /Console \(0\):\n\(none\)/);
  assert.match(res.content, /Failed requests \(0\):\n\(none\)/);
});

test('browser_screenshot reports what happened without ever carrying image content', async () => {
  const bridge: BrowserBridge = {
    ...fakeBridge(),
    async captureScreenshot() {
      return { captured: true, note: 'Screenshot captured (1280x800, 42 KB).' };
    }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_screenshot', {}, async () => 'deny');
  assert.equal(res.ok, true);
  assert.equal(res.content, 'Screenshot captured (1280x800, 42 KB).');
});

test('browser_screenshot surfaces a capture failure as ok:false with the reason, not a thrown error', async () => {
  const bridge: BrowserBridge = {
    ...fakeBridge(),
    async captureScreenshot() {
      return { captured: false, note: 'The preview window is not currently visible.' };
    }
  };
  const ext = createBrowserToolExtension({ bridge, allowedHosts: [] });
  const res = await ext.execute('browser_screenshot', {}, async () => 'deny');
  assert.equal(res.ok, false);
  assert.equal(res.content, 'The preview window is not currently visible.');
});
