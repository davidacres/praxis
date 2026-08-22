import { ipcMain } from 'electron';
import { discoverPlanFolders } from '@ticket-manager/core';
import type { CreateBoardInput } from '@ticket-manager/core';
import { getServiceForConnection } from './serviceRegistry';

export function registerUserWorkspaceIpc(): void {
  ipcMain.handle('userWorkspace:discoverPlans', async (_event, folderPath: string) => {
    return discoverPlanFolders(folderPath);
  });

  ipcMain.handle(
    'userWorkspace:createBoard',
    async (_event, connectionId: string, input: CreateBoardInput) => {
      const service = await getServiceForConnection(connectionId);
      return service.createBoard(input);
    }
  );

  ipcMain.handle(
    'userWorkspace:deleteBoard',
    async (_event, connectionId: string, boardId: string) => {
      const service = await getServiceForConnection(connectionId);
      return service.deleteBoard(boardId);
    }
  );
}
