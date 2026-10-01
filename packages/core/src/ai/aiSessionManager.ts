import { Emitter } from '../host/emitter';
import type { KeyValueStore } from '../host/stateStore';
import type { AiAssignment, AiProvider } from '../types';
import type { TokenUsage, WireImageAttachment } from './gateway';
import type {
  DeliverySessionMetadata,
  AgentAvailableCommand,
  AgentEventSummary,
  AgentModeOption,
  AgentSessionRecord,
  AgentPermissionMode,
  AgentConversation,
  AgentConversationParticipant,
  AiStartConversationInput,
  AgentTaskDefinition,
  AgentTaskListItem,
  AgentTaskState,
  AgentToolMode,
  AgentWorkflowReference,
  HandoverBrief,
  IssueWorkflowAssignment,
  WorkflowAssignmentSource
} from './agentTypes';
import {
  applyHandoverBriefContent,
  applyHandoverBriefUserEdits,
  appendRuntimeEpoch,
  assertCanChangeSessionRuntime,
  buildDeterministicHandoverBrief,
  emptyHandoverBrief,
  hydrateSessionHandoverFields,
  initialRuntimeEpoch,
  nativeRuntimeClearedPatch,
  purposeFromTask
} from './sessionHandover';
import { isProviderLimitError, extractProviderLimitMessage } from './providerLimitError';
import { estimateCostUsd } from './providers/modelPricing';
import type { ReasoningEffort } from './providers/reasoningSupport';

const STORAGE_KEY = 'praxis.aiSessions';
const AGENT_STORAGE_KEY = 'praxis.agentSessions';
const WORKFLOW_ASSIGNMENT_STORAGE_KEY = 'praxis.issueWorkflowAssignments';
const MODEL_OVERRIDE_STORAGE_KEY = 'praxis.issueModelOverrides';

type AgentRuntimeProvider = AiProvider;

export class AiSessionManager {
  private sessions: Map<string, AiAssignment>;
  private agentSessions: Map<string, AgentSessionRecord>;
  private workflowAssignments: Map<string, IssueWorkflowAssignment>;
  private modelOverrides: Map<string, string>;
  /** Revision at the start of the in-flight brief refresh, so a late complete cannot clobber a newer one. */
  private handoverRefreshBase = new Map<string, number>();

  private readonly _onDidChangeSession = new Emitter<{
    issueKey: string;
    session?: AiAssignment;
  }>();
  /** Fires when any AI assignment session changes. */
  public readonly onDidChangeSession = this._onDidChangeSession.event;
  private readonly _onDidChangeAgentSession = new Emitter<AgentSessionRecord>();
  /** Fires when any agent session's state or events change. */
  public readonly onDidChangeAgentSession = this._onDidChangeAgentSession.event;
  private readonly _onDidChangeWorkflowAssignment = new Emitter<{
    issueKey: string;
    assignment?: IssueWorkflowAssignment;
  }>();
  /** Fires when an issue-level workflow assignment changes. */
  public readonly onDidChangeWorkflowAssignment = this._onDidChangeWorkflowAssignment.event;
  private readonly _onDidChangeModelOverride = new Emitter<{
    issueKey: string;
    model?: string;
  }>();
  /** Fires when an issue-level model override changes. */
  public readonly onDidChangeModelOverride = this._onDidChangeModelOverride.event;

  public constructor(private readonly workspaceState: KeyValueStore) {
    this.sessions = this.loadSessions();
    this.agentSessions = this.loadAgentSessions();
    this.workflowAssignments = this.loadWorkflowAssignments();
    this.modelOverrides = this.loadModelOverrides();
  }

  /** Create a new AI session for the given issue and provider. */
  public createSession(issueKey: string, provider: AiProvider, label?: string, boardId?: string): AiAssignment {
    const assignment: AiAssignment = {
      provider,
      label: label?.trim() || undefined,
      sessionId: this.generateSessionId(),
      assignedAt: new Date().toISOString(),
      status: 'active',
      boardId: boardId || undefined
    };
    this.sessions.set(issueKey, assignment);
    void this.persistSessions();
    this._onDidChangeSession.fire({ issueKey, session: assignment });
    return assignment;
  }

  /** Get the active session for an issue, if one exists. */
  public getSession(issueKey: string): AiAssignment | undefined {
    return this.sessions.get(issueKey);
  }

  /** Update the status of an existing session. */
  public updateSessionStatus(
    issueKey: string,
    status: 'active' | 'completed' | 'failed'
  ): void {
    const session = this.sessions.get(issueKey);
    if (!session) {
      return;
    }
    session.status = status;
    void this.persistSessions();
    this._onDidChangeSession.fire({ issueKey, session });
  }

  /** Remove the session for an issue. */
  public removeSession(issueKey: string): void {
    if (this.sessions.delete(issueKey)) {
      void this.persistSessions();
      this._onDidChangeSession.fire({ issueKey, session: undefined });
    }
  }

  /** Return all active sessions as a read-only map. */
  public getActiveSessions(): Map<string, AiAssignment> {
    const active = new Map<string, AiAssignment>();
    for (const [key, assignment] of this.sessions) {
      if (assignment.status === 'active') {
        active.set(key, assignment);
      }
    }
    return active;
  }

  /** Return all sessions (any status). */
  public getAllSessions(): Map<string, AiAssignment> {
    return new Map(this.sessions);
  }

  // ── Agent Session Management ───────────────────────────────────

