import { BrowserWindow, ipcMain } from 'electron';
import type { AppSettingsPatch } from '@ticket-manager/core';
import { getSettingsBackend } from './settingsBackendInstance';

/**
 * Registers the settings IPC channels: `settings:get`, `settings:set`, and the
 * push channel `settings:changed` broadcast from main to every live window when
 * the backend fires `onDidChange` (either from a local `set` or from the VS
 * Code extension editing the same file).
 */
export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => getSettingsBackend().read());

  ipcMain.handle('settings:set', async (_event, patch: AppSettingsPatch) =>
    getSettingsBackend().write(patch)
  );

  getSettingsBackend().onDidChange(settings => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send('settings:changed', settings);
    }
  });
}
