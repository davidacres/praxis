import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { createWorkspaceFile } from './adapters/workspaceFileStore';
import { deregisterWorkspaceLocation, registerWorkspaceLocation, resetWorkspaceScopes, setActiveWorkspaceId } from './workspaceLocations';
import { createWorkspaceInAppStore } from './workspaceStoreInstance';
import { getProjectStore } from './projectStoreInstance';
import { getConnectionStore } from './connectionStoreInstance';

// Both file dialogs offer the same choices: the dedicated `.workspace.praxis`
// extension first (the default view), with an All Files escape hatch.
const WORKSPACE_FILE_FILTERS = [
  { name: 'Praxis Workspace', extensions: [PRAXIS_WORKSPACE_FILE_EXTENSION] },
  { name: 'All Files', extensions: ['*'] }
];

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspaces:list', () => getWorkspaceStore().list());
  ipcMain.handle('workspaces:get', (_event, id: string) => getWorkspaceStore().get(id));
  ipcMain.handle('workspaces:setActive', (_event, id: string | undefined) => { setActiveWorkspaceId(id); });
  ipcMain.handle('workspaces:create', async (_event, input: CreateWorkspaceInput) => {
    const storageFolder = input.storageFolder?.trim();
    if (!storageFolder) return getWorkspaceStore().create(input, app.getVersion());
    if (!path.isAbsolute(storageFolder)) throw new Error('Workspace location must be an absolute folder path.');
    const workspacePath = path.join(storageFolder, workspaceFileName(input.name));
    if (fs.existsSync(workspacePath)) throw new Error(`A workspace file already exists at ${workspacePath}.`);

    const workspace = await createWorkspaceInAppStore({ ...input, storageFolder: undefined }, app.getVersion());
    try {
      await createWorkspaceFile(workspacePath, workspace);
      await registerWorkspaceLocation({ id: workspace.id, path: workspacePath });
      resetWorkspaceScopes();
      // Remove the temporary app-owned record. The external file is now the
      // authoritative owner and remains user-owned if later deregistered.
      await getWorkspaceStore().remove(workspace.id);
      return getWorkspaceStore().get(workspace.id) ?? { ...workspace, storagePath: workspacePath };
    } catch (error) {
      await new WorkspaceStoreCleanup().removeBase(workspace.id);
      if (fs.existsSync(workspacePath)) await fs.promises.rm(workspacePath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  ipcMain.handle('workspaces:update', (_event, id: string, patch: UpdateWorkspaceInput) => getWorkspaceStore().update(id, patch, app.getVersion()));
  ipcMain.handle('workspaces:remove', async (_event, id: string) => {
    const workspace = getWorkspaceStore().get(id);
    await getWorkspaceStore().remove(id);
    if (workspace?.storagePath) await deregisterWorkspaceLocation(id);
    resetWorkspaceScopes();
  });
  ipcMain.handle('workspaces:saveToFile', async (_event, id: string) => {
    const workspace = getWorkspaceStore().get(id);
    if (!workspace) throw new Error(`Workspace ${id} was not found.`);
    const result = await dialog.showSaveDialog({
      title: 'Save Praxis Workspace', defaultPath: workspaceFileName(workspace.name),
      filters: WORKSPACE_FILE_FILTERS
    });
    if (result.canceled || !result.filePath) return undefined;
    const projects = getProjectStore().list().filter(project => workspace.projectIds.includes(project.id));
    const connections = getConnectionStore().getConnections().filter(connection => workspace.connectionIds.includes(connection.id));
    const boards = getConnectionStore().getTrackedBoards().filter(board => workspace.connectionIds.includes(board.connectionId));
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(toWorkspaceFile(workspace, { projects, connections, boards }), null, 2)}\n`, 'utf8');
    return result.filePath;
  });
  ipcMain.handle('workspaces:openFromFile', async () => {
    const result = await dialog.showOpenDialog({ title: 'Open Praxis Workspace', properties: ['openFile'], filters: WORKSPACE_FILE_FILTERS });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const filePath = path.resolve(result.filePaths[0]);
    const parsed = parseWorkspaceFile(await fs.promises.readFile(filePath, 'utf8'));
    await registerWorkspaceLocation({ id: parsed.id, path: filePath });
    resetWorkspaceScopes();
    return getWorkspaceStore().get(parsed.id);
  });
}

/** Removes a temporary app-owned record when located-file creation fails. */
class WorkspaceStoreCleanup {
  public async removeBase(id: string): Promise<void> {
    const store = getWorkspaceStore();
    try { await store.remove(id); } catch { /* preserve the original failure */ }
  }
}
