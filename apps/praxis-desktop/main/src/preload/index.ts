import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentSessionRecord,
  AgentWorkflowReference,
  AiAnalysisState,
  AiDelegateInput,
  AiProvider,
  AiReviewProgress,
  AppSettings,
  AppSettingsPatch,
  Board,
  BoardColumnPreferences,
  BoardDraftRow,
  BoardFilters,
  Connection,
  CreateBoardInput,
  CreateIssueInput,
  CreateTerminalInput,
  IssueFilters,
  ParentItemQueryOptions,
  PermissionDecision,
  SessionMode,
  TaskDesignerPersistedState,
  TaskDesignerRecommendationConnector,
  TaskDesignerRecommendationNode,
  TicketManagerIpc,
  TrackedBoard,
  UpdateIssueInput
} from '@praxis/core';
import type { TerminalCommandEvent, TerminalContextAvailabilityEvent, TerminalExitEvent, TerminalOutputEvent } from '@praxis/core';
import type { AttachProjectFolderInput, CreateProjectInput, ProjectBoardReference, UpdateProjectInput } from '@praxis/core';

const ticketManager: TicketManagerIpc = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion')
  },
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
    getSelfAssigneeLabel: (connectionId?: string) =>
      ipcRenderer.invoke('issue:getSelfAssigneeLabel', connectionId),
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
    discoverBoardDrafts: (connectionId: string, folderPath: string) =>
      ipcRenderer.invoke('userWorkspace:discoverBoardDrafts', connectionId, folderPath),
    validateBoardDrafts: (connectionId: string, rows: BoardDraftRow[]) =>
      ipcRenderer.invoke('userWorkspace:validateBoardDrafts', connectionId, rows),
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
    reload: () => ipcRenderer.invoke('window:reload'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    supportsVibrancy: () => ipcRenderer.invoke('window:supportsVibrancy'),
    setSurfaceVibrancy: (mode: 'off' | 'glass') => ipcRenderer.invoke('window:setSurfaceVibrancy', mode),
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
    listProviderStatuses: () => ipcRenderer.invoke('ai:listProviderStatuses'),
    listCliModelOptions: (provider: AiProvider) => ipcRenderer.invoke('ai:listCliModelOptions', provider),
    listApiModelOptions: (provider: AiProvider, forceRefresh?: boolean) =>
      ipcRenderer.invoke('ai:listApiModelOptions', provider, forceRefresh),
    setProviderApiKey: (provider: AiProvider, value: string) =>
      ipcRenderer.invoke('ai:setProviderApiKey', provider, value),
    resetProviderApiKeys: () => ipcRenderer.invoke('ai:resetProviderApiKeys'),
    listSessions: () => ipcRenderer.invoke('ai:listSessions'),
    renameSession: (issueKey: string, title: string) =>
      ipcRenderer.invoke('ai:renameSession', issueKey, title),
    deleteSession: (issueKey: string) => ipcRenderer.invoke('ai:deleteSession', issueKey),
    delegate: (input: AiDelegateInput) => ipcRenderer.invoke('ai:delegate', input),
    abort: (issueKey: string) => ipcRenderer.invoke('ai:abort', issueKey),
    continueSession: (issueKey: string, message: string) =>
      ipcRenderer.invoke('ai:continueSession', issueKey, message),
    switchSessionMode: (issueKey: string, mode: SessionMode) =>
      ipcRenderer.invoke('ai:switchSessionMode', issueKey, mode),
    respondToPermission: (issueKey: string, decision: PermissionDecision) =>
      ipcRenderer.invoke('ai:respondToPermission', issueKey, decision),
    onSessionChanged: (listener: (record: AgentSessionRecord) => void) => {
      // Wrap so the raw IpcRendererEvent never crosses the context bridge.
      const handler = (_event: Electron.IpcRendererEvent, record: AgentSessionRecord) =>
        listener(record);
      ipcRenderer.on('ai:sessionChanged', handler);
      return () => ipcRenderer.off('ai:sessionChanged', handler);
    },
    onSessionDeleted: (listener: (issueKey: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, issueKey: string) => listener(issueKey);
      ipcRenderer.on('ai:sessionDeleted', handler);
      return () => ipcRenderer.off('ai:sessionDeleted', handler);
    },
    listWorkflowPacks: () => ipcRenderer.invoke('ai:listWorkflowPacks'),
    getWorkflowAssignment: (issueKey: string) =>
      ipcRenderer.invoke('ai:getWorkflowAssignment', issueKey),
    setWorkflowAssignment: (issueKey: string, workflow: AgentWorkflowReference | null) =>
      ipcRenderer.invoke('ai:setWorkflowAssignment', issueKey, workflow),
    reviewIssue: (issueKey: string, connectionId?: string, provider?: AiProvider, model?: string) =>
      ipcRenderer.invoke('ai:reviewIssue', issueKey, connectionId, provider, model),
    cancelReview: (issueKey: string) => ipcRenderer.invoke('ai:cancelReview', issueKey),
    localPeerReview: (issueKey: string, connectionId?: string, provider?: AiProvider, model?: string) =>
      ipcRenderer.invoke('ai:localPeerReview', issueKey, connectionId, provider, model),
    localPeerReviewFollowUp: (issueKey: string, message: string, connectionId?: string, provider?: AiProvider, model?: string) =>
      ipcRenderer.invoke('ai:localPeerReviewFollowUp', issueKey, message, connectionId, provider, model),
    onReviewProgress: (listener: (progress: AiReviewProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AiReviewProgress) =>
        listener(progress);
      ipcRenderer.on('ai:reviewProgress', handler);
      return () => ipcRenderer.off('ai:reviewProgress', handler);
    },
    getAnalysis: (issueKey: string) => ipcRenderer.invoke('ai:getAnalysis', issueKey),
    submitAnalysis: (
      issueKey: string,
      question: string,
      connectionId?: string,
      provider?: AiProvider,
      model?: string
    ) => ipcRenderer.invoke('ai:submitAnalysis', issueKey, question, connectionId, provider, model),
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
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
    create: (input: CreateProjectInput) => ipcRenderer.invoke('projects:create', input),
    update: (projectId: string, patch: UpdateProjectInput) => ipcRenderer.invoke('projects:update', projectId, patch),
    inspectFolder: (folderPath: string) => ipcRenderer.invoke('projects:inspectFolder', folderPath),
    attachFolder: (projectId: string, input: AttachProjectFolderInput) => ipcRenderer.invoke('projects:attachFolder', projectId, input),
    linkBoard: (projectId: string, board: ProjectBoardReference) => ipcRenderer.invoke('projects:linkBoard', projectId, board),
    unlinkBoard: (projectId: string, connectionId: string, boardId: string) => ipcRenderer.invoke('projects:unlinkBoard', projectId, connectionId, boardId)
  },
  terminal: {
    listProfiles: () => ipcRenderer.invoke('terminal:listProfiles'),
    list: () => ipcRenderer.invoke('terminal:list'),
    create: (input: CreateTerminalInput) => ipcRenderer.invoke('terminal:create', input),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),
    getBuffer: (sessionId: string) => ipcRenderer.invoke('terminal:getBuffer', sessionId),
    getContext: (sessionId: string) => ipcRenderer.invoke('terminal:getContext', sessionId),
    listCommands: (sessionId: string) => ipcRenderer.invoke('terminal:listCommands', sessionId),
    onOutput: (listener: (event: TerminalOutputEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, output: TerminalOutputEvent) => listener(output);
      ipcRenderer.on('terminal:output', handler);
      return () => ipcRenderer.off('terminal:output', handler);
    },
    onExit: (listener: (event: TerminalExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, exit: TerminalExitEvent) => listener(exit);
      ipcRenderer.on('terminal:exit', handler);
      return () => ipcRenderer.off('terminal:exit', handler);
    },
    onContextAvailability: (listener: (event: TerminalContextAvailabilityEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, availability: TerminalContextAvailabilityEvent) => listener(availability);
      ipcRenderer.on('terminal:contextAvailability', handler);
      return () => ipcRenderer.off('terminal:contextAvailability', handler);
    },
    onCommand: (listener: (event: TerminalCommandEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: TerminalCommandEvent) => listener(command);
      ipcRenderer.on('terminal:command', handler);
      return () => ipcRenderer.off('terminal:command', handler);
    }
  },
  agentRuntime: {
    list: () => ipcRenderer.invoke('agentRuntime:list'),
    refresh: () => ipcRenderer.invoke('agentRuntime:refresh'),
    start: (agentId: string) => ipcRenderer.invoke('agentRuntime:start', agentId),
    activateSkill: (agentId: string, skillName: string) => ipcRenderer.invoke('agentRuntime:activateSkill', agentId, skillName)
  },
  git: {
    preflight: (repositoryPath?: string) => ipcRenderer.invoke('git:preflight', repositoryPath),
    initialize: (repositoryPath: string) => ipcRenderer.invoke('git:initialize', repositoryPath),
    clone: (repositoryUrl: string, targetParent: string, targetName?: string) => ipcRenderer.invoke('git:clone', repositoryUrl, targetParent, targetName),
    open: (repositoryPath: string) => ipcRenderer.invoke('git:open', repositoryPath),
    refresh: (repositoryPath: string) => ipcRenderer.invoke('git:refresh', repositoryPath),
    status: (repositoryPath: string) => ipcRenderer.invoke('git:status', repositoryPath),
    getCommit: (repositoryPath: string, hash: string) => ipcRenderer.invoke('git:getCommit', repositoryPath, hash),
    getDiff: (repositoryPath: string, hash: string, filePath?: string) => ipcRenderer.invoke('git:getDiff', repositoryPath, hash, filePath),
    getComparison: (repositoryPath, request) => ipcRenderer.invoke('git:getComparison', repositoryPath, request),
    applyHunk: (repositoryPath, request) => ipcRenderer.invoke('git:applyHunk', repositoryPath, request),
    stage: (repositoryPath: string, paths: string[]) => ipcRenderer.invoke('git:stage', repositoryPath, paths),
    unstage: (repositoryPath: string, paths: string[]) => ipcRenderer.invoke('git:unstage', repositoryPath, paths),
    discard: (repositoryPath: string, paths: string[]) => ipcRenderer.invoke('git:discard', repositoryPath, paths),
    commit: (repositoryPath: string, message: string) => ipcRenderer.invoke('git:commit', repositoryPath, message),
    createBranch: (repositoryPath: string, name: string, startPoint?: string) => ipcRenderer.invoke('git:createBranch', repositoryPath, name, startPoint),
    checkout: (repositoryPath: string, name: string) => ipcRenderer.invoke('git:checkout', repositoryPath, name),
    deleteBranch: (repositoryPath: string, name: string) => ipcRenderer.invoke('git:deleteBranch', repositoryPath, name),
    renameBranch: (repositoryPath, oldName, newName) => ipcRenderer.invoke('git:renameBranch', repositoryPath, oldName, newName),
    merge: (repositoryPath, source) => ipcRenderer.invoke('git:merge', repositoryPath, source),
    rebase: (repositoryPath, target) => ipcRenderer.invoke('git:rebase', repositoryPath, target),
    getConflict: (repositoryPath, path) => ipcRenderer.invoke('git:getConflict', repositoryPath, path),
    resolveConflict: (repositoryPath, path, resolution) => ipcRenderer.invoke('git:resolveConflict', repositoryPath, path, resolution),
    abortConflict: (repositoryPath) => ipcRenderer.invoke('git:abortConflict', repositoryPath),
    getFileHistory: (repositoryPath, path, ref) => ipcRenderer.invoke('git:getFileHistory', repositoryPath, path, ref),
    getBlame: (repositoryPath, path, ref) => ipcRenderer.invoke('git:getBlame', repositoryPath, path, ref),
    cherryPick: (repositoryPath, commit) => ipcRenderer.invoke('git:cherryPick', repositoryPath, commit),
    revert: (repositoryPath, commit) => ipcRenderer.invoke('git:revert', repositoryPath, commit),
    stash: (repositoryPath, message) => ipcRenderer.invoke('git:stash', repositoryPath, message),
    popStash: (repositoryPath) => ipcRenderer.invoke('git:popStash', repositoryPath),
    pull: (repositoryPath: string) => ipcRenderer.invoke('git:pull', repositoryPath),
    fetch: (repositoryPath: string) => ipcRenderer.invoke('git:fetch', repositoryPath),
    push: (repositoryPath: string) => ipcRenderer.invoke('git:push', repositoryPath)
  }
};

contextBridge.exposeInMainWorld('ticketManager', ticketManager);
