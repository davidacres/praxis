import { ipcMain } from 'electron';
import type { BoardColumnPreferences } from '@ticket-manager/core';
import { getBoardPreferencesStore } from './boardPreferencesInstance';

/**
 * Registers the board-preferences IPC channels. No push channel: the board
 * view is the only writer and owns its state after a successful `set`.
 */
export function registerBoardPrefsIpc(): void {
  ipcMain.handle('boardPrefs:get', async (_event, boardId: string) =>
    getBoardPreferencesStore().getPreferences(boardId)
  );

  ipcMain.handle('boardPrefs:set', async (_event, boardId: string, prefs: BoardColumnPreferences) =>
    getBoardPreferencesStore().setPreferences(boardId, prefs)
  );
}
