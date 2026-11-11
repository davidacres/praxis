import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
const instancePath = path.resolve(__dirname, '../out/main/rustHostInstance.js');
const guardPath = path.resolve(__dirname, '../out/main/rendererNavigationGuard.js');
const preloadPath = path.resolve(__dirname, '../out/preload/index.js');

test.afterEach(async () => { if (app) await closeTestApp(app); });

async function subscribe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { streamSequences: number[]; stopStream: () => void };
    state.streamSequences = [];
    state.stopStream = window.praxis.runs.onLog((projectId, line) => {
      if (projectId === 'rust-stream-parity') state.streamSequences.push(Number(line.text));
    });
  });
}
async function sequences(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { streamSequences: number[] }).streamSequences);
}

test('10,000 Rust events reach real main and secondary renderers in order, with clean restart/unsubscribe', async () => {
  test.setTimeout(120_000);
  app = await launchTestApp(undefined, undefined, { PRAXIS_RUST_CHANNELS: 'default' });
  const secondaryPromise = app.electronApp.waitForEvent('window');
  await app.electronApp.evaluate(async ({ BrowserWindow }, files) => {
    const require = process.getBuiltinModule('module')!.createRequire(files.instance);
    const primary = BrowserWindow.getAllWindows()[0];
    const secondary = new BrowserWindow({ show: false, webPreferences: { preload: files.preload, contextIsolation: true, nodeIntegration: false } });
    require(files.guard).attachRendererNavigationGuard(secondary, undefined);
    await secondary.loadURL(primary.webContents.getURL());
  }, { instance: instancePath, guard: guardPath, preload: preloadPath });
  const secondary = await secondaryPromise;
  await secondary.waitForFunction(() => !!window.praxis?.runs?.onLog);
  await subscribe(app.window); await subscribe(secondary);
  const count = 10_000;
  const replies = await app.electronApp.evaluate(async (_electron, files) => {
    const require = process.getBuiltinModule('module')!.createRequire(files.instance);
    const bridge = require(files.instance).getRustHostBridge();
    const result = await Promise.all(Array.from({ length: files.count }, (_, sequence) =>
      bridge.invoke('host:emitEvent', 'runs:log', ['rust-stream-parity', {
        serviceId: 'stream-proof', stream: 'stdout', text: String(sequence), at: '2026-01-01T00:00:00Z'
      }])));
    return result.length;
  }, { instance: instancePath, count });
  expect(replies).toBe(count);
  await expect.poll(async () => (await sequences(app.window)).length, { timeout: 30_000 }).toBe(count);
  await expect.poll(async () => (await sequences(secondary)).length, { timeout: 30_000 }).toBe(count);
  const expected = Array.from({ length: count }, (_, i) => i);
  expect(await sequences(app.window)).toEqual(expected);
  expect(await sequences(secondary)).toEqual(expected);

  await secondary.evaluate(() => (window as unknown as { stopStream: () => void }).stopStream());
  await app.electronApp.evaluate(async (_electron, file) => {
    const require = process.getBuiltinModule('module')!.createRequire(file);
    const host = require(file);
    await host.disposeRustHost();
    await host.getRustHostBridge().invoke('host:emitEvent', 'runs:log', ['rust-stream-parity', { serviceId: 'stream-proof', stream: 'stdout', text: '10000' }]);
  }, instancePath);
  await expect.poll(async () => (await sequences(app.window)).length).toBe(count + 1);
  expect((await sequences(app.window)).at(-1)).toBe(count);
  expect(await sequences(secondary)).toEqual(expected);
  await secondary.close();
  await app.electronApp.evaluate(async (_electron, file) => {
    const require = process.getBuiltinModule('module')!.createRequire(file);
    await require(file).getRustHostBridge().invoke('host:emitEvent', 'runs:log', ['rust-stream-parity', { serviceId: 'stream-proof', stream: 'stdout', text: '10001' }]);
  }, instancePath);
  await expect.poll(async () => (await sequences(app.window)).length).toBe(count + 2);
  expect((await sequences(app.window)).at(-1)).toBe(count + 1);
});
