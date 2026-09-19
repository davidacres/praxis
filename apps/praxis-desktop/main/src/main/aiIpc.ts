import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import {
  clearProviderApiKey,
  discoverWorkspaceAgentWorkflows,
  GitWorktreeManager,
  PROVIDER_DESCRIPTORS,
  PathSandboxError,
  isLatestEditToPath,
  resolveSandboxedPath,
  stageIssueAttachments,
  storeProviderApiKey,
  resetProviderApiKeys,
  createBrowserToolExtension,
  WorktreeConflictError,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AgentToolMode,
  type AgentWorkflowReference,
  type AiDelegateInput,
  type AiHandoverBriefEdits,
  type AiHandoverInput,
  type AiStartConversationInput,
  type AiProvider,
  buildHandoverEnvelope,
  type AiReviewProgress,
  type IssueDetails,
  type IssueTrackerService,
  type PermissionDecision,
  type SessionMode,
  type VercelAgentStartOptions,
  type WireImageAttachment,
  isProviderLimitError,
  extractProviderLimitMessage
} from '@praxis/core';
import {
  abortActiveTask,
  getAcpAgentHost,
  getAiAnalysisStore,
  getAiProviderStatus,
  getAiSessionManager,
  getVercelAgentService,
  hasActiveTask,
  listAiProviderStatuses,
  listApiModelOptions,
  listCliModelOptions,
  resolveConnectionOptions,
  respondToActivePermission,
  testProviderConnection
} from './aiInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { AiBrowserBridge } from './aiBrowser';
import { browserMcpServerForSession, disposeBrowserMcpForSession } from './browserMcp';
import { getServiceForConnection } from './serviceRegistry';
import { isAnalysisConfirmed } from './aiWorkflowIpc';
import { reviewIssueWithRuntime } from './aiReviewRuntime';
import { getCurrentBranch } from './gitService';
import { getProjectStore } from './projectStoreInstance';
import {
  continueAgentTask,
  launchAgentTask,
  prepareAgentLaunch,
  preparePersistedAgentLaunch
} from './agentSessionLauncher';

/**
 * Normalises untrusted image attachments crossing IPC into strict
 * `WireImageAttachment`s: base64 strings (no `data:` prefix) on a known image
 * mime type, capped in count and total decoded size so a runaway composer
 * cannot stall the turn or the persisted transcript.
 */
function sanitizeImages(images: unknown): WireImageAttachment[] {
  if (!Array.isArray(images)) return [];
  const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const sanitized: WireImageAttachment[] = [];
  let totalBytes = 0;
  for (const raw of images) {
    if (sanitized.length >= MAX_ATTACHED_IMAGES) break;
    const mimeType = typeof (raw as WireImageAttachment)?.mimeType === 'string'
      ? (raw as WireImageAttachment).mimeType.toLowerCase()
      : '';
    const dataBase64 = typeof (raw as WireImageAttachment)?.dataBase64 === 'string'
      ? (raw as WireImageAttachment).dataBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
      : '';
    if (!allowedMimeTypes.has(mimeType) || !dataBase64 || dataBase64.length % 4 !== 0) continue;
    totalBytes += Math.floor(dataBase64.length * 3 / 4);
    if (totalBytes > MAX_ATTACHED_IMAGE_BYTES) break;
    sanitized.push({ mimeType, dataBase64 });
  }
  return sanitized;
}

/** Cap on images carried by a single user turn. */
const MAX_ATTACHED_IMAGES = 4;
/** Cap on total decoded image bytes per turn (12 MB) — mirrors typical provider request limits. */
const MAX_ATTACHED_IMAGE_BYTES = 12 * 1024 * 1024;

/** Builds the default general task for an issue when the caller didn't supply one. */
function buildDefaultTask(
  issue: { summary: string; description?: string },
  overrides?: Partial<AgentTaskDefinition>
): AgentTaskDefinition {
  return {
    kind: 'general',
    goal:
      overrides?.goal ??
      `${issue.summary}${issue.description ? '\n' + issue.description.slice(0, 500) : ''}`,
    scope: overrides?.scope ?? 'This issue and related files',
    definitionOfDone:
      overrides?.definitionOfDone ?? 'All acceptance criteria met, code compiles, tests pass',
    ...(overrides?.workflow ? { workflow: overrides.workflow } : {}),
    ...(overrides?.maxSteps ? { maxSteps: overrides.maxSteps } : {}),
    ...(overrides?.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {})
  };
}

function buildModeTask(
  mode: SessionMode,
  issue: { key: string; summary: string },
  analysisPrompt: string,
  overrides?: Partial<AgentTaskDefinition>
): AgentTaskDefinition {
  if (mode === 'analysis') {
    return {
      kind: 'analysis',
      sessionMode: 'analysis',
      goal: [analysisPrompt, overrides?.goal ?? `Analyze ${issue.key} — ${issue.summary}.`, 'This is a read-only analysis; do not implement anything yet.'].join('\n\n'),
      scope: 'Read-only analysis of the supplied goal and relevant workspace context.',
      definitionOfDone: 'A clear analysis and ordered implementation plan is presented for review.',
      nonGoals: ['Do not edit files or change external state during analysis.'],
      completionContract: 'Stop after presenting the analysis and wait for confirmation.'
    };
  }
  if (mode === 'review') {
    return {
      kind: 'review',
      sessionMode: 'review',
      goal: overrides?.goal ?? `Review ${issue.key} — ${issue.summary}.`,
      scope: 'Read-only review of the supplied goal, implementation, tests, and relevant workspace context.',
      definitionOfDone: 'A concise review identifies strengths, risks, and actionable findings.',
      nonGoals: ['Do not edit files or implement fixes during review.'],
      completionContract: 'Stop after presenting review findings and wait for the user.'
    };
  }
  return { ...buildDefaultTask(issue, overrides), sessionMode: 'chat' };
}

