import { createTeamChatServices } from './teamChatServices';
import { createTeamChatCommands } from './teamChatCommands';
import { getProjectStore } from './projectStoreInstance';
import { TeamChatAttachments } from './teamChatAttachments';
import { createProductionTeamChatExecutionAdapter, runtimeApprovalRequestId, type TeamChatRuntimeOptions } from './teamChatExecutionAdapter';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { app } from 'electron';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import {
  PROTOCOL_PROMPT,
  conversationPayloadDigest,
  runAssistantTurn,
  runTeamReview,
  TeamChatCoordinator,
  parseAssistantMention,
  DEFAULT_ASSISTANT_ROLE,
  type AssistantCompletion,
  type AssistantMessage,
  type AssistantTeamReviewRequest,
  type AssistantTurnRequest,
  type AssistantRole,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AiProvider,
  type IssueDetails,
  type LegacyRuntimeSessionEvidence,
  type ConversationUpdate,
  type SubmitConversationCommand
} from '@praxis/core';
import { assistantCapabilityNote } from './assistantCapability';
import { sanitizeImages } from './aiIpc';
import { reviewIssueWithRuntime } from './aiReviewRuntime';
import { getSettingsBackend } from './settingsBackendInstance';
import { broadcastToAllWindows } from './windowBroadcast';
import { getAiSessionManager, abortActiveTask, resolveConnectionOptions, assertCanRunAgentSession } from './aiInstance';
import { continueAgentTask, launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';

const attachments = () => new TeamChatAttachments(path.join(app.getPath('userData'), 'team-chat-attachments'));
const activeToolSessions = new Set<string>();
const TRANSCRIPT_CHECKPOINT = 'Virtual Team transcript checkpoint';

/** The shape `toolSessionKey` gave every pre-durable Virtual Team runtime session. */
const LEGACY_TOOL_SESSION_KEY = /^ASSISTANT-.+-(lead|dev|qa|security|product)-[0-9a-f]{16}$/;

/**
 * Structural facts about pre-durable Virtual Team runtime sessions, for migration to prove
 * links from. Records are only read — never rewritten or deleted — and a transcript that
 * fails to load yields no checkpoints, so that record becomes a diagnostic, never a blocker.
 */
async function collectLegacyRuntimeEvidence(): Promise<LegacyRuntimeSessionEvidence[]> {
  const manager = getAiSessionManager();
  const evidence: LegacyRuntimeSessionEvidence[] = [];
  for (const [key, summary] of manager.getAllAgentSessions()) {
    if (!LEGACY_TOOL_SESSION_KEY.test(key) || summary.teamChatExecution) continue;
    let record: AgentSessionRecord = summary;
    try { record = await manager.ensureSessionTranscript(key) ?? summary; } catch { /* no checkpoints: unprovable */ }
    evidence.push({ issueKey: key, state: record.state,
      ...(record.provider ? { provider: record.provider } : {}), ...(record.model ? { model: record.model } : {}),
      ...(record.taskDefinition?.definitionOfDone ? { definitionOfDone: record.taskDefinition.definitionOfDone } : {}),
      checkpointMessageIds: (record.events ?? []).filter(event => event.type === 'info' && event.summary === TRANSCRIPT_CHECKPOINT && event.detail)
        .map(event => String(event.detail)) });
  }
  return evidence;
}

/** `userData/team-chats.json` — per-profile like the other AI stores, so e2e profiles never share chats. */
const teamChats = createTeamChatServices({
  filePath: () => path.join(app.getPath('userData'), 'team-chats.json'),
  enabled: process.env.PRAXIS_DURABLE_TEAM_CHAT !== '0',
  legacyRuntimeEvidence: collectLegacyRuntimeEvidence,
  createCoordinator: repository => new TeamChatCoordinator({
    repository,
    captureRuntimeOptions: options => {
      const settings = getSettingsBackend().read();
      const provider = String(options.provider ?? settings.ai.activeProvider) as AiProvider;
      const model = options.model || (provider === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[provider]?.defaultModel);
      return { ...options, provider, ...(model ? { model } : {}),
        toolMode: options.toolMode ?? 'project-only',
        workingDirectory: options.workingDirectory ?? settings.ai.workingDirectory };
    },
    onUpdate: update => {
      broadcastToAllWindows('assistant:conversationUpdate', update);
      broadcastToAllWindows('assistant:chatsChanged');
    },
    executionAdapter: createProductionTeamChatExecutionAdapter({
      settings: () => getSettingsBackend().read(), resolveConnectionOptions, completeWithTools,
      liveRuntimeSessions: () => getAiSessionManager().getAllAgentSessions().values(),
      resolveAttachments: (id, refs) => attachments().resolve(id, refs),
      resolveRuntimeConfiguration: async provider => {
        const prepared = await prepareAgentLaunch({ provider });
        return `${provider}:${conversationPayloadDigest(JSON.parse(JSON.stringify(prepared)))}`;
      }
    })
  })
});
const activation = teamChats.activation;
/** Validated durable-chat commands; see `teamChatCommands.ts` for what is checked before acceptance. */
const teamChatCommands = createTeamChatCommands({
  services: teamChats,
  attachments,
  projectExists: id => Boolean(getProjectStore().get(id)),
  activeProvider: () => getSettingsBackend().read().ai.activeProvider,
  assertCanRunAgentSession
});
const activate = teamChats.activate;
const getTeamChatRepository = teamChats.repository;
const getTeamChatStore = teamChats.store;

export function getTeamChatCoordinator(): TeamChatCoordinator {
  return teamChats.coordinator();
}

/** Reconcile and resume durable team chats at launch, before any window asks for one. */
export function recoverTeamChatsOnStartup(): Promise<boolean> {
  return teamChats.recoverOnStartup();
}

/** The assistant has no ticket of its own; the runtime wants one, so give it an empty stand-in. */
const ASSISTANT_ISSUE: IssueDetails = {
  key: 'assistant:team-chat',
  summary: 'Team chat',
  status: 'open',
  issueType: 'chat',
  projectKey: 'assistant',
  projectName: 'Praxis',
  // The runtime frames every call as a ticket review; say plainly that this one is a chat turn.
  description: 'This is not a real ticket. Ignore any request to review a ticket and respond to the user message given in the instructions above.'
};

/** CLI hosts wrap their reply in a review heading; a chat bubble does not want it. */
function stripReviewHeading(reply: string): string {
  return reply.replace(/^## AI Review by [^\n]*\n+/, '');
}

type AssistantRuntimeOptions = TeamChatRuntimeOptions;

function toolSessionKey(runtime: AssistantRuntimeOptions): string {
  // Reuse one execution per chat and persona. A changed runtime or permission
  // boundary gets its own execution rather than silently retaining old access.
  const configuration = createHash('sha256').update(JSON.stringify([
    runtime.provider, runtime.model, runtime.reasoningEffort ?? 'medium',
    runtime.permissionMode ?? 'manual', runtime.mode ?? 'chat',
    runtime.toolMode, runtime.workingDirectory?.trim()
  ])).digest('hex').slice(0, 16);
  return `${runtime.toolSessionPrefix}-${runtime.personaId ?? DEFAULT_ASSISTANT_ROLE}-${configuration}`;
}

const MODE_INSTRUCTIONS = {
  chat: 'Answer the user conversationally.',
  analysis: 'Analyze the user request and available context. Explain your reasoning, options, and a concrete plan without making changes.',
  review: 'Review the user request and available context critically. Report findings, risks, and actionable recommendations without making changes.'
} as const;

async function completeWithTools(runtime: AssistantRuntimeOptions, systemPrompt: string, userPrompt: string): Promise<string> {
  const settings = getSettingsBackend().read();
  const provider = runtime.provider ?? settings.ai.activeProvider;
  const workingDirectory = runtime.workingDirectory?.trim();
  if (!workingDirectory) throw new Error('Choose a working folder before using assistant tools.');
  if (!path.isAbsolute(workingDirectory) || !(await stat(workingDirectory).catch(() => undefined))?.isDirectory()) {
    throw new Error('The selected assistant working folder is unavailable.');
  }
  const mode = runtime.mode ?? 'chat';
  const toolMode = mode === 'chat' ? runtime.toolMode ?? 'read-only' : 'read-only';
  const issue = { ...ASSISTANT_ISSUE, key: toolSessionKey(runtime), summary: 'Virtual Team conversation' };
  const durablePrefix = `${MODE_INSTRUCTIONS[mode]}\n\n${PROTOCOL_PROMPT}\n\n${assistantCapabilityNote({ toolMode, mode, workingDirectory })}`;
  const durableContext = runtime.durableContext ? {
    reconstruction: `${durablePrefix}\n\n${runtime.durableContext.reconstruction}`,
    continuation: `${durablePrefix}\n\n${runtime.durableContext.continuation}`
  } : undefined;
  const taskDefinition: AgentTaskDefinition = {
    kind: mode === 'chat' ? 'general' : mode,
    sessionMode: mode,
    goal: `${systemPrompt}\n\n${MODE_INSTRUCTIONS[mode]}\n\n${assistantCapabilityNote({ toolMode, mode, workingDirectory })}\n\n${userPrompt}`,
    scope: `Work only in the selected folder: ${workingDirectory}`,
    definitionOfDone: 'Respond to the Virtual Team chat with the result.'
  };
  const manager = getAiSessionManager();
  const existing = await manager.ensureSessionTranscript(issue.key);
  if (existing && !['completed', 'failed', 'aborted'].includes(existing.state)) {
    throw new Error('This team member is still answering.');
  }
  let subscription: { dispose(): void } | undefined;
  let started = false;
  let reportedApproval: string | undefined;
  const completed = new Promise<AgentSessionRecord>(resolve => {
    subscription = manager.onDidChangeAgentSession(record => {
      if (record.issueKey !== issue.key) return;
      if (!['completed', 'failed', 'aborted'].includes(record.state)) {
        started = true;
        if (record.responseText || record.state === 'awaiting_approval') runtime.onAccepted?.();
        if (runtime.ownership && record.teamChatExecution?.attemptId === runtime.ownership.attemptId) {
          const requestId = runtimeApprovalRequestId(record);
          if (requestId && requestId !== reportedApproval) {
            // A new head request supersedes the previous one: settle that first, then record the next.
            if (reportedApproval) runtime.onApproval?.({ runtimeRequestId: reportedApproval, resolved: true });
            reportedApproval = requestId;
            runtime.onApproval?.({ runtimeRequestId: requestId });
          } else if (!requestId && reportedApproval) {
            runtime.onApproval?.({ runtimeRequestId: reportedApproval, resolved: true });
            reportedApproval = undefined;
          }
        }
      }
      // Continuation preparation also emits the previous completed record.
      else if (started && (!runtime.ownership || record.teamChatExecution?.attemptId === runtime.ownership.attemptId)) resolve(record);
    });
  });
  const onAbort = () => {
    void abortActiveTask(issue.key);
  };
  runtime.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (runtime.signal?.aborted) throw new Error('Team chat execution cancelled.');
    const prepared = await prepareAgentLaunch({ provider });
    if (runtime.signal?.aborted) throw new Error('Team chat execution cancelled.');
    if (existing) {
      await continueAgentTask(prepared, {
        issueKey: issue.key,
        durableContext,
        message: userPrompt,
        model: runtime.model,
        workingDirectory,
        toolMode,
        ...(runtime.images?.length ? { images: runtime.images } : {})
      });
    } else await launchAgentTask(prepared, {
      issue,
      taskDefinition,
      durableContext,
      provider,
      model: runtime.model?.trim() || undefined,
      workingDirectory,
      toolMode,
      ...(runtime.images?.length ? { images: runtime.images } : {}),
      permissionMode: runtime.permissionMode ?? 'manual',
      reasoningEffort: runtime.reasoningEffort,
      ...((runtime.permissionMode === 'bypass' || runtime.permissionMode === 'autopilot') ? { autoApprovePermissions: true } : {})
    });
    if (runtime.ownership) manager.updateAgentRuntime(issue.key, { teamChatExecution: runtime.ownership });
    if (runtime.signal?.aborted) onAbort();
    const record = await completed;
    runtime.onTerminal?.(record);
    if (record.state !== 'completed') throw new Error(record.lastError ?? `Assistant tool turn ${record.state}.`);
    const reply = [...record.events].reverse().find(event => event.type === 'message')?.detail ?? record.responseText;
    if (!reply?.trim()) throw new Error('The assistant tool turn returned no reply.');
    return reply.trim();
  } finally {
    runtime.signal?.removeEventListener('abort', onAbort);
    subscription?.dispose();
  }
}

function completionFor(runtime: AssistantRuntimeOptions): AssistantCompletion {
  return async ({ systemPrompt, userPrompt, allowMutations }) => {
    if (runtime.toolMode && runtime.toolMode !== 'project-only') {
      return completeWithTools(runtime, systemPrompt, userPrompt);
    }
    const settings = getSettingsBackend().read();
    const provider = runtime.provider ?? settings.ai.activeProvider;
    const configuredModel = provider === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[provider]?.defaultModel;
    const reply = await reviewIssueWithRuntime(ASSISTANT_ISSUE, {
      provider,
      model: runtime.model?.trim() || configuredModel?.trim() || undefined,
      reasoningEffort: runtime.reasoningEffort,
      permissionMode: runtime.permissionMode,
      // Virtual Team chat never executes tools. The permission chip is retained
      // for composer consistency but does not grant tool access in this chat.
      systemPrompt: `${systemPrompt}\n\n${MODE_INSTRUCTIONS[runtime.mode ?? 'chat']}\n\nPermission mode selected in the composer: ${runtime.permissionMode ?? 'manual'}. This Virtual Team chat is read-only and cannot execute tools.\n\n${assistantCapabilityNote({ toolMode: 'project-only', mode: runtime.mode ?? 'chat' })}`,
      userPrompt,
      allowMutations
    });
    return stripReviewHeading(reply);
  };
}

export function registerAssistantIpc(): void {
  const changed = () => broadcastToAllWindows('assistant:chatsChanged');

  ipcMain.handle('assistant:turn', async (_event, rawRequest: AssistantTurnRequest & AssistantRuntimeOptions) => activation.legacy(async () => {
    if (getTeamChatRepository().read().activation) throw new Error('Legacy assistant turns are disabled.');
    const { provider, model, reasoningEffort, permissionMode, mode, toolMode, workingDirectory, toolSessionPrefix, images, ...request } = rawRequest;
    const settings = getSettingsBackend().read();
    const selectedProvider = provider ?? settings.ai.activeProvider;
    const personaId = parseAssistantMention(request.message).personaId ?? rawRequest.personaId ?? DEFAULT_ASSISTANT_ROLE;
    const runtime: AssistantRuntimeOptions = {
      provider: selectedProvider,
      model: model?.trim() || (selectedProvider === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[selectedProvider]?.defaultModel)?.trim() || undefined,
      reasoningEffort, permissionMode, mode, toolMode, workingDirectory, personaId,
      toolSessionPrefix: toolSessionPrefix?.startsWith('ASSISTANT-') ? toolSessionPrefix : `ASSISTANT-${randomUUID()}`,
      images: sanitizeImages(images)
    };
    const sessionKey = toolMode && toolMode !== 'project-only' ? toolSessionKey(runtime) : undefined;
    if (sessionKey && activeToolSessions.has(sessionKey)) throw new Error('This team member is still answering.');
    if (sessionKey) activeToolSessions.add(sessionKey);
    try {
      const manager = getAiSessionManager();
      const existing = sessionKey ? await manager.ensureSessionTranscript(sessionKey) : undefined;
      let history = request.history;
      // The runtime retains its own turns. A persisted checkpoint identifies
      // exactly which shared-chat messages it has seen, even after switching
      // runtimes and returning, or restarting the app.
      const checkpoint = existing && [...existing.events].reverse().find(event => event.type === 'info' && event.summary === TRANSCRIPT_CHECKPOINT)?.detail;
      const previousReply = checkpoint ? history?.findIndex(message => message.id === checkpoint) ?? -1 : -1;
      if (previousReply >= 0) history = history?.slice(previousReply + 1);
      const result = await runAssistantTurn({ ...request, personaId, history }, completionFor(runtime));
      // An old text-only client may have no conversation identity. Persist its
      // result before releasing the activation fence, without guessing a chat.
      await getTeamChatRepository().transaction(draft => {
        (draft.legacyDiagnostics ??= []).push({ id: randomUUID(), completedAt: new Date().toISOString(),
          ...(request.context ? { context: request.context } : {}), messages: result.messages });
      });
      const reply = result.messages.find(message => !message.error);
      if (sessionKey && reply) {
        manager.appendAgentEvents(sessionKey, [{ type: 'info', timestamp: new Date().toISOString(), summary: TRANSCRIPT_CHECKPOINT, detail: reply.id }]);
      }
      return result;
    } finally {
      if (sessionKey) activeToolSessions.delete(sessionKey);
    }
  }));
  ipcMain.handle('assistant:sessionTurn', (_event, raw: AssistantTurnRequest & AssistantRuntimeOptions) => {
    const { provider, model, reasoningEffort, permissionMode, ...request } = raw;
    return runAssistantTurn(request, completionFor({ provider, model, reasoningEffort, permissionMode, toolMode: 'project-only' }));
  });
  ipcMain.handle('assistant:teamReview', (_event, request: AssistantTeamReviewRequest) => runTeamReview(request, completionFor({})));

  ipcMain.handle('assistant:listChats', (_event, projectId: string) => teamChatCommands.listChats(projectId));
  ipcMain.handle('assistant:getChat', async (_event, chatId: string) => { await activate(); return getTeamChatStore().get(chatId); });
  ipcMain.handle('assistant:createChat', async (_event, projectId: string, issueKey?: string) => {
    const chat = await teamChatCommands.createChat(projectId, issueKey);
    changed();
    return chat;
  });
  ipcMain.handle('assistant:saveChat', async (_event, chatId: string, messages: AssistantMessage[]) => {
    const chat = await activation.legacy(() => getTeamChatStore().saveMessages(chatId, messages));
    changed();
    return chat;
  });
  ipcMain.handle('assistant:renameChat', async (_event, chatId: string, title: string) => {
    await activate();
    const chat = await getTeamChatStore().rename(chatId, title);
    changed();
    return chat;
  });
  ipcMain.handle('assistant:deleteChat', async (_event, chatId: string) => {
    await activate();
    await getTeamChatCoordinator().removeConversation(chatId);
    changed();
  });

  ipcMain.handle('assistant:control', async (_event, command: import('@praxis/core').ConversationControlCommand) => (await teamChatCommands.control(command)).conversation);
  ipcMain.handle('assistant:stageAttachments', async (_event, id: string, images: import('@praxis/core').WireImageAttachment[]) => {
    await activate();
    if (!getTeamChatStore().get(id)) throw new Error('Conversation was not found.');
    return attachments().stage(id, images);
  });
  // Accepted work is owned by the coordinator, never by `event.sender`: closing the window that
  // submitted a turn cancels nothing, and every window observes it through the broadcast updates.
  ipcMain.handle('assistant:submitTurn', (_event, command: SubmitConversationCommand) => teamChatCommands.submitTurn(command));
  ipcMain.handle('assistant:getConversation', (_event, conversationId: string) => teamChatCommands.getConversation(conversationId));
  ipcMain.handle('assistant:cancelTurn', (_event, command: import('@praxis/core').CancelTurnCommand) => teamChatCommands.cancelTurn(command));
  ipcMain.handle('assistant:retryParticipant', (_event, command: import('@praxis/core').RetryParticipantCommand) => teamChatCommands.retryParticipant(command));
  ipcMain.handle('assistant:resolveAttempt', (_event, command: import('@praxis/core').ResolveAttemptCommand) => teamChatCommands.resolveAttempt(command));
}