  /** Create a new agent session record for an issue. */
  public createAgentSession(
    issueKey: string,
    sessionId: string,
    taskDefinition: AgentTaskDefinition,
    provider?: AgentRuntimeProvider,
    model?: string,
    runtime?: Pick<AgentSessionRecord, 'workingDirectory' | 'toolMode' | 'runtimeSessionId' | 'connectionId' | 'reasoningEffort' | 'permissionMode'>
  ): AgentSessionRecord {
    const startedAt = new Date().toISOString();
    const trimmedModel = model?.trim() || undefined;
    const record: AgentSessionRecord = {
      issueKey,
      sessionId,
      provider,
      model: trimmedModel,
      workingDirectory: runtime?.workingDirectory?.trim() || undefined,
      toolMode: runtime?.toolMode ?? 'full',
      runtimeSessionId: runtime?.runtimeSessionId,
      connectionId: runtime?.connectionId,
      reasoningEffort: runtime?.reasoningEffort,
      state: 'not_started',
      taskDefinition,
      purpose: purposeFromTask(taskDefinition, issueKey),
      handoverBrief: emptyHandoverBrief(startedAt),
      runtimeEpochs: [initialRuntimeEpoch(provider, trimmedModel, startedAt, runtime?.runtimeSessionId)],
      mode: taskDefinition.sessionMode ?? (taskDefinition.kind === 'analysis' ? 'analysis' : taskDefinition.kind === 'review' ? 'review' : 'chat'),
      events: [],
      stepCount: 0,
      startedAt,
      boardId: this.sessions.get(issueKey)?.boardId
    };
    this.agentSessions.set(issueKey, record);
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Update provider-owned runtime metadata after a native session is created or resumed. */
  /**
   * Replaces the project instructions a session's prompt carries — recomputed
   * before each turn, because a provider handover can change which runtime
   * (and so which instruction files it already reads) runs the session.
   */
  public setProjectInstructions(issueKey: string, instructions: string | undefined): void {
    this.setGuidance(issueKey, 'projectInstructions', instructions);
  }

  public setWorkingStyle(issueKey: string, workingStyle: string | undefined): void {
    this.setGuidance(issueKey, 'workingStyle', workingStyle);
  }

  /** Guidance recomputed each turn from settings and project files; the next prompt uses it. */
  private setGuidance(issueKey: string, field: 'projectInstructions' | 'workingStyle', value: string | undefined): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) return;
    const next = value?.trim() || undefined;
    if (record.taskDefinition[field] === next) return;
    record.taskDefinition = { ...record.taskDefinition };
    if (next) record.taskDefinition[field] = next;
    else delete record.taskDefinition[field];
    void this.persistAgentSessions();
  }

  public updateAgentRuntime(
    issueKey: string,
    runtime: Partial<
      Pick<
        AgentSessionRecord,
        | 'workingDirectory'
        | 'toolMode'
        | 'runtimeSessionId'
        | 'providerCapabilities'
        | 'providerVersion'
        | 'runtimeLaunch'
        | 'connectionId'
        | 'projectId'
        | 'worktreePath'
        | 'worktreeBranch'
        | 'worktreeBaseBranch'
        | 'worktreeName'
        | 'workflowRunId'
        | 'workflowRunIds'
        | 'workflowNodeId'
        | 'workflowId'
        | 'workflowVersion'
        | 'workflowRole'
        | 'parentSessionKey'
        | 'autoApprovePermissions'
        | 'permissionMode'
        | 'agentId'
        | 'profileId'
        | 'hostId'
        | 'activeSkills'
        | 'skillActivations'
      >
    >
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) return;
    if (runtime.workingDirectory !== undefined) {
      record.workingDirectory = runtime.workingDirectory.trim() || undefined;
    }
    if (runtime.toolMode !== undefined) record.toolMode = runtime.toolMode;
    if (runtime.runtimeSessionId !== undefined) {
      record.runtimeSessionId = runtime.runtimeSessionId;
      const open = record.runtimeEpochs?.find(epoch => !epoch.endedAt);
      if (open) open.runtimeSessionId = runtime.runtimeSessionId;
    }
    if (runtime.providerCapabilities !== undefined) record.providerCapabilities = runtime.providerCapabilities;
    if (runtime.providerVersion !== undefined) record.providerVersion = runtime.providerVersion.trim() || undefined;
    if (runtime.runtimeLaunch !== undefined) record.runtimeLaunch = runtime.runtimeLaunch;
    if (runtime.autoApprovePermissions !== undefined) record.autoApprovePermissions = runtime.autoApprovePermissions || undefined;
    if (runtime.permissionMode !== undefined) record.permissionMode = runtime.permissionMode;
    if (runtime.parentSessionKey !== undefined) record.parentSessionKey = runtime.parentSessionKey.trim() || undefined;
    if (runtime.connectionId !== undefined) record.connectionId = runtime.connectionId;
    if (runtime.projectId !== undefined) record.projectId = runtime.projectId.trim() || undefined;
    if (runtime.worktreePath !== undefined) record.worktreePath = runtime.worktreePath.trim() || undefined;
    if (runtime.worktreeBranch !== undefined) record.worktreeBranch = runtime.worktreeBranch.trim() || undefined;
    if (runtime.worktreeBaseBranch !== undefined) {
      record.worktreeBaseBranch = runtime.worktreeBaseBranch.trim() || undefined;
    }
    if (runtime.worktreeName !== undefined) record.worktreeName = runtime.worktreeName.trim() || undefined;
    if (runtime.workflowRunId !== undefined) record.workflowRunId = runtime.workflowRunId.trim() || undefined;
    if (runtime.workflowRunIds !== undefined) {
      const runIds = [...new Set(runtime.workflowRunIds.map(runId => runId.trim()).filter(Boolean))];
      record.workflowRunIds = runIds.length > 0 ? runIds : undefined;
    }
    if (runtime.workflowNodeId !== undefined) record.workflowNodeId = runtime.workflowNodeId.trim() || undefined;
    if (runtime.workflowId !== undefined) record.workflowId = runtime.workflowId.trim() || undefined;
    if (runtime.workflowVersion !== undefined) record.workflowVersion = runtime.workflowVersion;
    if (runtime.workflowRole !== undefined) record.workflowRole = runtime.workflowRole;
    if (runtime.agentId !== undefined) record.agentId = runtime.agentId.trim() || undefined;
    if (runtime.profileId !== undefined) record.profileId = runtime.profileId.trim() || undefined;
    if (runtime.hostId !== undefined) record.hostId = runtime.hostId.trim() || undefined;
    if (runtime.skillActivations !== undefined) {
      record.skillActivations = runtime.skillActivations.length > 0 ? runtime.skillActivations : undefined;
    }
    if (runtime.activeSkills !== undefined) {
      record.activeSkills = runtime.activeSkills.length > 0 ? runtime.activeSkills : undefined;
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Promote a completed analysis conversation into its implementation phase. */
  public promoteAnalysisSession(issueKey: string): void {
    const record = this.agentSessions.get(issueKey);
    if (!record || record.taskDefinition.kind !== 'analysis') return;
    record.taskDefinition = {
      ...record.taskDefinition,
      definitionOfDone: 'Implement the confirmed plan, run the relevant tests, and report the completed result.',
      nonGoals: undefined,
      completionContract: 'Continue in this conversation until the confirmed implementation is complete and verified.'
    };
    record.toolMode = 'full';
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Get the agent session for an issue, if one exists. */
  public getAgentSession(issueKey: string): AgentSessionRecord | undefined {
    return this.agentSessions.get(issueKey);
  }

  /** Change the active phase for a persisted conversation before continuing it. */
  public setAgentSessionMode(issueKey: string, mode: AgentSessionRecord['mode']): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    record.mode = mode;
    record.taskDefinition = {
      ...record.taskDefinition,
      sessionMode: mode,
      kind: mode === 'analysis' ? 'analysis' : mode === 'review' ? 'review' : 'general'
    };
    record.toolMode = mode === 'chat' ? (record.workingDirectory ? 'full' : 'project-only') : 'read-only';
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Update the working directory and/or tool mode for a session. */
  public updateAgentSessionToolAccess(
    issueKey: string,
    options: { workingDirectory?: string | null; toolMode?: AgentToolMode }
  ): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    if (options.workingDirectory !== undefined) {
      record.workingDirectory = options.workingDirectory?.trim() || undefined;
      if (!record.workingDirectory && !options.toolMode) {
        record.toolMode = 'project-only';
      }
    }
    if (options.toolMode !== undefined) {
      if ((options.toolMode === 'full' || options.toolMode === 'read-only') && !record.workingDirectory) {
        throw new Error('A working folder is required for file tools.');
      }
      record.toolMode = options.toolMode;
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Get all agent sessions. */
  public getAllAgentSessions(): Map<string, AgentSessionRecord> {
    return new Map(this.agentSessions);
  }

  /** Persist a user-editable display title for an agent session. */
  public renameAgentSession(issueKey: string, title: string): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error('Session title cannot be empty.');
    }
    record.title = trimmed;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /**
   * Set this session's reasoning/thinking effort for its next turn. Unlike
   * `transitionAgentRuntime`, this never touches native runtime state or
   * opens a new runtime epoch — the model and provider stay exactly as they
   * were, only the reasoning-control parameter sent with the next turn
   * changes.
   */
  public updateSessionReasoningEffort(issueKey: string, reasoningEffort: ReasoningEffort): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    assertCanChangeSessionRuntime(record);
    record.reasoningEffort = reasoningEffort;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Set the permission policy used for this session's next turn. */
  public updateSessionPermissionMode(issueKey: string, permissionMode: AgentPermissionMode): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    record.permissionMode = permissionMode;
    record.autoApprovePermissions = permissionMode === 'bypass' || permissionMode === 'autopilot';
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /**
   * Archive or restore a session. Organizational only: the record, its
   * conversation, and every derived field are untouched, so unarchiving is
   * lossless. The flag is stored as absent-but-false so older persisted
   * records stay byte-identical to what they were before this field existed.
   */
  public setAgentSessionArchived(issueKey: string, archived: boolean): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    if (archived === Boolean(record.archived)) {
      return record;
    }
    record.archived = archived || undefined;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Update agent session state and optionally set completedAt and failure reason. */
  public updateAgentState(issueKey: string, state: AgentTaskState, reason?: string): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.state = state;
    if (state === 'completed') {
      this.updateSessionStatus(issueKey, 'completed');
      record.lastError = undefined;
      record.providerLimitReached = undefined;
    } else if (state === 'failed' || state === 'aborted') {
      this.updateSessionStatus(issueKey, 'failed');
      const limitCandidate = (reason && isProviderLimitError(reason))
        ? reason
        : (record.responseText && isProviderLimitError(record.responseText))
          ? record.responseText
          : undefined;
      if (limitCandidate) {
        record.providerLimitReached = true;
        record.lastError = extractProviderLimitMessage(limitCandidate);
      } else if (reason) {
        record.lastError = reason;
      }
    } else {
      this.updateSessionStatus(issueKey, 'active');
      record.completedAt = undefined;
      if (state === 'executing') {
        record.lastError = undefined;
        record.providerLimitReached = undefined;
      }
    }
    if (state === 'completed' || state === 'failed' || state === 'aborted') {
      record.completedAt = new Date().toISOString();
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Append events to an agent session and optionally bump step count. */
  public appendAgentEvents(
    issueKey: string,
    events: AgentEventSummary[],
    incrementSteps?: number
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    for (const event of events) {
      if (event.type === 'error' && isProviderLimitError(event.summary || event.detail)) {
        record.providerLimitReached = true;
        if (!record.lastError || !isProviderLimitError(record.lastError)) {
          record.lastError = extractProviderLimitMessage(event.summary || event.detail);
        }
      }
    }
    const activeSpeaker = record.conversation?.state === 'running'
      ? record.conversation.participants.find(participant => participant.id === record.conversation?.currentSpeakerId)
      : undefined;
    record.events.push(...events.map(event =>
      event.type === 'message' && activeSpeaker && !event.speaker
        ? {
            ...event,
            speaker: {
              participantId: activeSpeaker.id,
              provider: activeSpeaker.provider,
              model: activeSpeaker.model,
              displayLabel: activeSpeaker.displayLabel
            }
          }
        : event
    ));
    if (incrementSteps) {
      record.stepCount += incrementSteps;
    }
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  /** Set the plan text for an agent session. */
  public setAgentPlan(
    issueKey: string,
    planText: string,
    options?: {
      persist?: boolean;
    }
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.planText = planText;
    if (options?.persist ?? true) {
      void this.persistAgentSessions();
    }
    this._onDidChangeAgentSession.fire(record);
  }

  /** Persist gateway conversation history for resume. */
  public setAgentConversationHistory(
    issueKey: string,
    history: AgentSessionRecord['conversationHistory'],
    options?: { persist?: boolean }
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.conversationHistory = history ? [...history] : undefined;
    if (options?.persist ?? true) {
      void this.persistAgentSessions();
    }
    this._onDidChangeAgentSession.fire(record);
  }

  public getAgentConversationHistory(issueKey: string): NonNullable<AgentSessionRecord['conversationHistory']> {
    return [...(this.agentSessions.get(issueKey)?.conversationHistory ?? [])];
  }

  /** Update accumulated assistant output for an agent session. */
  /**
   * Adds a turn's token usage to the session's running total. Sessions make
   * several model calls when tools are involved, so this accumulates rather
   * than replaces — and a provider that reports nothing leaves the field unset.
   */
  public addAgentTokenUsage(issueKey: string, usage: TokenUsage): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    const running = record.tokenUsage ?? {};
    const add = (left: number | undefined, right: number | undefined) =>
      left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
    record.tokenUsage = {
      inputTokens: add(running.inputTokens, usage.inputTokens),
      outputTokens: add(running.outputTokens, usage.outputTokens),
      totalTokens: add(running.totalTokens, usage.totalTokens)
    };
    const openEpoch = record.runtimeEpochs?.find(epoch => !epoch.endedAt);
    if (openEpoch) {
      const epochRunning = openEpoch.tokenUsage ?? {};
      openEpoch.tokenUsage = {
        inputTokens: add(epochRunning.inputTokens, usage.inputTokens),
        outputTokens: add(epochRunning.outputTokens, usage.outputTokens),
        totalTokens: add(epochRunning.totalTokens, usage.totalTokens)
      };
    }
    // Context pressure is this turn's prompt, not the running total — replace.
    if (typeof usage.inputTokens === 'number') {
      record.contextTokens = usage.inputTokens;
    }
    // API providers report only tokens, never cost (ACP hosts are the
    // exception — see setAgentContextUsage). Where a maintained price table
    // covers this provider/model, accumulate an estimate the same way
    // `record.tokenUsage` accumulates; where it doesn't, cost stays unset
    // rather than reading as zero.
    const turnCost = estimateCostUsd(record.provider, record.model, usage);
    if (turnCost) {
      const priorAmount = record.cost?.currency === turnCost.currency ? record.cost.amount : 0;
      record.cost = { amount: priorAmount + turnCost.amount, currency: turnCost.currency };
    }
    this._onDidChangeAgentSession.fire(record);
  }

  /** Records the active model's context window, so the UI can show headroom. */
  public setAgentContextLimit(issueKey: string, contextLimit: number | undefined): void {
    const record = this.agentSessions.get(issueKey);
    if (!record || !contextLimit || contextLimit <= 0) {
      return;
    }
    record.contextLimit = contextLimit;
    this._onDidChangeAgentSession.fire(record);
  }

  /**
   * Context occupancy as the agent itself reports it (ACP's `usage_update`),
   * rather than as the gateway wire parser measures it for API providers.
   *
   * Deliberately does not touch `tokenUsage`: ACP's `used` is what is in the
   * context window right now, not what the session has spent, and conflating
   * the two is exactly the error the `contextTokens` doc warns about.
   */
  public setAgentContextUsage(
    issueKey: string,
    usage: { contextTokens: number; contextLimit: number; cost?: { amount: number; currency: string } }
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    if (usage.contextTokens >= 0) {
      record.contextTokens = usage.contextTokens;
    }
    if (usage.contextLimit > 0) {
      record.contextLimit = usage.contextLimit;
    }
    if (usage.cost) {
      record.cost = usage.cost;
    }
    this._onDidChangeAgentSession.fire(record);
  }

  /**
   * Replaces the session's task list wholesale — ACP's `plan` update is a full
   * snapshot each time (see `AgentSessionRecord.taskList`), so there is
   * nothing to merge. Not persisted directly, the same as the other live
   * fields above: it rides along with whichever event or state change
   * persists next, which for an in-flight turn is never far behind.
   */
  public setAgentTaskList(issueKey: string, items: AgentTaskListItem[]): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.taskList = items;
    this._onDidChangeAgentSession.fire(record);
  }

  /** ACP's `available_commands_update` — see `AgentSessionRecord.acpAvailableCommands`. */
  public setAgentAvailableCommands(issueKey: string, commands: AgentAvailableCommand[]): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.acpAvailableCommands = commands;
    this._onDidChangeAgentSession.fire(record);
  }

  /** Read once from `session/new`'s response — see `AgentSessionRecord.acpAvailableModes`. */
  public setAgentAvailableModes(issueKey: string, currentModeId: string, availableModes: AgentModeOption[]): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.acpCurrentModeId = currentModeId;
    record.acpAvailableModes = availableModes;
    this._onDidChangeAgentSession.fire(record);
  }

  /**
   * ACP's `current_mode_update` — the agent can switch modes on its own, not
   * only in response to `setAcpMode`, so this is kept separate from
   * `setAgentAvailableModes` rather than folded into it.
   */
  public setAgentCurrentMode(issueKey: string, currentModeId: string): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }
    record.acpCurrentModeId = currentModeId;
    this._onDidChangeAgentSession.fire(record);
  }

  public updateAgentOutput(
    issueKey: string,
    output: {
      reasoningText?: string;
      responseText?: string;
    },
    options?: {
      persist?: boolean;
    }
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(output, 'reasoningText')) {
      record.reasoningText = output.reasoningText;
    }
    if (Object.prototype.hasOwnProperty.call(output, 'responseText')) {
      record.responseText = output.responseText;
    }

    if (options?.persist ?? true) {
      void this.persistAgentSessions();
    }
    this._onDidChangeAgentSession.fire(record);
  }

  public updateAgentDelivery(
    issueKey: string,
    delivery: Partial<DeliverySessionMetadata> | undefined,
    options?: {
      persist?: boolean;
      replace?: boolean;
    }
  ): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) {
      return;
    }

    if (delivery === undefined) {
      record.delivery = undefined;
    } else if (options?.replace || !record.delivery) {
      record.delivery = delivery as DeliverySessionMetadata;
    } else {
      record.delivery = {
        ...record.delivery,
        ...delivery
      };
    }

    if (options?.persist ?? true) {
      void this.persistAgentSessions();
    }
    this._onDidChangeAgentSession.fire(record);
  }

  /** Remove agent session for an issue. */
  public removeAgentSession(issueKey: string): void {
    const record = this.agentSessions.get(issueKey);
    if (record) {
      this.agentSessions.delete(issueKey);
      void this.persistAgentSessions();
    }
  }

  public getIssueWorkflowAssignment(issueKey: string): IssueWorkflowAssignment | undefined {
    return this.workflowAssignments.get(issueKey);
  }

  public getAllIssueWorkflowAssignments(): Map<string, IssueWorkflowAssignment> {
    return new Map(this.workflowAssignments);
  }

  public setIssueWorkflowAssignment(
    issueKey: string,
    workflow: AgentWorkflowReference | undefined,
    options?: {
      source?: WorkflowAssignmentSource;
      assignedAt?: string;
      reason?: string;
    }
  ): IssueWorkflowAssignment {
    const assignment: IssueWorkflowAssignment = {
      workflow,
      source: options?.source ?? 'manual',
      assignedAt: options?.assignedAt ?? new Date().toISOString(),
      reason: options?.reason?.trim() || undefined
    };
    this.workflowAssignments.set(issueKey, assignment);
    void this.persistWorkflowAssignments();
    this._onDidChangeWorkflowAssignment.fire({ issueKey, assignment });
    return assignment;
  }

  public removeIssueWorkflowAssignment(issueKey: string): void {
    if (this.workflowAssignments.delete(issueKey)) {
      void this.persistWorkflowAssignments();
      this._onDidChangeWorkflowAssignment.fire({ issueKey, assignment: undefined });
    }
  }

  // ── Model Override Management ──────────────────────────────────

  public getIssueModelOverride(issueKey: string): string | undefined {
    return this.modelOverrides.get(issueKey);
  }

  public setIssueModelOverride(issueKey: string, model: string): void {
    const trimmed = model.trim();
    if (!trimmed) {
      this.removeIssueModelOverride(issueKey);
      return;
    }
    this.modelOverrides.set(issueKey, trimmed);
    void this.persistModelOverrides();
    this._onDidChangeModelOverride.fire({ issueKey, model: trimmed });
  }

  public removeIssueModelOverride(issueKey: string): void {
    if (this.modelOverrides.delete(issueKey)) {
      void this.persistModelOverrides();
      this._onDidChangeModelOverride.fire({ issueKey, model: undefined });
    }
  }

  /**
   * Marks the living brief as updating and returns the revision a later
   * complete/fail call must still match. Returns undefined when there is no session.
   */
  public beginHandoverBriefRefresh(issueKey: string): number | undefined {
    const record = this.agentSessions.get(issueKey);
    if (!record) return undefined;
    const brief = record.handoverBrief ?? emptyHandoverBrief();
    record.handoverBrief = { ...brief, freshness: 'updating', lastError: undefined };
    this.handoverRefreshBase.set(issueKey, brief.revision);
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return brief.revision;
  }

  /** Commits a refresh only when the expected revision is still current. */
  public completeHandoverBriefRefresh(
    issueKey: string,
    expectedRevision: number,
    content = buildDeterministicHandoverBrief(this.agentSessions.get(issueKey) as AgentSessionRecord)
  ): HandoverBrief | undefined {
    const record = this.agentSessions.get(issueKey);
    if (!record) return undefined;
    const previous = record.handoverBrief ?? emptyHandoverBrief();
    if (this.handoverRefreshBase.get(issueKey) !== expectedRevision) {
      return previous;
    }
    this.handoverRefreshBase.delete(issueKey);
    record.handoverBrief = applyHandoverBriefContent(previous, content, record.events.length);
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record.handoverBrief;
  }

  public failHandoverBriefRefresh(issueKey: string, expectedRevision: number, error: string): void {
    const record = this.agentSessions.get(issueKey);
    if (!record) return;
    const previous = record.handoverBrief ?? emptyHandoverBrief();
    if (this.handoverRefreshBase.get(issueKey) !== expectedRevision) return;
    this.handoverRefreshBase.delete(issueKey);
    record.handoverBrief = {
      ...previous,
      freshness: 'failed',
      lastError: error
    };
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
  }

  public updateHandoverBriefFromEvents(issueKey: string): HandoverBrief | undefined {
    const record = this.agentSessions.get(issueKey);
    if (!record) return undefined;
    const previous = record.handoverBrief ?? emptyHandoverBrief();
    record.handoverBrief = applyHandoverBriefContent(
      previous,
      buildDeterministicHandoverBrief(record),
      record.events.length
    );
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record.handoverBrief;
  }

  /**
   * Refresh after a completed user-visible turn. Never throws into the turn:
   * a failed summarizer leaves the previous brief marked failed/stale.
   */
  public async refreshHandoverBrief(
    issueKey: string,
    summarizer?: (record: AgentSessionRecord) => Promise<ReturnType<typeof buildDeterministicHandoverBrief>>
  ): Promise<void> {
    const expected = this.beginHandoverBriefRefresh(issueKey);
    if (expected === undefined) return;
    const record = this.agentSessions.get(issueKey);
    if (!record) return;
    try {
      const content = summarizer
        ? await summarizer(record)
        : buildDeterministicHandoverBrief(record);
      this.completeHandoverBriefRefresh(issueKey, expected, content);
    } catch (error) {
      this.failHandoverBriefRefresh(
        issueKey,
        expected,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  public editHandoverBrief(
    issueKey: string,
    expectedRevision: number,
    edits: Partial<Pick<HandoverBrief, 'progress' | 'changes' | 'decisions' | 'risks' | 'openQuestions' | 'nextSteps' | 'userNotes'>>
  ): HandoverBrief {
    const record = this.agentSessions.get(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    const previous = record.handoverBrief ?? emptyHandoverBrief();
    record.handoverBrief = applyHandoverBriefUserEdits(previous, expectedRevision, edits);
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record.handoverBrief;
  }

  /**
   * Changes the current provider and/or model, closing the open epoch and
   * opening a new one. Provider handovers clear non-transferable native state.
   */
  public transitionAgentRuntime(
    issueKey: string,
    next: {
      provider?: AiProvider;
      model?: string;
      reason: 'model_change' | 'provider_handover' | 'conversation_turn';
      clearNativeRuntime?: boolean;
      eventSummary: string;
      eventDetail?: string;
    }
  ): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    assertCanChangeSessionRuntime(record);
    const provider = next.provider ?? record.provider;
    const model = next.model?.trim() || undefined;
    const clearNative = next.clearNativeRuntime ?? next.reason === 'provider_handover';
    record.runtimeEpochs = appendRuntimeEpoch(record.runtimeEpochs ?? [], {
      provider,
      model,
      reason: next.reason
    });
    record.provider = provider;
    record.model = model;
    // A runtime transition is a fresh start on (possibly) a different
    // provider — a rate/credit limit hit on the old runtime says nothing
    // about the new one, so carrying it forward would falsely flag the new
    // provider as already limited. `updateAgentState('executing')` clears
    // the same two fields when a turn resumes; this covers the handover/
    // model-change/conversation-turn paths, which change runtime without
    // necessarily also transitioning through 'executing'.
    record.lastError = undefined;
    record.providerLimitReached = undefined;
    if (clearNative) {
      Object.assign(record, nativeRuntimeClearedPatch());
    }
    record.events.push({
      timestamp: new Date().toISOString(),
      type: next.reason,
      summary: next.eventSummary,
      detail: next.eventDetail
    });
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Starts a bounded opt-in conversation without changing the handover contract. */
  public startAgentConversation(issueKey: string, input: AiStartConversationInput): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    assertCanChangeSessionRuntime(record);
    if (!record.provider) throw new Error('This session has no provider to invite another AI into.');
    if (record.conversation?.state === 'running') throw new Error('A multi-AI conversation is already running.');
    const turnCap = Math.max(1, Math.min(20, Math.floor(input.turnCap)));
    if (!Number.isFinite(turnCap)) throw new Error('Choose a valid conversation turn cap.');
    const host: AgentConversationParticipant = {
      id: 'host', provider: record.provider, model: record.model, role: 'host',
      displayLabel: `${record.provider ?? 'AI'}${record.model ? ` · ${record.model}` : ''}`
    };
    const guest: AgentConversationParticipant = {
      id: 'guest', provider: input.provider, model: input.model?.trim() || undefined, role: 'guest',
      displayLabel: `${input.provider}${input.model?.trim() ? ` · ${input.model.trim()}` : ''}`
    };
    if (host.provider === guest.provider && host.model === guest.model) {
      throw new Error('Choose a different provider or model for the second AI.');
    }
    const conversation: AgentConversation = {
      mode: input.mode,
      participants: [host, guest],
      currentSpeakerId: guest.id,
      toolOwnerId: host.id,
      originalToolMode: record.toolMode ?? 'full',
      turnCap,
      turnsUsed: 0,
      state: 'running'
    };
    record.conversation = conversation;
    record.events.push({ timestamp: new Date().toISOString(), type: 'conversation_turn', summary: `Started ${input.mode} conversation with ${guest.displayLabel}` });
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Selects the next speaker and enforces the only-writer rule before a turn starts. */
  public prepareAgentConversationTurn(issueKey: string): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    if (!record || !conversation || conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
    if (conversation.turnsUsed >= conversation.turnCap) return this.finishAgentConversation(issueKey, 'capped');
    const speaker = conversation.participants.find(participant => participant.id === conversation.currentSpeakerId);
    if (!speaker) throw new Error('The current conversation speaker is missing.');
    record.toolMode = conversation.mode === 'pair' && conversation.toolOwnerId === speaker.id ? 'full' : 'read-only';
    return this.transitionAgentRuntime(issueKey, {
      provider: speaker.provider,
      model: speaker.model,
      reason: 'conversation_turn',
      clearNativeRuntime: true,
      eventSummary: `${speaker.displayLabel}'s conversation turn`
    });
  }

  /** Counts a finished AI turn and either schedules the other speaker or caps the conversation. */
  public completeAgentConversationTurn(issueKey: string): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    if (!record || !conversation || conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
    conversation.turnsUsed += 1;
    if (conversation.turnsUsed >= conversation.turnCap) return this.finishAgentConversation(issueKey, 'capped');
    conversation.currentSpeakerId = conversation.participants.find(p => p.id !== conversation.currentSpeakerId)?.id ?? conversation.currentSpeakerId;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Queues a human message for a chosen participant; the host consumes it between turns. */
  public queueAgentConversationMessage(
    issueKey: string,
    participantId: string,
    message: string,
    images?: WireImageAttachment[]
  ): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    const trimmed = message.trim();
    if (!record || !conversation || conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
    if (!conversation.participants.some(participant => participant.id === participantId)) throw new Error('Unknown conversation participant.');
    if (!trimmed && !(images?.length)) throw new Error('Enter a message for the AI conversation.');
    conversation.pendingUserMessages = [
      ...(conversation.pendingUserMessages ?? []),
      { participantId, message: trimmed, ...(images?.length ? { images } : {}) }
    ];
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Takes the queued human message, if any, for scheduling the next turn. */
  public takeAgentConversationMessage(
    issueKey: string
  ): { participantId: string; message: string; images?: WireImageAttachment[] } | undefined {
    const conversation = this.agentSessions.get(issueKey)?.conversation;
    const pending = conversation?.pendingUserMessages?.[0];
    if (!conversation || !pending) return undefined;
    conversation.pendingUserMessages = conversation.pendingUserMessages!.slice(1);
    if (conversation.pendingUserMessages.length === 0) delete conversation.pendingUserMessages;
    void this.persistAgentSessions();
    return pending;
  }

  /** Selects which participant should answer the next conversation turn. */
  public setAgentConversationSpeaker(issueKey: string, participantId: string): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    if (!record || !conversation || conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
    if (!conversation.participants.some(participant => participant.id === participantId)) throw new Error('Unknown conversation participant.');
    conversation.currentSpeakerId = participantId;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Stops a conversation between turns and restores the current tool owner as the single-agent runtime. */
  public finishAgentConversation(issueKey: string, state: 'stopped' | 'capped' | 'failed'): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    if (!record || !conversation) throw new Error('No multi-AI conversation is active.');
    conversation.state = state;
    const owner = conversation.participants.find(participant => participant.id === conversation.toolOwnerId)
      ?? conversation.participants[0];
    record.provider = owner.provider;
    record.model = owner.model;
    record.toolMode = conversation.originalToolMode;
    record.events.push({ timestamp: new Date().toISOString(), type: 'conversation_turn', summary: state === 'capped' ? `Conversation stopped at its ${conversation.turnCap}-turn cap.` : state === 'failed' ? 'Conversation stopped after a provider failure.' : 'Conversation stopped by you.' });
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  /** Transfers pair-mode tool ownership only between turns. */
  public setAgentConversationToolOwner(issueKey: string, participantId: string): AgentSessionRecord {
    const record = this.agentSessions.get(issueKey);
    const conversation = record?.conversation;
    if (!record || !conversation || conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
    assertCanChangeSessionRuntime(record);
    if (conversation.mode !== 'pair') throw new Error('Tool ownership can only change in pair mode.');
    if (!conversation.participants.some(participant => participant.id === participantId)) throw new Error('Unknown conversation participant.');
    conversation.toolOwnerId = participantId;
    void this.persistAgentSessions();
    this._onDidChangeAgentSession.fire(record);
    return record;
  }

  public dispose(): void {
    this._onDidChangeSession.dispose();
    this._onDidChangeAgentSession.dispose();
    this._onDidChangeWorkflowAssignment.dispose();
    this._onDidChangeModelOverride.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────

  private generateSessionId(): string {
    const hex = () => Math.random().toString(16).slice(2, 10);
    return `${hex()}${hex()}`;
  }

  private loadSessions(): Map<string, AiAssignment> {
    const stored = this.workspaceState.get<Record<string, AiAssignment>>(STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }

    const result = new Map<string, AiAssignment>();
    for (const [key, value] of Object.entries(stored)) {
      if (
        value &&
        typeof value.provider === 'string' &&
        typeof value.sessionId === 'string' &&
        typeof value.assignedAt === 'string' &&
        typeof value.status === 'string'
      ) {
        result.set(key, value);
      }
    }
    return result;
  }

  private async persistSessions(): Promise<void> {
    const record: Record<string, AiAssignment> = {};
    for (const [key, assignment] of this.sessions) {
      record[key] = assignment;
    }
    await this.workspaceState.update(STORAGE_KEY, record);
  }

  private loadAgentSessions(): Map<string, AgentSessionRecord> {
    const stored = this.workspaceState.get<Record<string, AgentSessionRecord>>(AGENT_STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }
    // A process restart kills every in-flight task, but the record on disk still
    // says planning/executing/awaiting. Left as-is it shows a ghost "running"
    // session that Abort can't touch (there is no task). Settle those to
    // `aborted` on load.
    const INTERRUPTED_STATES: ReadonlySet<string> = new Set([
      'planning',
      'executing',
      'awaiting_approval',
      'awaiting_input'
    ]);

    const result = new Map<string, AgentSessionRecord>();
    for (const [key, value] of Object.entries(stored)) {
      if (
        value &&
        typeof value.sessionId === 'string' &&
        typeof value.state === 'string' &&
        typeof value.taskDefinition === 'object'
      ) {
        const interrupted = INTERRUPTED_STATES.has(value.state);
        const events = Array.isArray(value.events)
          ? value.events.map(event =>
              event && typeof event === 'object' && event.data && typeof event.data !== 'object'
                ? { ...event, data: undefined }
                : event
            )
          : [];
        result.set(key, hydrateSessionHandoverFields({
          ...value,
          toolMode: value.toolMode === 'read-only' || value.toolMode === 'project-only' ? value.toolMode : 'full',
          state: interrupted ? 'aborted' : value.state,
          completedAt: interrupted ? (value.completedAt ?? new Date().toISOString()) : value.completedAt,
          events: interrupted
            ? [
                ...events,
                {
                  timestamp: new Date().toISOString(),
                  type: 'aborted' as const,
                  summary: 'Session interrupted by an app restart'
                }
              ]
            : events
        }, interrupted));
      }
    }
    return result;
  }

  private async persistAgentSessions(): Promise<void> {
    const record: Record<string, AgentSessionRecord> = {};
    for (const [key, session] of this.agentSessions) {
      record[key] = session;
    }
    await this.workspaceState.update(AGENT_STORAGE_KEY, record);
  }

  private loadWorkflowAssignments(): Map<string, IssueWorkflowAssignment> {
    const stored = this.workspaceState.get<Record<string, IssueWorkflowAssignment>>(
      WORKFLOW_ASSIGNMENT_STORAGE_KEY
    );
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }

    const result = new Map<string, IssueWorkflowAssignment>();
    for (const [key, value] of Object.entries(stored)) {
      if (
        !value ||
        typeof value.assignedAt !== 'string' ||
        (value.source !== 'manual' && value.source !== 'automatic' && value.source !== 'analysis')
      ) {
        continue;
      }
      // workflow is optional: `undefined` represents an explicit "No workflow pack" choice.
      const hasValidWorkflow =
        value.workflow &&
        typeof value.workflow.id === 'string' &&
        typeof value.workflow.name === 'string' &&
        typeof value.workflow.instructionsPath === 'string';
      if (value.workflow && !hasValidWorkflow) {
        continue;
      }
      result.set(key, {
        ...value,
        workflow: hasValidWorkflow ? value.workflow : undefined
      });
    }

    return result;
  }

  private async persistWorkflowAssignments(): Promise<void> {
    const record: Record<string, IssueWorkflowAssignment> = {};
    for (const [key, assignment] of this.workflowAssignments) {
      record[key] = assignment;
    }
    await this.workspaceState.update(WORKFLOW_ASSIGNMENT_STORAGE_KEY, record);
  }

  private loadModelOverrides(): Map<string, string> {
    const stored = this.workspaceState.get<Record<string, string>>(MODEL_OVERRIDE_STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return new Map();
    }
    const result = new Map<string, string>();
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === 'string' && value.trim()) {
        result.set(key, value.trim());
      }
    }
    return result;
  }

  private async persistModelOverrides(): Promise<void> {
    const record: Record<string, string> = {};
    for (const [key, model] of this.modelOverrides) {
      record[key] = model;
    }
    await this.workspaceState.update(MODEL_OVERRIDE_STORAGE_KEY, record);
  }
}
