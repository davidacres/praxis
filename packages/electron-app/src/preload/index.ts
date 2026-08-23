import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentSessionRecord,
  AgentWorkflowReference,
  AiAnalysisState,
  AiDelegateInput,
  AiReviewProgress,
  AppSettings,
  AppSettingsPatch,
  Board,
  BoardColumnPreferences,
  BoardFilters,
  Connection,
  CreateBoardInput,
  CreateIssueInput,
  IssueFilters,
  ParentItemQueryOptions,
  TaskDesignerPersistedState,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode,
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
    list: (filters: IssueFilters, startAt: number, pageSize: number, connectionId?: string) =>
      ipcRenderer.invoke('issue:list', filters, startAt, pageSize, connectionId),
    getFilterMetadata: (filters: IssueFilters, connectionId?: string) =>
      ipcRenderer.invoke('issue:getFilterMetadata', filters, connectionId),
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
  log: {
    getRecent: () => ipcRenderer.invoke('log:getRecent'),
    onAppended: (listener: (line: string) => void) => {
      // Wrap so the raw IpcRendererEvent never crosses the context bridge.
      const handler = (_event: Electron.IpcRendererEvent, line: string) => listener(line);
      ipcRenderer.on('log:appended', handler);
      return () => ipcRenderer.off('log:appended', handler);
    }
  },
  dialog: {
    pickFolder: (title?: string) => ipcRenderer.invoke('dialog:pickFolder', title)
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },
  boardPrefs: {
    get: (boardId: string) => ipcRenderer.invoke('boardPrefs:get', boardId),
    set: (boardId: string, prefs: BoardColumnPreferences) =>
      ipcRenderer.invoke('boardPrefs:set', boardId, prefs)
  },
  ai: {
    getStatus: () => ipcRenderer.invoke('ai:getStatus'),
    setApiKey: (value: string) => ipcRenderer.invoke('ai:setApiKey', value),
    listSessions: () => ipcRenderer.invoke('ai:listSessions'),
    delegate: (input: AiDelegateInput) => ipcRenderer.invoke('ai:delegate', input),
    abort: (issueKey: string) => ipcRenderer.invoke('ai:abort', issueKey),
    onSessionChanged: (listener: (record: AgentSessionRecord) => void) => {
      // Wrap so the raw IpcRendererEvent never crosses the context bridge.
      const handler = (_event: Electron.IpcRendererEvent, record: AgentSessionRecord) =>
        listener(record);
      ipcRenderer.on('ai:sessionChanged', handler);
      return () => ipcRenderer.off('ai:sessionChanged', handler);
    },
    listWorkflowPacks: () => ipcRenderer.invoke('ai:listWorkflowPacks'),
    getWorkflowAssignment: (issueKey: string) =>
      ipcRenderer.invoke('ai:getWorkflowAssignment', issueKey),
    setWorkflowAssignment: (issueKey: string, workflow: AgentWorkflowReference | null) =>
      ipcRenderer.invoke('ai:setWorkflowAssignment', issueKey, workflow),
    reviewIssue: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:reviewIssue', issueKey, connectionId),
    cancelReview: (issueKey: string) => ipcRenderer.invoke('ai:cancelReview', issueKey),
    localPeerReview: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:localPeerReview', issueKey, connectionId),
    onReviewProgress: (listener: (progress: AiReviewProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AiReviewProgress) =>
        listener(progress);
      ipcRenderer.on('ai:reviewProgress', handler);
      return () => ipcRenderer.off('ai:reviewProgress', handler);
    },
    getAnalysis: (issueKey: string) => ipcRenderer.invoke('ai:getAnalysis', issueKey),
    submitAnalysis: (issueKey: string, question: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:submitAnalysis', issueKey, question, connectionId),
    cancelAnalysis: (issueKey: string) => ipcRenderer.invoke('ai:cancelAnalysis', issueKey),
    setAnalysisConfirmed: (issueKey: string, confirmed: boolean) =>
      ipcRenderer.invoke('ai:setAnalysisConfirmed', issueKey, confirmed),
    clearAnalysis: (issueKey: string) => ipcRenderer.invoke('ai:clearAnalysis', issueKey),
    onAnalysisChanged: (listener: (state: AiAnalysisState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AiAnalysisState) =>
        listener(state);
      ipcRenderer.on('ai:analysisChanged', handler);
      return () => ipcRenderer.off('ai:analysisChanged', handler);
    },
    startDelivery: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:startDelivery', issueKey, connectionId),
    decomposeFeature: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:decomposeFeature', issueKey, connectionId),
    startSubTaskDelivery: (parentIssueKey: string, subTaskKey: string, connectionId?: string) =>
      ipcRenderer.invoke('ai:startSubTaskDelivery', parentIssueKey, subTaskKey, connectionId),
    listMergeRequests: (issueKey: string, connectionId: string) =>
      ipcRenderer.invoke('ai:listMergeRequests', issueKey, connectionId),
    createMergeRequest: (issueKey: string, connectionId: string) =>
      ipcRenderer.invoke('ai:createMergeRequest', issueKey, connectionId),
    checkMergeRequestFeedback: (issueKey: string, connectionId: string) =>
      ipcRenderer.invoke('ai:checkMergeRequestFeedback', issueKey, connectionId)
  },
  taskDesigner: {
    getState: (boardId: string, connectionId?: string) =>
      ipcRenderer.invoke('taskDesigner:getState', boardId, connectionId),
    setState: (boardId: string, connectionId: string | undefined, state: TaskDesignerPersistedState) =>
      ipcRenderer.invoke('taskDesigner:setState', boardId, connectionId, state),
    resolveIssue: (issueKey: string, connectionId?: string) =>
      ipcRenderer.invoke('taskDesigner:resolveIssue', issueKey, connectionId),
    recommendFlow: (
      nodes: TaskDesignerRecommendationNode[],
      connectors: TaskDesignerRecommendationConnector[]
    ) => ipcRenderer.invoke('taskDesigner:recommendFlow', nodes, connectors),
    recommendBoardFlow: (board: Board) =>
      ipcRenderer.invoke('taskDesigner:recommendBoardFlow', board),
    generateMasterPlan: (
      boardId: string,
      connectionId: string | undefined,
      state: TaskDesignerPersistedState
    ) => ipcRenderer.invoke('taskDesigner:generateMasterPlan', boardId, connectionId, state)
  }
};

contextBridge.exposeInMainWorld('ticketManager', ticketManager);
