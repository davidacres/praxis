import { contextBridge, ipcRenderer } from 'electron';
import type { Board, BoardFilters, Connection, TicketManagerIpc } from '@ticket-manager/core';

const ticketManager: TicketManagerIpc = {
  board: {
    list: (filters: BoardFilters) => ipcRenderer.invoke('board:list', filters),
    get: (board: Board) => ipcRenderer.invoke('board:get', board)
  },
  issue: {
    get: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:get', issueKey, connectionId),
    transition: (issueKey: string, transitionId: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:transition', issueKey, transitionId, connectionId),
    addComment: (issueKey: string, body: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:addComment', issueKey, body, connectionId)
  },
  connection: {
    list: () => ipcRenderer.invoke('connection:list'),
    add: (connection: Connection) => ipcRenderer.invoke('connection:add', connection),
    remove: (connectionId: string) => ipcRenderer.invoke('connection:remove', connectionId)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (listener: (maximized: boolean) => void) => {
      // Wrap so the raw IpcRendererEvent never crosses the context bridge.
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
        listener(maximized);
      ipcRenderer.on('window:maximizeChanged', handler);
      return () => ipcRenderer.off('window:maximizeChanged', handler);
    }
  }
};

contextBridge.exposeInMainWorld('ticketManager', ticketManager);
