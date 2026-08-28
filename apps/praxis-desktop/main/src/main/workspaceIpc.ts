import * as fs from 'node:fs';
import { app, dialog, ipcMain } from 'electron';
import {
  PRAXIS_WORKSPACE_FILE_EXTENSION,
  parseWorkspaceFile,
  toWorkspaceFile,
  workspaceFileName,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput
} from '@praxis/core';
import { getWorkspaceStore } from './workspaceStoreInstance';

// Both file dialogs offer the same choices: the dedicated `.workspace.praxis`
// extension first (the default view), with an All Files escape hatch.
const WORKSPACE_FILE_FILTERS = [
  { name: 'Praxis Workspace', extensions: [PRAXIS_WORKSPACE_FILE_EXTENSION] },
  { name: 'All Files', extensions: ['*'] }
];

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspaces:list', () => getWorkspaceStore().list());
  ipcMain.handle('workspaces:get', (_event, id: string) => getWorkspaceStore().get(id));
  ipcMain.handle('workspaces:create', (_event, input: CreateWorkspaceInput) => getWorkspaceStore().create(input, app.getVersion()));
  ipcMain.handle('workspaces:update', (_event, id: string, patch: UpdateWorkspaceInput) => getWorkspaceStore().update(id, patch, app.getVersion()));
  ipcMain.handle('workspaces:remove', (_event, id: string) => getWorkspaceStore().remove(id));
  ipcMain.handle('workspaces:saveToFile', async (_event, id: string) => {
    const workspace = getWorkspaceStore().get(id);
    if (!workspace) throw new Error(`Workspace ${id} was not found.`);
    const result = await dialog.showSaveDialog({
      title: 'Save Praxis Workspace', defaultPath: workspaceFileName(workspace.name),
      filters: WORKSPACE_FILE_FILTERS
    });
    if (result.canceled || !result.filePath) return undefined;
    await fs.promises.writeFile(result.filePath, JSON.stringify(toWorkspaceFile(workspace), null, 2), 'utf8');
    return result.filePath;
  });
  ipcMain.handle('workspaces:openFromFile', async () => {
    const result = await dialog.showOpenDialog({ title: 'Open Praxis Workspace', properties: ['openFile'], filters: WORKSPACE_FILE_FILTERS });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const workspace = parseWorkspaceFile(await fs.promises.readFile(result.filePaths[0], 'utf8'));
    // Imported files retain their provenance metadata; the current app version records the import save.
    return getWorkspaceStore().import(workspace, app.getVersion());
  });
}
