import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  AppSettingsPatch,
  Board,
  BoardFilters,
  Connection,
  CreateBoardInput,
  CreateIssueInput,
  IssueFilters,
  ParentItemQueryOptions,
  TicketManagerIpc,
  TrackedBoard,
  UpdateIssueInput
} from '@ticket-manager/core';

const ticketManager: TicketManagerIpc = {
  board: {
    list: (filters: BoardFilters, connectionId?: string) =>
      ipcRenderer.invoke('board:list', filters, connectionId),
    get: (board: Board) => ipcRenderer.invoke('board:get', board)
  },
  issue: {
    get: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:get', issueKey, connectionId),
    create: (input: CreateIssueInput, connectionId?: string) =>
      ipcRenderer.invoke('issue:create', input, connectionId),
    update: (issueKey: string, input: UpdateIssueInput, connectionId?: string) =>
      ipcRenderer.invoke('issue:update', issueKey, input, connectionId),
    delete: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:delete', issueKey, connectionId),
    transition: (issueKey: string, transitionId: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:transition', issueKey, transitionId, connectionId),
    addComment: (issueKey: string, body: string, connectionId?: string) =>
      ipcRenderer.invoke('issue:addComment', issueKey, body, connectionId),
    getProjects: (connectionId?: string) => ipcRenderer.invoke('issue:getProjects', connectionId),
    getParentItems: (
      filters: IssueFilters,
      searchText?: string,
      options?: ParentItemQueryOptions,
      connectionId?: string
    ) => ipcRenderer.invoke('issue:getParentItems', filters, searchText, options, connectionId)
  },
  connection: {
    list: () => ipcRenderer.invoke('connection:list'),
    add: (connection: Connection) => ipcRenderer.invoke('connection:add', connection),
    update: (connection: Connection) => ipcRenderer.invoke('connection:update', connection),
    remove: (connectionId: string) => ipcRenderer.invoke('connection:remove', connectionId),
    generateId: (name: string) => ipcRenderer.invoke('connection:generateId', name),
    check: (connectionId: string) => ipcRenderer.invoke('connection:check', connectionId),
    getTrackedBoards: (connectionId: string) =>
      ipcRenderer.invoke('connection:getTrackedBoards', connectionId),
    addTrackedBoards: (boards: TrackedBoard[]) =>
      ipcRenderer.invoke('connection:addTrackedBoards', boards),
    removeTrackedBoard: (connectionId: string, boardId: string) =>
      ipcRenderer.invoke('connection:removeTrackedBoard', connectionId, boardId),
    updateTrackedBoard: (board: TrackedBoard) =>
      ipcRenderer.invoke('connection:updateTrackedBoard', board),
    setSecret: (connectionId: string, name: string, value: string | undefined) =>
      ipcRenderer.invoke('connection:setSecret', connectionId, name, value),
    hasSecret: (connectionId: string, name: string) =>
      ipcRenderer.invoke('connection:hasSecret', connectionId, name)
  },
  userWorkspace: {
    discoverPlans: (folderPath: string) =>
      ipcRenderer.invoke('userWorkspace:discoverPlans', folderPath),
    createBoard: (connectionId: string, input: CreateBoardInput) =>
      ipcRenderer.invoke('userWorkspace:createBoard', connectionId, input),
    deleteBoard: (connectionId: string, boardId: string) =>
      ipcRenderer.invoke('userWorkspace:deleteBoard', connectionId, boardId)
  },
  liveFolder: {
    discoverPlans: (connectionId: string) =>
      ipcRenderer.invoke('liveFolder:discoverPlans', connectionId)
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
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: AppSettingsPatch) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (listener: (settings: AppSettings) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: AppSettings) =>
        listener(settings);
      ipcRenderer.on('settings:changed', handler);
      return () => ipcRenderer.off('settings:changed', handler);
    }
  },
  dialog: {
    pickFolder: (title?: string) => ipcRenderer.invoke('dialog:pickFolder', title)
  }
};

contextBridge.exposeInMainWorld('ticketManager', ticketManager);
