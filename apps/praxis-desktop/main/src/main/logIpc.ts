import { ipcMain } from 'electron';
import { getLogBus } from './logBusInstance';
import { broadcastToAllWindows } from './windowBroadcast';

/**
 * Registers the log IPC channels: `log:getRecent` (the ring-buffer backlog)
 * and the push channel `log:appended`, broadcast from the main-process log bus
 * to every live window. The bottom panel's Output tab tails this stream.
 */
export function registerLogIpc(): void {
  ipcMain.handle('log:getRecent', async () => getLogBus().recent());

  getLogBus().subscribe(line => {
    broadcastToAllWindows('log:appended', line);
  });
}
