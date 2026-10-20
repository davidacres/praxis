import * as path from 'node:path';
import { app } from 'electron';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getLogBus } from './logBusInstance';
import { broadcastToAllWindows } from './windowBroadcast';
import { attachLogPersistence } from './logPersistence';

/**
 * Registers the log IPC channels: `log:getRecent` (the ring-buffer backlog)
 * and the push channel `log:appended`, broadcast from the main-process log bus
 * to every live window. The bottom panel's Output tab tails this stream.
 *
 * History survives a restart: the previous session's lines are loaded into the
 * bus before the first renderer asks, and new lines are appended to
 * `<userData>/logs/application.log`.
 */
export function registerLogIpc(): void {
  try {
    attachLogPersistence(getLogBus(), path.join(app.getPath('userData'), 'logs'));
  } catch (error) {
    console.error('Log persistence unavailable:', error);
  }
  ipcMain.handle('log:getRecent', async () => getLogBus().recent());

  getLogBus().subscribe(line => {
    broadcastToAllWindows('log:appended', line);
  });
}
