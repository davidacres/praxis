import { ipcMain } from 'electron';
import type { Board, BoardFilters } from '@praxis/core';
import { getDemoService, isDemoModeEnabled } from './demoServiceInstance';
import { getServiceForConnection, getSupportedConnections } from './serviceRegistry';

export function registerBoardIpc(): void {
  ipcMain.handle(
    'board:list',
    async (_event: Electron.IpcMainInvokeEvent, filters: BoardFilters, connectionId?: string) => {
      // Per-connection listing (the connections manager's board picker): no demo
      // merge, just what that connection's backend reports.
      if (connectionId) {
        const boards = await (await getServiceForConnection(connectionId)).getBoards(filters);
        return boards.map(board => ({ ...board, connectionId }));
      }

      const demoBoards = isDemoModeEnabled()
        ? await getDemoService().getBoards(filters)
        : [];
      // `allSettled`, not `all`: a connection whose backing store is unreachable —
      // a folder on a disconnected drive, a deleted directory — must not take
      // the rest of the board list down with it. One bad connection used to reject
      // the whole handler, leaving the app with no boards at all and no error.
      const settled = await Promise.allSettled(
        getSupportedConnections().map(async connection => {
          const service = await getServiceForConnection(connection.id);
          const boards = await service.getBoards(filters);
          return boards.map(board => ({ ...board, connectionId: connection.id }));
        })
      );

      const connectionBoards: Board[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          connectionBoards.push(...result.value);
        } else {
          const connection = getSupportedConnections()[index];
          console.error(
            `board:list — skipping connection ${connection?.name ?? index} (${connection?.id ?? 'unknown'}):`,
            result.reason
          );
        }
      }

      return [...demoBoards, ...connectionBoards];
    }
  );

  ipcMain.handle('board:get', async (_event: Electron.IpcMainInvokeEvent, board: Board) => {
    const service = await getServiceForConnection(board.connectionId);
    return service.getBoardDetails(board);
  });
}
