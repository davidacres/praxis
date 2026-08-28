import { ipcMain } from 'electron';
import {
  discoverPlanFolders,
  discoverRepositoryFolders,
  planBoardDrafts,
  validateBoardDrafts
} from '@praxis/core';
import type { BoardDraftRow, CreateBoardInput } from '@praxis/core';
import { getServiceForConnection } from './serviceRegistry';

const EMPTY_BOARD_FILTERS = { projectKeys: [], types: [], searchText: '' };

/** Existing board plans-paths/project-keys for this connection, used to flag/reject dupes. */
async function existingBoardKeysAndPaths(
  connectionId: string
): Promise<{ existingPaths: string[]; existingKeys: string[] }> {
  const service = await getServiceForConnection(connectionId);
  const boards = await service.getBoards(EMPTY_BOARD_FILTERS);
  return {
    existingPaths: boards.map(board => board.locationName).filter((value): value is string => !!value),
    existingKeys: boards.map(board => board.projectKey).filter((value): value is string => !!value)
  };
}

export function registerUserWorkspaceIpc(): void {
  ipcMain.handle(
    'userWorkspace:discoverBoardDrafts',
    async (_event, connectionId: string, folderPath: string): Promise<BoardDraftRow[]> => {
      const [planRoots, repositoryPaths] = await Promise.all([
        discoverPlanFolders(folderPath),
        discoverRepositoryFolders(folderPath)
      ]);
      const { existingPaths, existingKeys } = await existingBoardKeysAndPaths(connectionId);
      return planBoardDrafts({
        repositories: repositoryPaths.map(rootPath => ({ rootPath })),
        planRoots: planRoots.map(match => ({
          plansPath: match.plansRootPath,
          featureEntryCount: match.featureEntries.length
        })),
        existingPaths,
        existingKeys
      });
    }
  );

  ipcMain.handle(
    'userWorkspace:validateBoardDrafts',
    async (_event, connectionId: string, rows: BoardDraftRow[]): Promise<string | undefined> => {
      const { existingKeys } = await existingBoardKeysAndPaths(connectionId);
      return validateBoardDrafts(rows, existingKeys);
    }
  );

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
