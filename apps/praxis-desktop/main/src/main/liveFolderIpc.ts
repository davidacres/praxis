import { ipcMain } from 'electron';
import { discoverPlanFolders } from '@praxis/core';
import { getConnectionStore } from './connectionStoreInstance';
import { ElectronLiveFolderConfigProvider } from './adapters/electronLiveFolderConfigProvider';

export function registerLiveFolderIpc(): void {
  ipcMain.handle('liveFolder:discoverPlans', async (_event, connectionId: string) => {
    const connection = getConnectionStore().getConnection(connectionId);
    if (!connection || connection.mode !== 'livefolder') {
      throw new Error(`Connection ${connectionId} is not a live folder connection.`);
    }
    const folderPath = new ElectronLiveFolderConfigProvider(connection).getLiveFolderPath();
    if (!folderPath) {
      throw new Error(`Live folder connection ${connectionId} has no path configured.`);
    }
    return discoverPlanFolders(folderPath);
  });
}
