import { ipcMain } from 'electron';
import { discoverPlanFolders } from '@praxis/core';
import { getConnectionStore } from './connectionStoreInstance';
import { ElectronFolderConfigProvider } from './adapters/electronFolderConfigProvider';

export function registerFolderIpc(): void {
  ipcMain.handle('folder:discoverPlans', async (_event, connectionId: string) => {
    const connection = getConnectionStore().getConnection(connectionId);
    if (!connection || connection.mode !== 'folder') {
      throw new Error(`Connection ${connectionId} is not a folder connection.`);
    }
    const roots = new ElectronFolderConfigProvider(connection).getFolderRoots();
    if (roots.length === 0) {
      throw new Error(`Folder connection ${connectionId} has no folders configured.`);
    }
    // Union every configured root's plans folders, de-duplicated by path.
    const seen = new Set<string>();
    const discovered = [];
    for (const root of roots) {
      for (const match of await discoverPlanFolders(root)) {
        if (seen.has(match.plansRootPath.toLowerCase())) {
          continue;
        }
        seen.add(match.plansRootPath.toLowerCase());
        discovered.push(match);
      }
    }
    return discovered;
  });
}
