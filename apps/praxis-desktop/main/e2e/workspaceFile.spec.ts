import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/**
 * Saved workspaces are written as `<slug>.workspace.praxis`, and both the save
 * and open dialogs filter on that extension so the picker isn't a sea of
 * unrelated `.json` files. The native dialogs are stubbed in the main process
 * to capture the options the app passes and to complete the flow headlessly.
 */
test('save and open filter on the .workspace.praxis extension and round-trip', async () => {
  app = await launchTestApp();
  const win = app.window;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wsfile-'));
  const chosenPath = path.join(dir, 'chosen.workspace.praxis');

  await app.electronApp.evaluate(({ dialog }, filePath) => {
    const bucket = globalThis as Record<string, unknown>;
    bucket.__dialogCalls = {};
    dialog.showSaveDialog = async (opts: unknown) => {
      (bucket.__dialogCalls as Record<string, unknown>).save = opts;
      return { canceled: false, filePath };
    };
    dialog.showOpenDialog = async (opts: unknown) => {
      (bucket.__dialogCalls as Record<string, unknown>).open = opts;
      return { canceled: false, filePaths: [filePath] };
    };
  }, chosenPath);

  await win.evaluate(() => window.praxis.workspaces.create({ name: 'Client Work', description: 'x', projectIds: [] }));
  const created = await win.evaluate(() => window.praxis.workspaces.list().then(list => list[0]));

  const savedTo = await win.evaluate(id => window.praxis.workspaces.saveToFile(id), created.id);
  expect(savedTo).toBe(chosenPath);
  expect(fs.existsSync(chosenPath)).toBe(true);

  const opened = await win.evaluate(() => window.praxis.workspaces.openFromFile());
  expect(opened?.name).toBe('Client Work');

  const calls = await app.electronApp.evaluate(() => (globalThis as Record<string, unknown>).__dialogCalls) as {
    save: { defaultPath: string; filters: { name: string; extensions: string[] }[] };
    open: { filters: { name: string; extensions: string[] }[] };
  };
  expect(calls.save.defaultPath).toBe('client-work.workspace.praxis');
  expect(calls.save.filters[0]).toEqual({ name: 'Praxis Workspace', extensions: ['praxis'] });
  expect(calls.open.filters[0]).toEqual({ name: 'Praxis Workspace', extensions: ['praxis'] });

  fs.rmSync(dir, { recursive: true, force: true });
});
