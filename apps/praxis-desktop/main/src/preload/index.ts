import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentSessionRecord,
  AgentWorkflowReference,
  AiAnalysisState,
  AiDelegateInput,
  AiHandoverBriefEdits,
  AiHandoverInput,
  AiConversationMessageInput,
  AiStartConversationInput,
  WireImageAttachment,
  AiProvider,
  AiTicketReviewInput,
  AppSettings,
  AppSettingsPatch,
  Board,
  BoardColumnPreferences,
  BoardFilters,
  BrowserNavigationState,
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
  PraxisIpc,
  TrackedBoard,
  UpdateIssueInput
} from '@praxis/core';
import type { TerminalCommandEvent, TerminalContextAvailabilityEvent, TerminalExitEvent, TerminalOutputEvent, UpdateStatus } from '@praxis/core';
import type { AttachProjectFolderInput, CreateProjectInput, ProjectBoardReference, ProjectDocument, ProjectImportRow, UpdateProjectInput } from '@praxis/core';
import type { ProposedRunService, RunProfile, RunProfileIssue, RunProfileValidationResult } from '@praxis/core';
import type { ReconciledService, RunLogLine, RunServiceStatus } from '@praxis/core';
import type { BrowserDiagnosticsBundle } from '@praxis/core';
import type { CreateDiagnosisSessionResult, PreviewVerificationCheck, PreviewVerificationOutcome } from '@praxis/core';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '@praxis/core';
import type { WorkflowDefinition, WorkflowPlanInput, WorkflowPolicyProfile } from '@praxis/core';
import type { DeploymentProfile, DeploymentProfileIssue, PublishedArtifact } from '@praxis/core';
import type { CredentialBindingStatus } from '@praxis/core';
import type { DeploymentRun } from '@praxis/core';
import type { PublishManifest } from '@praxis/core';
import type { DeploymentHealthResult } from '@praxis/core';
import type { WorkflowEvidenceSourceRef } from '@praxis/core';
import type { AgentRecommendationCandidate } from '@praxis/core';
import type { UsageGranularity } from '@praxis/core';

