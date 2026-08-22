import { ipcMain } from 'electron';
import type { Connection, TrackedBoard } from '@ticket-manager/core';
import { getConnectionStore } from './connectionStoreInstance';
import { getServiceForConnection, resetServiceForConnection } from './serviceRegistry';

export function registerConnectionIpc(): void {
  ipcMain.handle('connection:list', async () => getConnectionStore().getConnections());

  ipcMain.handle('connection:add', async (_event, connection: Connection) => {
    await getConnectionStore().addConnection(connection);
  });

  ipcMain.handle('connection:update', async (_event, connection: Connection) => {
    await getConnectionStore().updateConnection(connection);
    // The service cached for this connection captured the old settings (e.g. a
    // live folder path) at construction — drop it so the next call rebuilds.
    resetServiceForConnection(connection.id);
  });

  ipcMain.handle('connection:remove', async (_event, connectionId: string) => {
    await getConnectionStore().removeConnection(connectionId);
    resetServiceForConnection(connectionId);
  });

  ipcMain.handle('connection:generateId', async (_event, name: string) =>
    getConnectionStore().generateConnectionId(name)
  );

  ipcMain.handle('connection:check', async (_event, connectionId: string) => {
    return (await getServiceForConnection(connectionId)).checkConnection();
  });

  ipcMain.handle('connection:getTrackedBoards', async (_event, connectionId: string) =>
    getConnectionStore().getTrackedBoardsForConnection(connectionId)
  );

  ipcMain.handle('connection:addTrackedBoards', async (_event, boards: TrackedBoard[]) => {
    await getConnectionStore().addTrackedBoards(boards);
  });

  ipcMain.handle(
    'connection:removeTrackedBoard',
    async (_event, connectionId: string, boardId: string) => {
      await getConnectionStore().removeTrackedBoard({ connectionId, boardId });
    }
  );

  ipcMain.handle('connection:updateTrackedBoard', async (_event, board: TrackedBoard) => {
    await getConnectionStore().updateTrackedBoard(board);
  });

  ipcMain.handle(
    'connection:setSecret',
    async (_event, connectionId: string, name: string, value: string | undefined) => {
      await getConnectionStore().setSecret(connectionId, name, value);
      // Record the name so removeConnection's purge can find this secret later —
      // without the index entry the secret would leak past the connection's life.
      if (value !== undefined && value.length > 0) {
        await getConnectionStore().trackSecretName(connectionId, name);
      }
      resetServiceForConnection(connectionId);
    }
  );

  ipcMain.handle('connection:hasSecret', async (_event, connectionId: string, name: string) => {
    const value = await getConnectionStore().getSecret(connectionId, name);
    return value !== undefined && value.length > 0;
  });
}