const TRACKER_READ_TOOLS = [
  {
    name: 'tracker_get_ticket',
    description: 'Get the current details of a ticket from the session tracker connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string', description: 'Ticket key, for example APP-101' } },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_list_transitions',
    description: 'List the workflow transitions currently available for a ticket.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' } },
      required: ['issueKey']
    }
  }
];

const TRACKER_WRITE_TOOLS = [
  {
    name: 'tracker_add_comment',
    description: 'Add a comment to a ticket after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' }, body: { type: 'string' } },
      required: ['issueKey', 'body']
    }
  },
  {
    name: 'tracker_update_ticket',
    description: 'Update editable ticket fields after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issueKey: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        assignee: { type: ['string', 'null'] },
        priority: { type: 'string' }
      },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_transition_ticket',
    description: 'Move a ticket through a workflow transition after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' }, transitionId: { type: 'string' } },
      required: ['issueKey', 'transitionId']
    }
  }
];

const IMAGE_PREVIEW_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};
const MAX_IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024;

function trackerToolExtension(
  service: IssueTrackerService | undefined,
  toolMode: AgentToolMode
): VercelAgentStartOptions['toolExtension'] | undefined {
  if (!service) return undefined;
  const definitions = toolMode === 'read-only'
    ? TRACKER_READ_TOOLS
    : [...TRACKER_READ_TOOLS, ...TRACKER_WRITE_TOOLS];
  const str = (args: Record<string, unknown>, key: string) =>
    typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  return {
    definitions,
    async execute(name, args, requestPermission) {
      try {
        const issueKey = str(args, 'issueKey');
        if (!issueKey) return { ok: false, content: 'issueKey is required.' };
        if (name === 'tracker_get_ticket') {
          return { ok: true, content: JSON.stringify(await service.getIssue(issueKey), null, 2) };
        }
        if (name === 'tracker_list_transitions') {
          return { ok: true, content: JSON.stringify(await service.getTransitions(issueKey), null, 2) };
        }
        const allowed = await requestPermission({
          kind: 'tracker-write',
          description: `Permission requested: ${name} on ${issueKey}`,
          detail: JSON.stringify(args, null, 2)
        });
        if (allowed === 'deny') return { ok: false, content: `Permission denied for ${name}.` };
        if (name === 'tracker_add_comment') {
          const body = str(args, 'body');
          if (!body) return { ok: false, content: 'body is required.' };
          await service.addComment(issueKey, body);
          return { ok: true, content: `Comment added to ${issueKey}.` };
        }
        if (name === 'tracker_update_ticket') {
          const update = {
            ...(str(args, 'summary') ? { summary: str(args, 'summary') } : {}),
            ...(str(args, 'description') ? { description: str(args, 'description') } : {}),
            ...(args.assignee === null || typeof args.assignee === 'string' ? { assignee: args.assignee as string | null } : {}),
            ...(str(args, 'priority') ? { priority: str(args, 'priority') } : {})
          };
          return { ok: true, content: JSON.stringify(await service.updateIssue(issueKey, update), null, 2) };
        }
        if (name === 'tracker_transition_ticket') {
          const transitionId = str(args, 'transitionId');
          if (!transitionId) return { ok: false, content: 'transitionId is required.' };
          await service.transitionIssue(issueKey, transitionId);
          return { ok: true, content: `Transition ${transitionId} applied to ${issueKey}.` };
        }
        return { ok: false, content: `Unknown tracker tool: ${name}` };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

type ToolExtension = NonNullable<VercelAgentStartOptions['toolExtension']>;

/**
 * The in-app browser tools, when the user has switched them on (Settings → AI
 * Provider) and the session runs with full tool access. Navigation to a host not
 * already on the allow-list prompts; `allow_always` adds the host to settings.
 */
function browserToolExtension(toolMode: AgentToolMode): ToolExtension | undefined {
  if (toolMode !== 'full') return undefined;
  const backend = getSettingsBackend();
  const config = backend.read().ai.browserTools;
  if (!config.enabled) return undefined;
  return createBrowserToolExtension({
    bridge: new AiBrowserBridge(),
    allowedHosts: config.allowedHosts,
    allowPrivateHosts: process.env.PRAXIS_BROWSER_ALLOW_LOOPBACK === '1',
    onHostAllowed: host => {
      const current = backend.read().ai.browserTools.allowedHosts;
      if (!current.includes(host)) {
        void backend.write({ ai: { browserTools: { allowedHosts: [...current, host] } } });
      }
    }
  });
}

/** Concatenates tool extensions into one, dispatching `execute` by tool name. */
function mergeToolExtensions(...parts: Array<ToolExtension | undefined>): ToolExtension | undefined {
  const active = parts.filter((part): part is ToolExtension => Boolean(part));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return {
    definitions: active.flatMap(part => [...part.definitions]),
    execute(name, args, requestPermission) {
      const owner = active.find(part => part.definitions.some(def => def.name === name));
      if (!owner) return Promise.resolve({ ok: false, content: `Unknown tool: ${name}` });
      return owner.execute(name, args, requestPermission);
    }
  };
}

/**
 * Registers the AI IPC channels: provider setup (`ai:getStatus`, `ai:setApiKey`),
 * session lifecycle (`ai:listSessions`, `ai:delegate`, `ai:abort`), and the
 * `ai:sessionChanged` push channel that streams session record updates to every
 * live window — the desktop equivalent of the extension's EventEmitter wiring.
 */
export function registerAiIpc(): void {
  const sessionManager = getAiSessionManager();
  const agentService = getVercelAgentService();

  async function assertModelAvailable(provider: AiProvider, model: string): Promise<void> {
    const descriptor = PROVIDER_DESCRIPTORS[provider];
    const options = descriptor.kind === 'cli-agent'
      ? await listCliModelOptions(provider).catch(() => undefined)
      : await listApiModelOptions(provider).catch(() => undefined);
    if (options && options.options.length > 0 && !options.options.some(option => option.value === model)) {
      throw new Error(`${model} is not available for ${descriptor.label}.`);
    }
  }

  async function continueRecordedSession(
    issueKey: string,
    message: string,
    options?: {
      internalConversationTurn?: boolean;
      conversationContext?: string;
      /** Images pasted/dropped into the composer, forwarded to the agent with the message. */
      images?: WireImageAttachment[];
    }
  ): Promise<void> {
    const followUp = message.trim();
    if (!followUp) {
      throw new Error('Enter a follow-up message.');
    }
    const record = sessionManager.getAgentSession(issueKey);
    if (!record) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    const provider = record.provider ?? getSettingsBackend().read().ai.activeProvider;
    const settings = getSettingsBackend().read();
    const workingDirectory = record.workingDirectory?.trim() || settings.ai.workingDirectory.trim() || undefined;
    const toolMode = record.toolMode ?? 'full';

    const prepared = await preparePersistedAgentLaunch(record, provider);
    const trackerService = record.issueKey.startsWith('SESSION-')
      ? undefined
      : await getServiceForConnection(record.connectionId).catch(() => undefined);
    const browserMcp = prepared.plan.state === 'acp'
      ? await browserMcpServerForSession(issueKey, toolMode)
      : undefined;
    await continueAgentTask(prepared, {
      issueKey,
      message: followUp,
      ...(options?.images?.length ? { images: options.images } : {}),
      model: record.model,
      workingDirectory,
      toolMode,
      internalConversationTurn: options?.internalConversationTurn,
      conversationContext: options?.conversationContext,
      ...(browserMcp ? { mcpServers: [browserMcp] } : {}),
      ...(prepared.plan.state === 'gateway'
        ? { toolExtension: mergeToolExtensions(trackerToolExtension(trackerService, toolMode), browserToolExtension(toolMode)) }
        : {})
    });
  }

  const queuedConversationTurns = new Set<string>();
  const startingConversationTurns = new Set<string>();

  function conversationPrompt(record: AgentSessionRecord): string {
    const conversation = record.conversation!;
    const speaker = conversation.participants.find(participant => participant.id === conversation.currentSpeakerId)!;
    const other = conversation.participants.find(participant => participant.id !== speaker.id)!;
    // `prepareAgentConversationTurn` has already made `speaker` the active
    // runtime. Build the portable context from the *other* participant so the
    // prompt never tells an AI it is taking over from itself.
    const envelope = buildHandoverEnvelope(
      { ...record, provider: other.provider, model: other.model },
      { provider: speaker.provider, model: speaker.model }
    );
    const access = record.toolMode === 'full'
      ? 'You currently hold the only write-capable tool access. Do not act concurrently with the other AI.'
      : 'You are read-only for this turn. Do not write files, execute commands, or mutate external systems.';
    return [
      `You are ${speaker.displayLabel}, participating in a bounded Praxis ${conversation.mode} conversation.`,
      `Address ${other.displayLabel} and the human directly. This is AI turn ${conversation.turnsUsed + 1} of ${conversation.turnCap}.`,
      access,
      'Give one concise, self-contained response, then stop so Praxis can yield to the other AI.',
      '',
      envelope.text
    ].join('\n');
  }

  function queueConversationTurn(issueKey: string): void {
    if (queuedConversationTurns.has(issueKey) || startingConversationTurns.has(issueKey)) return;
    queuedConversationTurns.add(issueKey);
    setTimeout(() => {
      queuedConversationTurns.delete(issueKey);
      void runConversationTurn(issueKey).catch(() => undefined);
    }, 0);
  }

  async function runConversationTurn(issueKey: string, humanMessage?: string, images?: WireImageAttachment[]): Promise<void> {
    if (startingConversationTurns.has(issueKey)) return;
    const current = sessionManager.getAgentSession(issueKey);
    if (!current?.conversation || current.conversation.state !== 'running') return;
    if (hasActiveTask(issueKey)) {
      queueConversationTurn(issueKey);
      return;
    }
    startingConversationTurns.add(issueKey);
    try {
      const prepared = sessionManager.prepareAgentConversationTurn(issueKey);
      if (prepared.conversation?.state !== 'running') return;
      await continueRecordedSession(issueKey, humanMessage ?? 'Continue the conversation.', {
        internalConversationTurn: !humanMessage,
        conversationContext: conversationPrompt(prepared),
        images: images
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLimit = isProviderLimitError(error);
      const limitNotice = isLimit ? extractProviderLimitMessage(error) : undefined;
      const record = sessionManager.getAgentSession(issueKey);
      if (record?.conversation?.state === 'running') {
        sessionManager.finishAgentConversation(issueKey, 'failed');
        sessionManager.updateAgentState(issueKey, 'failed', limitNotice ?? message);
        sessionManager.appendAgentEvents(issueKey, [
          {
            timestamp: new Date().toISOString(),
            type: 'error',
            summary: limitNotice ?? message
          }
        ]);
      }
      throw new Error(limitNotice ?? 'The multi-AI conversation could not start its next turn.');
    } finally {
      startingConversationTurns.delete(issueKey);
    }
  }

  ipcMain.handle('ai:getStatus', async () => getAiProviderStatus());

  ipcMain.handle('ai:listProviderStatuses', async () => listAiProviderStatuses());

  ipcMain.handle('ai:listCliModelOptions', async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider) =>
    listCliModelOptions(provider)
  );

  ipcMain.handle(
    'ai:listApiModelOptions',
    async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider, forceRefresh?: boolean) =>
      listApiModelOptions(provider, forceRefresh)
  );

  ipcMain.handle(
    'ai:setProviderApiKey',
    async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider, value: string) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) {
        await storeProviderApiKey(getSecretsStore(), provider, trimmed);
      } else {
        await clearProviderApiKey(getSecretsStore(), provider);
      }
      const statuses = await listAiProviderStatuses();
      return statuses.find(s => s.provider === provider) ?? (await getAiProviderStatus());
    }
  );

  ipcMain.handle(
    'ai:testProviderApiKey',
    async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider) =>
      testProviderConnection(provider)
  );

  ipcMain.handle('ai:resetProviderApiKeys', async () => {
    await resetProviderApiKeys(getSecretsStore());
  });

  // Back-compat: applies to the currently active provider.
  ipcMain.handle('ai:setApiKey', async (_event: Electron.IpcMainInvokeEvent, value: string) => {
    const settings = getSettingsBackend().read();
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      await storeProviderApiKey(getSecretsStore(), settings.ai.activeProvider, trimmed);
    } else {
      await clearProviderApiKey(getSecretsStore(), settings.ai.activeProvider);
    }
    return getAiProviderStatus();
  });

  ipcMain.handle('ai:listSessions', async () =>
    [...sessionManager.getAllAgentSessions().values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    )
  );

  ipcMain.handle(
    'ai:loadImagePreview',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, filePath: string) => {
      // Chat Markdown historically passed the issue key. Artifact gadgets use
      // the session id because free-form sessions do not always have a ticket;
      // accept both identifiers while keeping the same bounded file access.
      const record = sessionManager.getAgentSession(issueKey) ??
        [...sessionManager.getAllAgentSessions().values()].find(candidate => candidate.sessionId === issueKey);
      const input = typeof filePath === 'string' ? filePath.trim() : '';
      const workingDirectory = record?.worktreePath?.trim() || record?.workingDirectory?.trim();
      if (!record || !workingDirectory || !input) return undefined;

      const extension = nodePath.extname(input.split(/[?#]/, 1)[0]).toLowerCase();
      const mediaType = IMAGE_PREVIEW_TYPES[extension];
      if (!mediaType) return undefined;

      // Markdown may contain a file URL when an agent copied one from a
      // browser or editor. Resolve it to a path before applying the same
      // session-folder boundary as the rest of the AI file tools.
      let candidateInput = input;
      if (/^file:\/\//i.test(candidateInput)) {
        try {
          candidateInput = decodeURIComponent(new URL(candidateInput).pathname);
        } catch {
          return undefined;
        }
      }

      let absolute: string;
      try {
        absolute = resolveSandboxedPath(workingDirectory, candidateInput);
      } catch (error) {
        if (error instanceof PathSandboxError) return undefined;
        throw error;
      }

      try {
        const stat = await fsp.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_IMAGE_PREVIEW_BYTES) return undefined;
        const contents = await fsp.readFile(absolute);
        return `data:${mediaType};base64,${contents.toString('base64')}`;
      } catch {
        // A response can arrive before an image is flushed, or refer to an
        // optional screenshot that was not produced. Keep the response useful
        // and let the filename remain visible rather than surfacing an IPC
        // error for a preview-only enhancement.
        return undefined;
      }
    }
  );

  ipcMain.handle(
    'ai:renameSession',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, title: string) =>
      sessionManager.renameAgentSession(issueKey, title)
  );

  ipcMain.handle('ai:deleteSession', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    if (!sessionManager.getAgentSession(issueKey)) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    await abortActiveTask(issueKey);
    disposeBrowserMcpForSession(issueKey);
    sessionManager.removeAgentSession(issueKey);
    sessionManager.removeSession(issueKey);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:sessionDeleted', issueKey);
      }
    }
  });

  ipcMain.handle(
    'ai:delegate',
    async (_event: Electron.IpcMainInvokeEvent, input: AiDelegateInput) => {
      const settings = getSettingsBackend().read();
      const mode: SessionMode = input.mode ?? (input.purpose === 'analysis' ? 'analysis' : 'chat');
      const isAnalysisSession = mode === 'analysis' || input.purpose === 'analysis';
      const analysisPrompt = settings.ai.analysisPrompt.trim();
      if (isAnalysisSession && !analysisPrompt) {
        throw new Error('Set an analysis system prompt under Settings → AI Provider first.');
      }
      const provider = input.provider ?? settings.ai.activeProvider;
      const descriptor = PROVIDER_DESCRIPTORS[provider];
      const profileId = input.profileId ?? input.agentId;
      const hostId = input.hostId ?? input.agentId;

      // Provider-only sessions need an API key up front. A bound ACP host owns
      // its own authentication, so selecting one must not be blocked by an
      // unrelated API-provider setting.
      const hasAgentBinding = !!profileId || !!hostId;
      const gateway = !hasAgentBinding && descriptor.kind === 'api'
        ? await resolveConnectionOptions(provider)
        : undefined;
      if (!hasAgentBinding && descriptor.kind === 'api' && !gateway?.apiKey) {
        throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
      }

      let issue: IssueDetails;
      let issueService: Awaited<ReturnType<typeof getServiceForConnection>> | undefined;
      if (input.issueKey) {
        issueService = await getServiceForConnection(input.connectionId);
        issue = await issueService.getIssue(input.issueKey);
      } else {
        // Free-form session from the New Session composer: no tracker issue, so
        // synthesize a minimal one with a unique key the session is stored under.
        const goal = (input.goal ?? input.task?.goal ?? '').trim();
        if (!goal) {
          throw new Error('Delegate needs either an issue key or a goal.');
        }
        issue = {
          key: `SESSION-${randomUUID().slice(0, 8)}`,
          summary: goal,
          issueType: 'Task',
          status: 'New',
          projectKey: 'SESSION'
        } as IssueDetails;
      }

      // Analysis gate: when enabled, an issue-bound delegation requires a
      // confirmed analysis first (mirrors the extension's assignIssueToAi gate).
      // Explicit Chat sessions are allowed to discuss an issue without first
      // running the analysis workflow. Keep the gate for legacy callers that
      // do not send a mode (for example delivery/delegation actions launched
      // from issue detail), so those existing safeguards remain intact.
      if (input.issueKey && settings.ai.analysisGateEnabled && input.mode === undefined && !isAnalysisSession) {
        if (!isAnalysisConfirmed(getAiAnalysisStore(), input.issueKey)) {
          throw new Error(
            `Analysis for ${input.issueKey} must be confirmed before delegating (the analysis gate is enabled in Settings → AI Provider).`
          );
        }
      }

      // An explicit composer mode owns the task contract. In particular, do
      // not let the goal override turn Chat back into the legacy planning
      // prompt (which starts with a mandatory ticket-analysis phase).
      const taskDefinition: AgentTaskDefinition = input.mode
        ? buildModeTask(mode, issue, analysisPrompt, input.task)
        : input.task
          ? buildDefaultTask(issue, input.task)
          : buildModeTask(mode, issue, analysisPrompt);
      // Workflow pack: an explicit task.workflow wins; otherwise apply the
      // issue's assigned pack so delegation and delivery behave the same.
      if (!taskDefinition.workflow && input.issueKey) {
        const assignment = sessionManager.getIssueWorkflowAssignment(input.issueKey);
        if (assignment?.workflow) {
          taskDefinition.workflow = assignment.workflow;
        }
      }
      // Match the extension's ticket-aware session start: stage every useful
      // issue attachment and add the generated manifest to the task contract
      // before the shared system prompt is built.
      // Demo issues deliberately expose illustrative attachment metadata but
      // have no downloadable bytes, so only real tracker services are staged.
      if (input.issueKey && issueService && issueService.mode !== 'demo') {
        const attachments = await stageIssueAttachments({
          issue,
          backendService: issueService,
          logger: { appendLine: message => console.log(`[ai] ${message}`) }
        });
        if (attachments.length > 0) {
          taskDefinition.attachments = attachments;
        }
      }
      const workingDirectory =
        input.workingDirectory?.trim() ||
        settings.ai.workingDirectory.trim() ||
        process.env.PRAXIS_AI_WORKING_DIR?.trim() ||
        undefined;
      const toolMode = isAnalysisSession ? 'read-only' : (input.toolMode ?? 'full');

      // A full-tools session edits and runs commands in its working directory —
      // require an explicit one rather than silently defaulting to the app's cwd.
      if (toolMode === 'full' && !workingDirectory) {
        throw new Error(
          'Choose a working folder for this session — full-tools sessions no longer default to the app directory.'
        );
      }

      // Optional: run the session in a dedicated git worktree branched off the
      // working directory's current branch, instead of editing it in place.
      let worktree:
        | { worktreePath: string; branchName: string; baseBranch: string; worktreeName: string }
        | undefined;
      if (input.runInWorktree) {
        if (!workingDirectory) {
          throw new Error('Pick a git repository folder to run this session in a worktree.');
        }
        const baseBranch =
          (await getCurrentBranch(workingDirectory)) ?? settings.delivery.defaultBaseBranch.trim();
        if (!baseBranch) {
          throw new Error('Could not determine a base branch for the worktree (detached HEAD?).');
        }
        const manager = new GitWorktreeManager({ appendLine: message => console.log(`[ai] ${message}`) });
        try {
          const prepared = await manager.prepareDeliveryWorktree(
            { key: issue.key, summary: issue.summary, branch: (issue as { branch?: string }).branch },
            baseBranch,
            workingDirectory,
            { forceClean: false }
          );
          worktree = {
            worktreePath: prepared.worktreePath,
            branchName: prepared.branchName,
            baseBranch: prepared.baseBranch,
            worktreeName: prepared.worktreeName
          };
        } catch (error) {
          if (error instanceof WorktreeConflictError) {
            throw new Error(
              `A worktree for ${issue.key} already exists at ${error.worktreePath}. Remove it (or that session) and retry.`
            );
          }
          throw error;
        }
      }
      const effectiveWorkingDirectory = worktree?.worktreePath ?? workingDirectory;

      const prepared = await prepareAgentLaunch({ profileId, hostId, provider, skillNames: input.skillNames });
      if (prepared.binding) taskDefinition.goal += `\n\n${await getAgentRuntimeManager().bindingContext(prepared.binding)}`;
      const skillActivations = prepared.skillActivations;
      const browserMcp = prepared.plan.state === 'acp'
        ? await browserMcpServerForSession(issue.key, toolMode)
        : undefined;
      await launchAgentTask(prepared, {
        issue,
        taskDefinition,
        provider,
        model: input.model,
        workingDirectory: effectiveWorkingDirectory,
        toolMode,
        ...(browserMcp ? { mcpServers: [browserMcp] } : {}),
        ...(prepared.plan.state === 'gateway'
          ? { toolExtension: mergeToolExtensions(trackerToolExtension(issueService, toolMode), browserToolExtension(toolMode)) }
          : {})
      });
      const record = sessionManager.getAgentSession(issue.key);
      if (!record) {
        throw new Error(`Session for ${issue.key} did not start.`);
      }
      if (input.connectionId) {
        sessionManager.updateAgentRuntime(issue.key, { connectionId: input.connectionId });
      }
      if (input.projectId) {
        sessionManager.updateAgentRuntime(issue.key, { projectId: input.projectId });
      }
      if (profileId && hostId) {
        sessionManager.updateAgentRuntime(issue.key, {
          agentId: hostId,
          profileId,
          hostId,
          ...(input.skillNames?.length ? { activeSkills: input.skillNames } : {}),
          ...(skillActivations.length ? { skillActivations } : {})
        });
      }
      if (worktree) {
        sessionManager.updateAgentRuntime(issue.key, {
          workingDirectory: worktree.worktreePath,
          worktreePath: worktree.worktreePath,
          worktreeBranch: worktree.branchName,
          worktreeBaseBranch: worktree.baseBranch,
          worktreeName: worktree.worktreeName
        });
      }
      return sessionManager.getAgentSession(issue.key) ?? record;
    }
  );

  ipcMain.handle('ai:abort', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    await abortActiveTask(issueKey);
    // Also settle a "ghost" session — one left non-terminal by a crash/restart
    // with no task behind it, so Abort still gets the user out of it.
    const record = sessionManager.getAgentSession(issueKey);
    if (record && !hasActiveTask(issueKey) && !['completed', 'failed', 'aborted'].includes(record.state)) {
      sessionManager.updateAgentState(issueKey, 'aborted');
    }
  });

  ipcMain.handle('ai:removeWorktree', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    const record = sessionManager.getAgentSession(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    if (hasActiveTask(issueKey)) {
      throw new Error('Wait for the current session to finish before removing its worktree.');
    }
    const worktreePath = record.worktreePath?.trim();
    const worktreeBranch = record.worktreeBranch?.trim();
    if (!worktreePath || !worktreeBranch) {
      throw new Error(`Session ${issueKey} has no dedicated worktree.`);
    }
    const manager = new GitWorktreeManager({ appendLine: message => console.log(`[ai] ${message}`) });
    try {
      await manager.removeDeliveryWorktree(worktreePath, { worktreePath, branchName: worktreeBranch });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not remove the session worktree: ${detail}`);
    }
    // The session ran in the worktree, so point it back at the main checkout.
    const mainRoot = nodePath.dirname(nodePath.dirname(worktreePath));
    sessionManager.updateAgentRuntime(issueKey, {
      workingDirectory: mainRoot,
      worktreePath: '',
      worktreeBranch: '',
      worktreeBaseBranch: '',
      worktreeName: ''
    });
  });

  ipcMain.handle(
    'ai:switchSessionMode',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, mode: SessionMode) => {
      if (mode !== 'chat' && mode !== 'analysis' && mode !== 'review') {
        throw new Error('Invalid session mode.');
      }
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) throw new Error(`No agent session found for ${issueKey}.`);
      if (record.state !== 'completed' && record.state !== 'failed' && record.state !== 'aborted') {
        throw new Error('Wait for the current session turn to finish before switching mode.');
      }
      sessionManager.setAgentSessionMode(issueKey, mode);
    }
  );

  ipcMain.handle(
    'ai:setAcpMode',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, modeId: string) => {
      // Distinct from `ai:switchSessionMode` above: that switches Praxis's own
      // chat/analysis/review phase between turns; this switches the agent's
      // own protocol-level Session Mode mid-turn, over the live ACP
      // connection — so unlike that one, it requires a running task.
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) throw new Error(`No agent session found for ${issueKey}.`);
      const provider = record.provider ?? getSettingsBackend().read().ai.activeProvider;
      const descriptor = PROVIDER_DESCRIPTORS[provider];
      if (descriptor.kind !== 'cli-agent') {
        throw new Error('Session modes are only available for ACP-hosted agents (Claude Code, Codex, GitHub Copilot).');
      }
      await getAcpAgentHost().setAcpMode(issueKey, modeId);
    }
  );

  ipcMain.handle(
    'ai:continueSession',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      message: string,
      images?: WireImageAttachment[]
    ) => {
      if (sessionManager.getAgentSession(issueKey)?.conversation?.state === 'running') {
        throw new Error('Stop the multi-AI conversation before sending a single-agent follow-up.');
      }
      await continueRecordedSession(issueKey, message, { images: sanitizeImages(images) });
    }
  );

  ipcMain.handle(
    'ai:updateSessionModel',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, model: string) => {
      const trimmed = model.trim();
      if (!trimmed) throw new Error('Choose a model.');
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) throw new Error(`No agent session found for ${issueKey}.`);
      if (hasActiveTask(issueKey)) {
        throw new Error('Wait for the session to finish this turn before changing model.');
      }
      const provider = record.provider ?? getSettingsBackend().read().ai.activeProvider;
      await assertModelAvailable(provider, trimmed);
      if (record.model === trimmed) return record;
      const descriptor = PROVIDER_DESCRIPTORS[provider];
      return sessionManager.transitionAgentRuntime(issueKey, {
        provider,
        model: trimmed,
        reason: 'model_change',
        clearNativeRuntime: descriptor.kind === 'cli-agent',
        eventSummary: `Model changed to ${trimmed}`,
        eventDetail: record.model ? `Previous model: ${record.model}` : undefined
      });
    }
  );

  ipcMain.handle(
    'ai:editHandoverBrief',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      expectedRevision: number,
      edits: AiHandoverBriefEdits
    ) => {
      sessionManager.editHandoverBrief(issueKey, expectedRevision, edits);
      return sessionManager.getAgentSession(issueKey)!;
    }
  );

  ipcMain.handle(
    'ai:handoverSession',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, input: AiHandoverInput) => {
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) throw new Error(`No agent session found for ${issueKey}.`);
      if (hasActiveTask(issueKey)) {
        throw new Error('Wait for the session to finish this turn before handing over.');
      }
      const targetProvider = input.provider;
      const descriptor = PROVIDER_DESCRIPTORS[targetProvider];
      if (!descriptor) throw new Error('Unknown provider.');
      const model = input.model?.trim() || undefined;
      if (model) await assertModelAvailable(targetProvider, model);
      if (input.briefEdits) {
        sessionManager.editHandoverBrief(issueKey, input.expectedBriefRevision, input.briefEdits);
      }
      await sessionManager.refreshHandoverBrief(issueKey);
      const current = sessionManager.getAgentSession(issueKey) ?? record;
      const envelope = buildHandoverEnvelope(current, { provider: targetProvider, model });
      sessionManager.transitionAgentRuntime(issueKey, {
        provider: targetProvider,
        model,
        reason: 'provider_handover',
        clearNativeRuntime: true,
        eventSummary: `Handed over to ${descriptor.label}${model ? ` (${model})` : ''}`,
        eventDetail: envelope.text
      });
      await continueRecordedSession(issueKey, envelope.text);
      return sessionManager.getAgentSession(issueKey)!;
    }
  );

  ipcMain.handle(
    'ai:startConversation',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, input: AiStartConversationInput) => {
      if (!input || !['consult', 'debate', 'pair'].includes(input.mode)) throw new Error('Choose a conversation mode.');
      if (!input.provider || !PROVIDER_DESCRIPTORS[input.provider]) throw new Error('Choose a valid second AI provider.');
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) throw new Error(`No agent session found for ${issueKey}.`);
      if (hasActiveTask(issueKey)) throw new Error('Wait for the current session turn to finish before bringing in another AI.');
      const model = input.model?.trim() || undefined;
      if (model) await assertModelAvailable(input.provider, model);
      const started = sessionManager.startAgentConversation(issueKey, { ...input, model });
      queueConversationTurn(issueKey);
      return started;
    }
  );

  ipcMain.handle(
    'ai:sendConversationMessage',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      input: { participantId: string; message: string; images?: WireImageAttachment[] }
    ) => {
      const message = typeof input?.message === 'string' ? input.message.trim() : '';
      const images = sanitizeImages(input?.images);
      if (!message && images.length === 0) throw new Error('Enter a message for the AI conversation.');
      const record = sessionManager.getAgentSession(issueKey);
      if (!record?.conversation || record.conversation.state !== 'running') throw new Error('No running multi-AI conversation.');
      sessionManager.queueAgentConversationMessage(issueKey, input.participantId, message, images);
      if (!hasActiveTask(issueKey) && !startingConversationTurns.has(issueKey)) {
        const pending = sessionManager.takeAgentConversationMessage(issueKey);
        if (pending) {
          sessionManager.setAgentConversationSpeaker(issueKey, pending.participantId);
          void runConversationTurn(issueKey, pending.message, pending.images).catch(() => undefined);
        }
      }
      return sessionManager.getAgentSession(issueKey)!;
    }
  );

  ipcMain.handle('ai:stopConversation', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    const record = sessionManager.getAgentSession(issueKey);
    if (!record?.conversation || record.conversation.state !== 'running') throw new Error('No multi-AI conversation is running.');
    // Mark it stopped before cancelling the active host: host cleanup emits an
    // activity change, and that callback must never schedule one final turn.
    const stopped = sessionManager.finishAgentConversation(issueKey, 'stopped');
    await abortActiveTask(issueKey);
    return stopped;
  });

  ipcMain.handle(
    'ai:setConversationToolOwner',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, participantId: string) => {
      if (hasActiveTask(issueKey)) throw new Error('Tool ownership can only change between turns.');
      return sessionManager.setAgentConversationToolOwner(issueKey, participantId);
    }
  );

  ipcMain.handle(
    'ai:respondToPermission',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, decision: PermissionDecision) => {
      respondToActivePermission(issueKey, decision);
    }
  );

  ipcMain.handle(
    'ai:undoToolFileChange',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, eventTimestamp: string, path: string) => {
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) {
        throw new Error(`No agent session found for ${issueKey}.`);
      }
      if (hasActiveTask(issueKey)) {
        throw new Error('Wait for the session to finish this turn before undoing an edit.');
      }
      const change = record.events
        .find(candidate => candidate.timestamp === eventTimestamp && candidate.type === 'tool_complete')
        ?.data?.fileChanges?.find(entry => entry.path === path);
      if (!change) {
        throw new Error(`No recorded edit to ${path} at that point in the session.`);
      }
      if (!isLatestEditToPath(record.events, eventTimestamp, path)) {
        throw new Error(`${path} was edited again after this — undoing this step would discard that later edit.`);
      }
      const workingDirectory = record.worktreePath?.trim() || record.workingDirectory?.trim();
      if (!workingDirectory) {
        throw new Error('This session has no working folder to undo the edit in.');
      }
      let absolute: string;
      try {
        absolute = resolveSandboxedPath(workingDirectory, path);
      } catch (error) {
        throw error instanceof PathSandboxError ? new Error(`${path} is outside this session's working folder.`) : error;
      }
      // `oldText` defaults to '' both for "the file was empty before" and for
      // "the file did not exist before" — ACP's diff block does not distinguish
      // the two, so a file this edit created comes back empty rather than gone.
      await fsp.writeFile(absolute, change.oldText ?? '', 'utf8');
      sessionManager.appendAgentEvents(issueKey, [
        { timestamp: new Date().toISOString(), type: 'info', summary: `You undid the edit to ${path}.` }
      ]);
      return sessionManager.getAgentSession(issueKey) ?? record;
    }
  );

  // ── Workflow packs ────────────────────────────────────────────────────────

  ipcMain.handle('ai:listWorkflowPacks', async () => {
    const settings = getSettingsBackend().read();
    const configuredRoot = settings.ai.workingDirectory.trim();
    const projectRoot = getProjectStore()
      .list()
      .map(project => project.workspaceFolder?.trim())
      .find((folder): folder is string => Boolean(folder));
    return discoverWorkspaceAgentWorkflows(configuredRoot || projectRoot || undefined);
  });

  ipcMain.handle('ai:getWorkflowAssignment', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) =>
    sessionManager.getIssueWorkflowAssignment(issueKey)
  );

  ipcMain.handle(
    'ai:setWorkflowAssignment',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      workflow: AgentWorkflowReference | null
    ) => {
      if (workflow) {
        sessionManager.setIssueWorkflowAssignment(issueKey, workflow, { source: 'manual' });
      } else {
        sessionManager.removeIssueWorkflowAssignment(issueKey);
      }
    }
  );

  // ── Ticket review ─────────────────────────────────────────────────────────

  const reviewControllers = new Map<string, AbortController>();
  const sendReviewProgress = (progress: AiReviewProgress): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:reviewProgress', progress);
      }
    }
  };

  ipcMain.handle(
    'ai:reviewIssue',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      connectionId?: string,
      requestedProvider?: AiProvider,
      requestedModel?: string
    ) => {
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      const provider = requestedProvider ?? settings.ai.activeProvider;

      reviewControllers.get(issueKey)?.abort();
      const controller = new AbortController();
      reviewControllers.set(issueKey, controller);
      sendReviewProgress({ issueKey, content: '', done: false });
      try {
        const markdown = await reviewIssueWithRuntime(issue, {
          provider,
          model: requestedModel,
          signal: controller.signal,
          onUpdate: content => sendReviewProgress({ issueKey, content, done: false })
        });
        sendReviewProgress({ issueKey, content: markdown, done: true });
        return markdown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendReviewProgress({ issueKey, content: '', done: true, error: message });
        throw error;
      } finally {
        reviewControllers.delete(issueKey);
      }
    }
  );

  ipcMain.handle('ai:cancelReview', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    reviewControllers.get(issueKey)?.abort();
  });

  // ── Local peer review ─────────────────────────────────────────────────────

  ipcMain.handle(
    'ai:localPeerReview',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      connectionId?: string,
      requestedProvider?: AiProvider,
      requestedModel?: string
    ) => {
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      const provider = requestedProvider ?? settings.ai.activeProvider;
      const runtime = { provider, model: requestedModel };
      const codeReview = await reviewIssueWithRuntime(issue, {
        ...runtime,
        systemPrompt: 'You are a senior software engineer. Review the implementation for correctness, maintainability, architecture, tests, and performance. Rate findings by severity.'
      });
      const securityReview = await reviewIssueWithRuntime(issue, {
        ...runtime,
        systemPrompt: 'You are a security engineer. Review for OWASP risks, authorization issues, data exposure, input validation, dependency concerns, and secrets handling. Rate findings by severity.'
      });
      const summary = await reviewIssueWithRuntime(
        {
          ...issue,
          description: `${issue.description ?? ''}\n\nCode review:\n${codeReview}\n\nSecurity review:\n${securityReview}`
        },
        {
          ...runtime,
          systemPrompt: 'You are a technical lead. Summarize the supplied code and security reviews with an overall Ready, Needs Changes, or Needs Major Rework verdict and concise next steps.'
        }
      );
      return { codeReview, securityReview, summary };
    }
  );

  ipcMain.handle(
    'ai:localPeerReviewFollowUp',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      message: string,
      connectionId?: string,
      requestedProvider?: AiProvider,
      requestedModel?: string
    ) => {
      const followUp = message.trim();
      if (!followUp) throw new Error('Enter a follow-up question.');
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      const provider = requestedProvider ?? settings.ai.activeProvider;
      return reviewIssueWithRuntime(issue, {
        provider,
        model: requestedModel,
        userPrompt: followUp,
        systemPrompt: 'You are continuing a local peer review conversation. Answer the user\'s follow-up directly and concisely. Keep the discussion grounded in the reviewed local project and do not modify files.'
      });
    }
  );

  const scheduleWhenTaskSettles = (issueKey: string) => {
    const record = sessionManager.getAgentSession(issueKey);
    if (!record?.conversation || record.conversation.state !== 'running' || hasActiveTask(issueKey)) return;
    if (record.state === 'completed') {
      const pending = sessionManager.takeAgentConversationMessage(issueKey);
      sessionManager.completeAgentConversationTurn(issueKey);
      const next = sessionManager.getAgentSession(issueKey);
      if (next?.conversation?.state === 'running') {
        if (pending) {
          sessionManager.setAgentConversationSpeaker(issueKey, pending.participantId);
          void runConversationTurn(issueKey, pending.message, pending.images).catch(() => undefined);
        } else {
          queueConversationTurn(issueKey);
        }
      }
    } else if (record.state === 'failed' || record.state === 'aborted') {
      sessionManager.finishAgentConversation(issueKey, 'failed');
    }
  };
  agentService.onDidChangeActiveTask(scheduleWhenTaskSettles);
  getAcpAgentHost().onDidChangeActiveTask(scheduleWhenTaskSettles);

  sessionManager.onDidChangeAgentSession((record: AgentSessionRecord) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send('ai:sessionChanged', record);
    }
    // A terminal state is published before each host removes its task. The
    // active-task listeners above schedule the next speaker only after that
    // cleanup, preserving the one-runtime-at-a-time invariant.
  });
}