const praxis: PraxisIpc = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    // Update checking. Inert in development and in a build published without a
    // feed — `getStatus` reports `unsupported` with the reason in that case.
    update: {
      getStatus: () => ipcRenderer.invoke('update:getStatus'),
      check: () => ipcRenderer.invoke('update:check'),
      download: () => ipcRenderer.invoke('update:download'),
      installNow: () => ipcRenderer.invoke('update:installNow'),
      onStatus: (listener: (status: UpdateStatus) => void) => {
        const handler = (_event: unknown, status: UpdateStatus) => listener(status);
        ipcRenderer.on('update:status', handler);
        return () => {
          ipcRenderer.removeListener('update:status', handler);
        };
      }
    }
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
  folder: {
    discoverPlans: (connectionId: string) =>
      ipcRenderer.invoke('folder:discoverPlans', connectionId)
  },
  window: {
    reload: () => ipcRenderer.invoke('window:reload'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    confirmClose: () => ipcRenderer.invoke('window:confirmClose'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    supportsVibrancy: () => ipcRenderer.invoke('window:supportsVibrancy'),
    setSurfaceVibrancy: (mode: 'off' | 'glass') => ipcRenderer.invoke('window:setSurfaceVibrancy', mode),
    onMaximizeChange: (listener: (maximized: boolean) => void) => {
      // Wrap so the raw IpcRendererEvent never crosses the context bridge.
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
        listener(maximized);
      ipcRenderer.on('window:maximizeChanged', handler);
      return () => ipcRenderer.off('window:maximizeChanged', handler);
    },
    onCloseRequested: (listener: (request: { runningSessionCount: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, request: { runningSessionCount: number }) =>
        listener(request);
      ipcRenderer.on('window:closeRequested', handler);
      return () => ipcRenderer.off('window:closeRequested', handler);
    },
    getZoomFactor: () => ipcRenderer.invoke('window:getZoomFactor') as Promise<number>,
    setZoomFactor: (factor: number) => ipcRenderer.invoke('window:setZoomFactor', factor) as Promise<number>,
    onZoomChange: (listener: (factor: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, factor: number) => listener(factor);
      ipcRenderer.on('window:zoomChanged', handler);
      return () => ipcRenderer.off('window:zoomChanged', handler);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: AppSettingsPatch) => ipcRenderer.invoke('settings:set', patch),
    getMobileHostInfo: () => ipcRenderer.invoke('settings:getMobileHostInfo'),
    publishMobileAppearance: (appearance) => ipcRenderer.invoke('settings:publishMobileAppearance', appearance),
    createMobilePairingInvitation: () => ipcRenderer.invoke('settings:createMobilePairingInvitation'),
    confirmMobilePairing: (requestId, grant) => ipcRenderer.invoke('settings:confirmMobilePairing', requestId, grant),
    denyMobilePairing: (requestId) => ipcRenderer.invoke('settings:denyMobilePairing', requestId),
    revokeMobilePairedDevice: (deviceId) => ipcRenderer.invoke('settings:revokeMobilePairedDevice', deviceId),
    rotateMobileHostKey: () => ipcRenderer.invoke('settings:rotateMobileHostKey'),
    onMobilePairingChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot);
      ipcRenderer.on('mobile:pairingChanged', handler);
      return () => ipcRenderer.off('mobile:pairingChanged', handler);
    },
    clearSessionData: () => ipcRenderer.invoke('settings:clearSessionData'),
    clearProjectWorkspaceBoardData: () => ipcRenderer.invoke('settings:clearProjectWorkspaceBoardData'),
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
  browser: {
    attach: () => ipcRenderer.invoke('browser:attach'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:setBounds', bounds),
    setVisible: (visible: boolean) => ipcRenderer.invoke('browser:setVisible', visible),
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    getState: () => ipcRenderer.invoke('browser:getState'),
    onDidNavigate: (listener: (state: BrowserNavigationState) => void) => {
      const handler = (_event: unknown, state: BrowserNavigationState) => listener(state);
      ipcRenderer.on('browser:didNavigate', handler);
      return () => ipcRenderer.off('browser:didNavigate', handler);
    }
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
    probeProviderCapability: (provider: AiProvider) => ipcRenderer.invoke('ai:probeProviderCapability', provider),
    listCliModelOptions: (provider: AiProvider) => ipcRenderer.invoke('ai:listCliModelOptions', provider),
    listApiModelOptions: (provider: AiProvider, forceRefresh?: boolean) =>
      ipcRenderer.invoke('ai:listApiModelOptions', provider, forceRefresh),
    setProviderApiKey: (provider: AiProvider, value: string) =>
      ipcRenderer.invoke('ai:setProviderApiKey', provider, value),
    testProviderApiKey: (provider: AiProvider) =>
      ipcRenderer.invoke('ai:testProviderApiKey', provider),
    resetProviderApiKeys: () => ipcRenderer.invoke('ai:resetProviderApiKeys'),
    listSessions: () => ipcRenderer.invoke('ai:listSessions'),
    loadImagePreview: (issueKey: string, filePath: string) =>
      ipcRenderer.invoke('ai:loadImagePreview', issueKey, filePath) as Promise<string | undefined>,
    renameSession: (issueKey: string, title: string) =>
      ipcRenderer.invoke('ai:renameSession', issueKey, title),
    deleteSession: (issueKey: string) => ipcRenderer.invoke('ai:deleteSession', issueKey),
    archiveSession: (issueKey: string, archived: boolean) =>
      ipcRenderer.invoke('ai:archiveSession', issueKey, archived),
    delegate: (input: AiDelegateInput) => ipcRenderer.invoke('ai:delegate', input),
    abort: (issueKey: string) => ipcRenderer.invoke('ai:abort', issueKey),
    continueSession: (issueKey: string, message: string, images?: WireImageAttachment[]) =>
      ipcRenderer.invoke('ai:continueSession', issueKey, message, images),
    updateSessionModel: (issueKey: string, model: string) =>
      ipcRenderer.invoke('ai:updateSessionModel', issueKey, model),
    handoverSession: (issueKey: string, input: AiHandoverInput) =>
      ipcRenderer.invoke('ai:handoverSession', issueKey, input),
    startConversation: (issueKey: string, input: AiStartConversationInput) =>
      ipcRenderer.invoke('ai:startConversation', issueKey, input),
    sendConversationMessage: (issueKey: string, input: AiConversationMessageInput) =>
      ipcRenderer.invoke('ai:sendConversationMessage', issueKey, input),
    stopConversation: (issueKey: string) => ipcRenderer.invoke('ai:stopConversation', issueKey),
    setConversationToolOwner: (issueKey: string, participantId: string) =>
      ipcRenderer.invoke('ai:setConversationToolOwner', issueKey, participantId),
    editHandoverBrief: (issueKey: string, expectedRevision: number, edits: AiHandoverBriefEdits) =>
      ipcRenderer.invoke('ai:editHandoverBrief', issueKey, expectedRevision, edits),
    removeWorktree: (issueKey: string) => ipcRenderer.invoke('ai:removeWorktree', issueKey),
    switchSessionMode: (issueKey: string, mode: SessionMode) =>
      ipcRenderer.invoke('ai:switchSessionMode', issueKey, mode),
    setAcpMode: (issueKey: string, modeId: string) => ipcRenderer.invoke('ai:setAcpMode', issueKey, modeId),
    respondToPermission: (issueKey: string, decision: PermissionDecision) =>
      ipcRenderer.invoke('ai:respondToPermission', issueKey, decision),
    undoToolFileChange: (issueKey: string, eventTimestamp: string, path: string) =>
      ipcRenderer.invoke('ai:undoToolFileChange', issueKey, eventTimestamp, path),
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
    startTicketReview: (input: AiTicketReviewInput) => ipcRenderer.invoke('ai:startTicketReview', input),
    getTicketReview: (issueKey: string) => ipcRenderer.invoke('ai:getTicketReview', issueKey),
    localPeerReview: (issueKey: string, connectionId?: string, provider?: AiProvider, model?: string) =>
      ipcRenderer.invoke('ai:localPeerReview', issueKey, connectionId, provider, model),
    localPeerReviewFollowUp: (issueKey: string, message: string, connectionId?: string, provider?: AiProvider, model?: string) =>
      ipcRenderer.invoke('ai:localPeerReviewFollowUp', issueKey, message, connectionId, provider, model),
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
  aiUsage: {
    series: (granularity: UsageGranularity, periodsBack: number) =>
      ipcRenderer.invoke('aiUsage:series', granularity, periodsBack),
    compareLatestPeriod: (granularity: UsageGranularity) =>
      ipcRenderer.invoke('aiUsage:compareLatestPeriod', granularity),
    listEvents: () => ipcRenderer.invoke('aiUsage:listEvents'),
    providerSnapshot: (provider: AiProvider) => ipcRenderer.invoke('aiUsage:providerSnapshot', provider),
    setProviderUsageKey: (provider: AiProvider, value: string) => ipcRenderer.invoke('aiUsage:setProviderUsageKey', provider, value)
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
  workflows: {
    listTemplates: (projectId: string) => ipcRenderer.invoke('workflows:listTemplates', projectId),
    getRecommendedTemplate: (projectId: string) => ipcRenderer.invoke('workflows:getRecommendedTemplate', projectId),
    recommendTemplate: (projectId: string) => ipcRenderer.invoke('workflows:recommendTemplate', projectId),
    recommendModelTiers: (projectId: string, definition: unknown) =>
      ipcRenderer.invoke('workflows:recommendModelTiers', projectId, definition),
    templateReadiness: (projectId: string) => ipcRenderer.invoke('workflows:templateReadiness', projectId),
    catalog: (projectId: string) => ipcRenderer.invoke('workflows:catalog', projectId),
    get: (projectId: string, workflowId: string) => ipcRenderer.invoke('workflows:get', projectId, workflowId),
    instantiate: (projectId: string, templateId: string, name?: string) =>
      ipcRenderer.invoke('workflows:instantiate', projectId, templateId, name),
    promotePack: (projectId: string, packId: string, binding: { agentId: string; profileId?: string; hostId?: string }) =>
      ipcRenderer.invoke('workflows:promotePack', projectId, packId, binding),
    save: (projectId: string, definition: WorkflowDefinition) =>
      ipcRenderer.invoke('workflows:save', projectId, definition),
    remove: (projectId: string, workflowId: string) => ipcRenderer.invoke('workflows:remove', projectId, workflowId),
    validate: (projectId: string, definition: WorkflowDefinition) =>
      ipcRenderer.invoke('workflows:validate', projectId, definition),
    assistant: (projectId: string, definition: WorkflowDefinition, message: string, history?: readonly { role: 'user' | 'assistant'; text: string }[]) =>
      ipcRenderer.invoke('workflows:assistant', projectId, definition, message, history),
    effectivePolicy: (projectId: string) => ipcRenderer.invoke('workflows:effectivePolicy', projectId),
    listPolicies: () => ipcRenderer.invoke('workflows:listPolicies'),
    savePolicy: (profile: WorkflowPolicyProfile) => ipcRenderer.invoke('workflows:savePolicy', profile),
    removePolicy: (profileId: string) => ipcRenderer.invoke('workflows:removePolicy', profileId),
    startRun: (projectId: string, workflowId: string, taskTitle: string, issue?: { issueKey: string; connectionId?: string }, controller?: { sessionKey: string; sessionId: string }, planInput?: WorkflowPlanInput, options?: { permissionMode?: 'ask' | 'auto'; uncommittedChanges?: 'include' | 'omit'; providerLimitPolicy?: 'ask' | 'switch' | 'stop' }) =>
      ipcRenderer.invoke('workflows:startRun', projectId, workflowId, taskTitle, issue, controller, planInput, options),
    checkRunBase: (projectId: string) => ipcRenderer.invoke('workflows:checkRunBase', projectId),
    commitRunBase: (projectId: string, message: string) => ipcRenderer.invoke('workflows:commitRunBase', projectId, message),
    selectControllerRun: (sessionKey: string, runId: string) =>
      ipcRenderer.invoke('workflows:selectControllerRun', sessionKey, runId),
    removeControllerRun: (sessionKey: string, runId: string, reason?: string) =>
      ipcRenderer.invoke('workflows:removeControllerRun', sessionKey, runId, reason),
    listRuns: (projectId: string) => ipcRenderer.invoke('workflows:listRuns', projectId),
    getRun: (runId: string) => ipcRenderer.invoke('workflows:getRun', runId),
    advanceStage: (
      runId: string,
      nodeId: string,
      outcome: 'succeeded' | 'failed',
      detail?: { error?: string; snapshotRef?: string }
    ) => ipcRenderer.invoke('workflows:advanceStage', runId, nodeId, outcome, detail),
    approveRun: (runId: string, actor: string, note?: string, nodeId?: string) =>
      ipcRenderer.invoke('workflows:approveRun', runId, actor, note, nodeId),
    bypassGate: (runId: string, gate: string, actor: string, reason: string, nodeId?: string) =>
      ipcRenderer.invoke('workflows:bypassGate', runId, gate, actor, reason, nodeId),
    retryStage: (runId: string, nodeId: string) => ipcRenderer.invoke('workflows:retryStage', runId, nodeId),
    switchStageProvider: (runId: string, nodeId: string, provider: string) =>
      ipcRenderer.invoke('workflows:switchStageProvider', runId, nodeId, provider),
    stopForProviderLimit: (runId: string, nodeId: string) => ipcRenderer.invoke('workflows:stopForProviderLimit', runId, nodeId),
    reworkStage: (runId: string, nodeId: string) => ipcRenderer.invoke('workflows:reworkStage', runId, nodeId),
    cancelRun: (runId: string, reason?: string) => ipcRenderer.invoke('workflows:cancelRun', runId, reason),
    inspectRunWork: (runId: string) => ipcRenderer.invoke('workflows:inspectRunWork', runId),
    deleteRun: (runId: string, options?: { deleteWork?: boolean }) => ipcRenderer.invoke('workflows:deleteRun', runId, options),
    archiveRun: (runId: string, archived: boolean) => ipcRenderer.invoke('workflows:archiveRun', runId, archived),
    onRunChanged: (listener: (runId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, runId: string) => listener(runId);
      ipcRenderer.on('workflows:runChanged', handler);
      return () => ipcRenderer.off('workflows:runChanged', handler);
    },
    getEvidence: (runId: string, nodeId: string, attempt: number) =>
      ipcRenderer.invoke('workflows:getEvidence', runId, nodeId, attempt),
    startDiagnosis: (runId: string, nodeId: string, attempt: number) =>
      ipcRenderer.invoke('workflows:startDiagnosis', runId, nodeId, attempt),
    getRecommendation: (
      workflowId: string,
      nodeId: string,
      input: { stageName: string; instructions: string; candidates: AgentRecommendationCandidate[] }
    ) => ipcRenderer.invoke('workflows:getRecommendation', workflowId, nodeId, input),
    recommendAgent: (
      workflowId: string,
      nodeId: string,
      input: { stageName: string; instructions: string; candidates: AgentRecommendationCandidate[] }
    ) => ipcRenderer.invoke('workflows:recommendAgent', workflowId, nodeId, input)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
    create: (input: CreateProjectInput, workspaceId: string) => ipcRenderer.invoke('projects:create', input, workspaceId),
    useExisting: (projectId: string, workspaceId: string) => ipcRenderer.invoke('projects:useExisting', projectId, workspaceId),
    remove: (projectId: string) => ipcRenderer.invoke('projects:remove', projectId),
    update: (projectId: string, patch: UpdateProjectInput) => ipcRenderer.invoke('projects:update', projectId, patch),
    inspectFolder: (folderPath: string) => ipcRenderer.invoke('projects:inspectFolder', folderPath),
    attachFolder: (projectId: string, input: AttachProjectFolderInput) => ipcRenderer.invoke('projects:attachFolder', projectId, input),
    linkBoard: (projectId: string, board: ProjectBoardReference) => ipcRenderer.invoke('projects:linkBoard', projectId, board),
    unlinkBoard: (projectId: string, connectionId: string, boardId: string) => ipcRenderer.invoke('projects:unlinkBoard', projectId, connectionId, boardId)
    ,listDocuments: (projectId: string) => ipcRenderer.invoke('projects:listDocuments', projectId)
    ,readDocument: (projectId: string, relativePath: string) => ipcRenderer.invoke('projects:readDocument', projectId, relativePath)
    ,discoverImports: (folderPath: string) => ipcRenderer.invoke('projects:discoverImports', folderPath)
    ,validateImports: (rows: ProjectImportRow[]) => ipcRenderer.invoke('projects:validateImports', rows)
    ,createFromImports: (rows: ProjectImportRow[], workspaceId: string) => ipcRenderer.invoke('projects:createFromImports', rows, workspaceId)
    ,getRunProfile: (projectId: string) =>
      ipcRenderer.invoke('projects:getRunProfile', projectId) as Promise<{ profile?: RunProfile; issues: RunProfileIssue[] }>
    ,saveRunProfile: (projectId: string, profile: RunProfile) => ipcRenderer.invoke('projects:saveRunProfile', projectId, profile)
    ,discoverRunServices: (projectId: string) =>
      ipcRenderer.invoke('projects:discoverRunServices', projectId) as Promise<Array<ProposedRunService & { relativeDir: string }>>
    ,validateRunProfile: (profile: RunProfile) =>
      ipcRenderer.invoke('projects:validateRunProfile', profile) as Promise<RunProfileValidationResult>
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    get: (workspaceId: string) => ipcRenderer.invoke('workspaces:get', workspaceId),
    create: (input: CreateWorkspaceInput) => ipcRenderer.invoke('workspaces:create', input),
    setActive: (workspaceId: string | undefined) => ipcRenderer.invoke('workspaces:setActive', workspaceId),
    update: (workspaceId: string, patch: UpdateWorkspaceInput) => ipcRenderer.invoke('workspaces:update', workspaceId, patch),
    remove: (workspaceId: string) => ipcRenderer.invoke('workspaces:remove', workspaceId),
    saveToFile: (workspaceId: string) => ipcRenderer.invoke('workspaces:saveToFile', workspaceId),
    openFromFile: () => ipcRenderer.invoke('workspaces:openFromFile')
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
    stop: (agentId: string) => ipcRenderer.invoke('agentRuntime:stop', agentId),
    restart: (agentId: string) => ipcRenderer.invoke('agentRuntime:restart', agentId),
    roots: () => ipcRenderer.invoke('agentRuntime:roots'),
    activateSkill: (agentId: string, skillName: string) => ipcRenderer.invoke('agentRuntime:activateSkill', agentId, skillName),
    createAgent: (input: unknown) => ipcRenderer.invoke('agentRuntime:createAgent', input),
    createProfile: (input: unknown) => ipcRenderer.invoke('agentRuntime:createProfile', input),
    createSkill: (input: unknown) => ipcRenderer.invoke('agentRuntime:createSkill', input),
    previewImport: (kind: string, sourceDir: string, scope: string) =>
      ipcRenderer.invoke('agentRuntime:previewImport', kind, sourceDir, scope),
    importItem: (kind: string, sourceDir: string, scope: string, onDuplicate: string) =>
      ipcRenderer.invoke('agentRuntime:importItem', kind, sourceDir, scope, onDuplicate),
    approveNativeProject: (projectRoot: string, approved: boolean) =>
      ipcRenderer.invoke('agentRuntime:approveNativeProject', projectRoot, approved),
    revealNative: (itemPath: string) => ipcRenderer.invoke('agentRuntime:revealNative', itemPath),
    copyNative: (kind: string, id: string) => ipcRenderer.invoke('agentRuntime:copyNative', kind, id)
  },
  gadgets: {
    getBlocks: (sessionId: string) => ipcRenderer.invoke('gadgets:getBlocks', sessionId),
    publish: (sessionId: string, blocks: unknown[]) => ipcRenderer.invoke('gadgets:publish', sessionId, blocks),
    publishFromText: (sessionId: string, idPrefix: string, text: string) =>
      ipcRenderer.invoke('gadgets:publishFromText', sessionId, idPrefix, text),
    submit: (input: unknown) => ipcRenderer.invoke('gadgets:submit', input),
    replay: (afterSequence: number) => ipcRenderer.invoke('gadgets:replay', afterSequence),
    revoke: (sessionId: string, gadgetId: string) => ipcRenderer.invoke('gadgets:revoke', sessionId, gadgetId),
    clear: (sessionId: string) => ipcRenderer.invoke('gadgets:clear', sessionId),
    onChanged: (callback: (sessionId: string) => void) => {
      const listener = (_event: unknown, sessionId: string) => callback(sessionId);
      ipcRenderer.on('gadgets:changed', listener);
      return () => ipcRenderer.removeListener('gadgets:changed', listener);
    }
  },
  marketplace: {
    getStatus: () => ipcRenderer.invoke('marketplace:getStatus'),
    configure: (patch: unknown) => ipcRenderer.invoke('marketplace:configure', patch),
    setToken: (token: string | null) => ipcRenderer.invoke('marketplace:setToken', token),
    listCatalog: () => ipcRenderer.invoke('marketplace:listCatalog'),
    listInstalled: () => ipcRenderer.invoke('marketplace:listInstalled'),
    listActiveAppearance: () => ipcRenderer.invoke('marketplace:listActiveAppearance'),
    install: (packageName: string, options?: unknown) =>
      ipcRenderer.invoke('marketplace:install', packageName, options),
    update: (kind: string, id: string) => ipcRenderer.invoke('marketplace:update', kind, id),
    remove: (kind: string, id: string) => ipcRenderer.invoke('marketplace:remove', kind, id),
    checkForUpdates: () => ipcRenderer.invoke('marketplace:checkForUpdates'),
    setTrust: (kind: string, id: string, enabled: boolean) =>
      ipcRenderer.invoke('marketplace:setTrust', kind, id, enabled),
    onChanged: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on('marketplace:changed', handler);
      return () => {
        ipcRenderer.removeListener('marketplace:changed', handler);
      };
    }
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
    getFileContent: (repositoryPath: string, path: string) => ipcRenderer.invoke('git:getFileContent', repositoryPath, path),
    getFileHistory: (repositoryPath, path, ref) => ipcRenderer.invoke('git:getFileHistory', repositoryPath, path, ref),
    getBlame: (repositoryPath, path, ref) => ipcRenderer.invoke('git:getBlame', repositoryPath, path, ref),
    cherryPick: (repositoryPath, commit) => ipcRenderer.invoke('git:cherryPick', repositoryPath, commit),
    revert: (repositoryPath, commit) => ipcRenderer.invoke('git:revert', repositoryPath, commit),
    stash: (repositoryPath, message) => ipcRenderer.invoke('git:stash', repositoryPath, message),
    popStash: (repositoryPath) => ipcRenderer.invoke('git:popStash', repositoryPath),
    pull: (repositoryPath: string) => ipcRenderer.invoke('git:pull', repositoryPath),
    fetch: (repositoryPath: string) => ipcRenderer.invoke('git:fetch', repositoryPath),
    push: (repositoryPath: string) => ipcRenderer.invoke('git:push', repositoryPath)
  },
  runs: {
    start: (projectId: string) => ipcRenderer.invoke('runs:start', projectId),
    stop: (projectId: string) => ipcRenderer.invoke('runs:stop', projectId),
    stopService: (projectId: string, serviceId: string) => ipcRenderer.invoke('runs:stopService', projectId, serviceId),
    startService: (projectId: string, serviceId: string) => ipcRenderer.invoke('runs:startService', projectId, serviceId),
    restartService: (projectId: string, serviceId: string) => ipcRenderer.invoke('runs:restartService', projectId, serviceId),
    status: (projectId: string) => ipcRenderer.invoke('runs:status', projectId) as Promise<RunServiceStatus[]>,
    reconcile: (projectId: string) => ipcRenderer.invoke('runs:reconcile', projectId) as Promise<ReconciledService[]>,
    previewUrl: (projectId: string, serviceId: string) => ipcRenderer.invoke('runs:previewUrl', projectId, serviceId) as Promise<string | undefined>,
    onStatusChanged: (listener: (projectId: string, status: RunServiceStatus) => void) => {
      const handler = (_event: unknown, projectId: string, status: RunServiceStatus) => listener(projectId, status);
      ipcRenderer.on('runs:statusChanged', handler);
      return () => ipcRenderer.off('runs:statusChanged', handler);
    },
    onLog: (listener: (projectId: string, line: RunLogLine) => void) => {
      const handler = (_event: unknown, projectId: string, line: RunLogLine) => listener(projectId, line);
      ipcRenderer.on('runs:log', handler);
      return () => ipcRenderer.off('runs:log', handler);
    },
    runVerification: (projectId: string, check: PreviewVerificationCheck) =>
      ipcRenderer.invoke('runs:runVerification', projectId, check) as Promise<PreviewVerificationOutcome>,
    diagnoseVerificationFailure: (projectId: string, check: PreviewVerificationCheck, outcome: PreviewVerificationOutcome) =>
      ipcRenderer.invoke('runs:diagnoseVerificationFailure', projectId, check, outcome) as Promise<CreateDiagnosisSessionResult>
  },
  preview: {
    attach: () => ipcRenderer.invoke('preview:attach'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('preview:setBounds', bounds),
    setVisible: (visible: boolean) => ipcRenderer.invoke('preview:setVisible', visible),
    open: (url: string) => ipcRenderer.invoke('preview:open', url),
    captureDiagnostics: () => ipcRenderer.invoke('preview:captureDiagnostics') as Promise<BrowserDiagnosticsBundle | undefined>
  },
  deployments: {
    listProfiles: (projectId: string) => ipcRenderer.invoke('deployments:listProfiles', projectId) as Promise<DeploymentProfile[]>,
    getProfile: (projectId: string, profileId: string) =>
      ipcRenderer.invoke('deployments:getProfile', projectId, profileId) as Promise<{
        profile?: DeploymentProfile;
        issues: DeploymentProfileIssue[];
      }>,
    saveProfile: (projectId: string, profile: DeploymentProfile) =>
      ipcRenderer.invoke('deployments:saveProfile', projectId, profile) as Promise<DeploymentProfile>,
    validateProfile: (profile: DeploymentProfile) =>
      ipcRenderer.invoke('deployments:validateProfile', profile) as Promise<{ valid: boolean; errors: DeploymentProfileIssue[] }>,
    preflightCapabilities: (profile: DeploymentProfile) =>
      ipcRenderer.invoke('deployments:preflightCapabilities', profile) as Promise<DeploymentProfileIssue[]>,
    evaluateCredentials: (profile: DeploymentProfile) =>
      ipcRenderer.invoke('deployments:evaluateCredentials', profile) as Promise<{
        statuses: CredentialBindingStatus[];
        allBound: boolean;
      }>,
    publishArtifact: (artifactId: string, deploymentProfileId: string, rootDir: string, sourceCommit?: WorkflowEvidenceSourceRef) =>
      ipcRenderer.invoke('deployments:publishArtifact', artifactId, deploymentProfileId, rootDir, sourceCommit) as Promise<{
        artifact: PublishedArtifact;
        manifest: PublishManifest;
      }>,
    listArtifacts: (deploymentProfileId: string) =>
      ipcRenderer.invoke('deployments:listArtifacts', deploymentProfileId) as Promise<
        Array<{ artifact: PublishedArtifact; manifest: PublishManifest }>
      >,
    listAllArtifacts: () =>
      ipcRenderer.invoke('deployments:listAllArtifacts') as Promise<Array<{ artifact: PublishedArtifact; manifest: PublishManifest }>>,
    getArtifact: (artifactId: string) =>
      ipcRenderer.invoke('deployments:getArtifact', artifactId) as Promise<
        { artifact: PublishedArtifact; manifest: PublishManifest } | undefined
      >,
    prepare: (
      projectId: string,
      runId: string,
      profile: DeploymentProfile,
      artifact: PublishedArtifact,
      context?: { issueKey?: string; issueConnectionId?: string; workflowRunId?: string; targetUrl?: string }
    ) => ipcRenderer.invoke('deployments:prepare', projectId, runId, profile, artifact, context) as Promise<DeploymentRun>,
    approve: (projectId: string, runId: string, profile: DeploymentProfile, artifact: PublishedArtifact, actor: string) =>
      ipcRenderer.invoke('deployments:approve', projectId, runId, profile, artifact, actor) as Promise<{
        run: DeploymentRun;
        ok: boolean;
        reason?: string;
      }>,
    deploy: (
      projectId: string,
      runId: string,
      profile: DeploymentProfile,
      artifact: PublishedArtifact,
      manifest: PublishManifest,
      options?: {
        excludePaths?: string[];
        backupDir?: string;
        stagingDir?: string;
        processInputs?: Record<string, string>;
        timeoutMs?: number;
        healthCheckHost?: string;
        healthCheckPort?: number;
      }
    ) =>
      ipcRenderer.invoke('deployments:deploy', projectId, runId, profile, artifact, manifest, options) as Promise<{
        dispatched: boolean;
        run: DeploymentRun;
        reason?: string;
      }>,
    getRun: (runId: string) => ipcRenderer.invoke('deployments:getRun', runId) as Promise<DeploymentRun | undefined>,
    listRuns: (deploymentProfileId: string) => ipcRenderer.invoke('deployments:listRuns', deploymentProfileId) as Promise<DeploymentRun[]>,
    health: (runId: string) => ipcRenderer.invoke('deployments:health', runId) as Promise<DeploymentHealthResult>,
    rollback: (
      projectId: string,
      runId: string,
      profile: DeploymentProfile,
      options?: { backupDir?: string; excludePaths?: string[] }
    ) =>
      ipcRenderer.invoke('deployments:rollback', projectId, runId, profile, options) as Promise<{
        rolledBack: boolean;
        run: DeploymentRun;
        reason?: string;
      }>
  }
};

contextBridge.exposeInMainWorld('praxis', praxis);
