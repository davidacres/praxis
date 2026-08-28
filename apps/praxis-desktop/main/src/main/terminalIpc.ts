import { BrowserWindow, ipcMain } from 'electron';
import type { CreateTerminalInput } from '@praxis/core';
import { getTerminalManager } from './terminalManager';

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function registerTerminalIpc(): void {
  const manager = getTerminalManager();
  manager.onOutput(event => broadcast('terminal:output', event));
  manager.onExit(event => broadcast('terminal:exit', event));
  manager.onContextAvailability(event => broadcast('terminal:contextAvailability', event));
  manager.onCommand(event => broadcast('terminal:command', event));

  ipcMain.handle('terminal:listProfiles', () => manager.listProfiles());
  ipcMain.handle('terminal:list', () => manager.list());
  ipcMain.handle('terminal:create', (_event, input: CreateTerminalInput) => manager.create(input));
  ipcMain.handle('terminal:write', (_event, sessionId: string, data: string) => manager.write(sessionId, data));
  ipcMain.handle('terminal:resize', (_event, sessionId: string, cols: number, rows: number) => manager.resize(sessionId, cols, rows));
  ipcMain.handle('terminal:kill', (_event, sessionId: string) => manager.kill(sessionId));
  ipcMain.handle('terminal:getBuffer', (_event, sessionId: string) => manager.buffer(sessionId));
  ipcMain.handle('terminal:getContext', (_event, sessionId: string) => manager.context(sessionId));
  ipcMain.handle('terminal:listCommands', (_event, sessionId: string) => manager.commands(sessionId));
}
