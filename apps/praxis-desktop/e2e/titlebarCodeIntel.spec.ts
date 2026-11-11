import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, dismissSplash, launchTestApp, type TestApp } from './launchTestApp';

// The title bar chip reports the project's code search: Indexing… while the index builds,
// "Semantic N%" with a keyword icon while vectors build, Hybrid with a sparkles icon once the
// model is active. It must never wake a service that has idled out. Stubbed service so each
// state can be stepped through deterministically.
let app: TestApp | undefined;
let folder: string | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
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

/** A project whose folder is `folder`, opened so the title bar reports on it. */
async function openProjectFolder(win: Page): Promise<string> {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chip-')));
  fs.writeFileSync(path.join(folder, 'Example.cs'), 'public class Example { }\n');
  await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    await window.praxis.projects.create({
      name: 'Chip project', key: 'CHIP', type: 'product', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath, planningMode: 'files',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [], defaultAiToolMode: 'project-only'
    }, workspace.id);
  }, folder);
  await win.reload();
  await dismissSplash(win);
  return folder;
}

/** A service that has never indexed anything and is not running, until a folder is registered. */
async function stubUnindexedService() {
  await app!.electronApp.evaluate(({ ipcMain }) => {
    const stub = { running: false, hasIndex: false, registered: '' as string, repoState: 'pending', calls: [] as string[] };
    (globalThis as Record<string, unknown>).ciStub = stub;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      stub.calls.push(String(request.tool ?? request.action));
      if (request.action === 'owner-status') return { data: { running: stub.running, hasIndex: stub.hasIndex } };
      if (request.action === 'register') { stub.registered = String(request.root); stub.running = true; stub.hasIndex = true; return { data: { repositoryId: 'pci:repo:new' } }; }
      if (request.action === 'list') return { data: stub.registered ? [{ id: 'pci:repo:new', root: stub.registered, state: stub.repoState, generation: 1 }] : [] };
      if (request.tool === 'get_index_status') return { data: { models: stub.repoState === 'ready' ? [{ fingerprint: 'sha256:m', state: 'building', coverage: { eligible: 100, current: 25 } }] : [] } };
      return { data: {} };
    });
  });
}
const stubCalls = () => app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as { calls: string[] }).calls);
const registeredRoot = () => app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).ciStub as { registered: string }).registered);

test('an unindexed folder shows Build index without starting the service, and clicking it builds', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await stubUnindexedService();
  const root = await openProjectFolder(app.window);
  const win = app.window;
  const chip = win.getByTestId('titlebar-code-intel');

  await expect(chip).toHaveAttribute('data-state', 'unindexed');
  await expect(chip).toHaveText('Build index');
  await expect(chip.locator('.titlebar-code-intel-icon')).toHaveClass(/is-zap/);
  // Nothing was started just to draw the chip: no status query, nothing registered.
  expect(await stubCalls()).not.toContain('get_index_status');
  expect(await registeredRoot()).toBe('');
  // The test profile turns the launch prompt off.
  await expect(win.getByTestId('code-index-prompt')).toHaveCount(0);

  await chip.click();
  await expect.poll(registeredRoot).toBe(root);
  await expect(chip).toHaveText('Indexing…');
  await app.electronApp.evaluate(() => { ((globalThis as Record<string, unknown>).ciStub as { repoState: string }).repoState = 'ready'; });
  await expect(chip).toHaveText('Semantic 25%', { timeout: 10_000 });
});

test('on launch an unindexed folder asks once to build its index, before the model notice', async ({}, testInfo) => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { codeIndexPrompt: true, semanticSearchPrompt: true });
  await stubUnindexedService();
  const root = await openProjectFolder(app.window);
  const win = app.window;
  const prompt = win.getByTestId('code-index-prompt');

  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(`Index ${path.basename(root)}?`);
  // One prompt at a time: the semantic model notice waits for this one.
  await expect(win.getByTestId('semantic-search-notification')).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('index-prompt.png') });

  await prompt.getByTestId('code-index-prompt-build').click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(registeredRoot).toBe(root);
  await expect(win.getByTestId('titlebar-code-intel')).toHaveText('Indexing…');
  await expect(win.getByTestId('semantic-search-notification')).toBeVisible();
});

test('"Not now" is remembered for the folder; the chip still builds on click', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { codeIndexPrompt: true });
  await stubUnindexedService();
  await openProjectFolder(app.window);
  const win = app.window;
  await win.getByTestId('code-index-prompt').getByTestId('code-index-prompt-dismiss').click();
  await expect(win.getByTestId('code-index-prompt')).toHaveCount(0);
  expect(await registeredRoot()).toBe('');

  await win.reload();
  await expect(win.getByTestId('titlebar-code-intel')).toHaveText('Build index');
  await win.waitForTimeout(1000);
  await expect(win.getByTestId('code-index-prompt')).toHaveCount(0);
});
