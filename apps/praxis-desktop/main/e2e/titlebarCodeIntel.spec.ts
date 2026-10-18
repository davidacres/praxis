import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// The title bar chip reports the project's code search: Indexing… while the index builds,
// "Semantic N%" with a keyword icon while vectors build, Hybrid with a sparkles icon once the
// model is active. It must never wake a service that has idled out. Stubbed service so each
// state can be stepped through deterministically.
let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

type Stub = { running: boolean; hasIndex?: boolean; repoState: string; model?: { state: string; current: number }; calls: string[] };

test('the title bar chip shows indexing, semantic build progress and the search type', async ({}, testInfo) => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    const stub: Stub = { running: true, repoState: 'pending', calls: [] };
    (globalThis as Record<string, unknown>).ciStub = stub;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      stub.calls.push(String(request.tool ?? request.action));
      if (request.action === 'owner-status') return { data: { running: stub.running, hasIndex: stub.hasIndex ?? true } };
      if (request.action === 'list') return { data: [{ id: 'pci:repo:chip', root: '/test/chip', state: stub.repoState, generation: 1 }] };
      if (request.action === 'query' && request.tool === 'get_index_status')
        return { data: { models: stub.model ? [{ fingerprint: 'sha256:m', state: stub.model.state, coverage: { eligible: 20000, current: stub.model.current } }] : [] } };
      if (request.action === 'query') return { data: { matches: [], fragments: [], items: [] }, evidence: [] };
      return { data: {} };
    });
  });
  const setStub = (patch: Partial<Stub>) => app!.electronApp.evaluate((_electron, value) => Object.assign((globalThis as Record<string, unknown>).ciStub as object, value), patch);
  const win = app.window;
  // The chip loaded once before the stub; reload so it reads the stub from the start.
  await win.reload();
  const chip = win.getByTestId('titlebar-code-intel');

  await expect(chip).toHaveAttribute('data-state', 'indexing');
  await expect(chip).toHaveText('Indexing…');

  // Index done, vectors building: keyword search icon, semantic progress.
  await setStub({ repoState: 'ready', model: { state: 'building', current: 9700 } });
  await expect(chip).toHaveText('Semantic 48%');
  await expect(chip.locator('.titlebar-code-intel-icon')).toHaveClass(/is-search/);
  await expect(chip).toHaveAttribute('title', /keyword only while the semantic index builds \(9,700 of 20,000 symbols\)/);
  await win.locator('.titlebar').screenshot({ path: testInfo.outputPath('titlebar-building.png') });

  // Progress moves while it is shown.
  await setStub({ model: { state: 'building', current: 15000 } });
  await expect(chip).toHaveText('Semantic 75%');

  // Model active: hybrid, with its own icon, and polling stops.
  await setStub({ model: { state: 'active', current: 20000 } });
  await expect(chip).toHaveText('Hybrid');
  await expect(chip.locator('.titlebar-code-intel-icon')).toHaveClass(/is-sparkles/);
  await win.locator('.titlebar').screenshot({ path: testInfo.outputPath('titlebar-hybrid.png') });
  const settled = await app.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as Stub).calls.length);
  await win.waitForTimeout(4000);
  expect(await app.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as Stub).calls.length)).toBe(settled);

  // Clicking opens code search on that repository.
  await chip.click();
  await expect(win.getByTestId('code-search-dialog')).toBeVisible();
});

test('the chip shows keyword search without a model and never wakes an idle service', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    const stub: Stub = { running: true, repoState: 'ready', calls: [] };
    (globalThis as Record<string, unknown>).ciStub = stub;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      stub.calls.push(String(request.tool ?? request.action));
      if (request.action === 'owner-status') return { data: { running: stub.running, hasIndex: stub.hasIndex ?? true } };
      if (request.action === 'list') return { data: [{ id: 'pci:repo:chip', root: '/test/chip', state: stub.repoState, generation: 1 }] };
      if (request.tool === 'get_index_status') return { data: { models: [] } };
      return { data: {} };
    });
  });
  const win = app.window;
  await win.reload();
  const chip = win.getByTestId('titlebar-code-intel');
  await expect(chip).toHaveText('Keyword');
  await expect(chip.locator('.titlebar-code-intel-icon')).toHaveClass(/is-search/);

  // The service idles out; a focus refresh only asks whether it is running.
  await app.electronApp.evaluate(() => { const stub = (globalThis as Record<string, unknown>).ciStub as Stub; stub.running = false; stub.calls.length = 0; });
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as Stub).calls)).toEqual(['owner-status']);
  await expect(chip).toHaveText('Keyword');
});

test('a profile with nothing indexed shows no chip and starts no service', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    const stub: Stub = { running: false, hasIndex: false, repoState: 'ready', calls: [] };
    (globalThis as Record<string, unknown>).ciStub = stub;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      stub.calls.push(String(request.tool ?? request.action));
      if (request.action === 'owner-status') return { data: { running: stub.running, hasIndex: stub.hasIndex } };
      // A repository at the filesystem root matches whatever folder the chip reports on (and
      // no session's own folder), so a chip that woke the service would ask for its status
      // and show it. The session composer's own chip lists repositories too; that is not this.
      if (request.action === 'list') return { data: [{ id: 'pci:repo:root', root: '/', state: 'ready', generation: 1 }] };
      if (request.tool === 'get_index_status') return { data: { models: [{ fingerprint: 'sha256:m', state: 'active', coverage: { eligible: 1, current: 1 } }] } };
      return { data: {} };
    });
  });
  const win = app.window;
  await win.reload();
  await expect.poll(() => app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as Stub).calls)).toContain('owner-status');
  await win.waitForTimeout(1500);
  expect(await app.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as Stub).calls)).not.toContain('get_index_status');
  await expect(win.getByTestId('titlebar-code-intel')).toHaveCount(0);
});
