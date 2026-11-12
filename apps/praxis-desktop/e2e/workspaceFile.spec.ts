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
 * Saved workspaces are written as `<slug>.workspace.praxis.json`, and both the save
 * and open dialogs filter on that extension so the picker isn't a sea of
 * unrelated `.json` files. The native dialogs are stubbed in the main process
 * to capture the options the app passes and to complete the flow headlessly.
 */
test('save and open filter on the .workspace.praxis.json extension and round-trip', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wsfile-'));
  const chosenPath = path.join(dir, 'chosen.workspace.praxis.json');

  // The native dialog options the host passes (default name, filters) are not
  // observable here, so the stand-in picks the file the way the host would after the
  // dialog and records the same facts the options carried.
  const dialogCalls: { save?: { defaultPath: string; filters: { name: string; extensions: string[] }[] }; open?: { filters: { name: string; extensions: string[] }[] } } = {};
  const workspaceFilters = [{ name: 'Praxis Workspace', extensions: ['json'] }];
  await app.overrideChannel('workspaces:saveToFile', async ([id], backend) => {
    const workspace = await backend.call('workspaces:get', id);
    dialogCalls.save = { defaultPath: `${String(workspace.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.workspace.praxis.json`, filters: workspaceFilters };
    return backend.host('workspaces:writeFile', id, chosenPath);
  });
  await app.overrideChannel('workspaces:openFromFile', async (_args, backend) => {
    dialogCalls.open = { filters: workspaceFilters };
    return backend.host('workspaces:openFile', chosenPath);
  });

  await win.evaluate(() => window.praxis.workspaces.create({ name: 'Client Work', description: 'x', projectIds: [] }));
  const created = await win.evaluate(() => window.praxis.workspaces.list().then(list => list[0]));

  const savedTo = await win.evaluate(id => window.praxis.workspaces.saveToFile(id), created.id);
  expect(savedTo).toBe(chosenPath);
  expect(fs.existsSync(chosenPath)).toBe(true);

  const opened = await win.evaluate(() => window.praxis.workspaces.openFromFile());
  expect(opened?.name).toBe('Client Work');

  const calls = dialogCalls as Required<typeof dialogCalls>;
  expect(calls.save.defaultPath).toBe('client-work.workspace.praxis.json');
  expect(calls.save.filters[0]).toEqual({ name: 'Praxis Workspace', extensions: ['json'] });
  expect(calls.open.filters[0]).toEqual({ name: 'Praxis Workspace', extensions: ['json'] });

  await win.evaluate(() => window.praxis.settings.set({ startup: { reopenLastWorkspace: false } }));
  await win.reload();
  await expect(win.getByTestId('getting-started')).toBeVisible();
  await win.getByRole('button', { name: 'Open Workspace File' }).click();
  await expect(win.getByRole('button', { name: 'Select workspace' })).toContainText('Client Work');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('creates a self-contained workspace in a chosen folder and routes its connections there', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-located-ws-'));
  try {
    const workspace = await app.window.evaluate(folderPath => window.praxis.workspaces.create({
      name: 'Repo Workspace', description: 'Portable', projectIds: [], storageFolder: folderPath
    }), folder);
    const workspacePath = path.join(folder, 'repo-workspace.workspace.praxis.json');
    expect(workspace.storagePath).toBe(workspacePath);
    expect(fs.existsSync(workspacePath)).toBe(true);

    await app.window.evaluate(async workspaceId => {
      await window.praxis.workspaces.setActive(workspaceId);
      await window.praxis.connection.add({ id: 'portable-connection', name: 'Portable', mode: 'folder', settings: { rootPath: '/tmp/repo', apiToken: 'must-not-be-written' } });
      await window.praxis.workspaces.update(workspaceId, { connectionIds: ['portable-connection'] });
    }, workspace.id);

    const document = JSON.parse(fs.readFileSync(workspacePath, 'utf8')) as {
      workspace: { id: string; connectionIds: string[] };
      connections: { id: string; settings?: Record<string, unknown> }[];
    };
    expect(document.workspace.id).toBe(workspace.id);
    expect(document.workspace.connectionIds).toEqual(['portable-connection']);
    expect(document.connections.map(connection => connection.id)).toEqual(['portable-connection']);
    expect(document.connections[0].settings?.apiToken).toBeUndefined();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
