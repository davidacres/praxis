import { ipcMain } from 'electron';
import type { Connection } from '@ticket-manager/core';
import { getConnectionStore } from './connectionStoreInstance';

export function registerConnectionIpc(): void {
  ipcMain.handle('connection:list', async () => getConnectionStore().getConnections());

  ipcMain.handle('connection:add', async (_event, connection: Connection) => {
    await getConnectionStore().addConnection(connection);
  });

  ipcMain.handle('connection:remove', async (_event, connectionId: string) => {
    await getConnectionStore().removeConnection(connectionId);
  });
}
