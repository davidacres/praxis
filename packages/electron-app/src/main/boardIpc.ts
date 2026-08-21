import { ipcMain } from 'electron';
import type { Board, BoardFilters } from '@ticket-manager/core';
import { getDemoService } from './demoServiceInstance';
import { getServiceForConnection, getSupportedConnections } from './serviceRegistry';

export function registerBoardIpc(): void {
  ipcMain.handle('board:list', async (_event: Electron.IpcMainInvokeEvent, filters: BoardFilters) => {
    const demoBoards = await getDemoService().getBoards(filters);

    const connectionBoards = await Promise.all(
      getSupportedConnections().map(async connection => {
        const service = getServiceForConnection(connection.id);
        const boards = await service.getBoards(filters);
        return boards.map(board => ({ ...board, connectionId: connection.id }));
      })
    );

    return [...demoBoards, ...connectionBoards.flat()];
  });

  ipcMain.handle('board:get', async (_event: Electron.IpcMainInvokeEvent, board: Board) => {
    const service = getServiceForConnection(board.connectionId);
    return service.getBoardDetails(board);
  });
}
