import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { app } from 'electron';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import {
  runAssistantTurn,
  runTeamReview,
  TeamChatStore,
  parseAssistantMention,
  DEFAULT_ASSISTANT_ROLE,
  type AssistantCompletion,
  type AssistantMessage,
  type AssistantTeamReviewRequest,
  type AssistantTurnRequest,
  type AssistantRole,
  type AgentPermissionMode,
  type AgentToolMode,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AiProvider,
  type ReasoningEffort,
  type WireImageAttachment,
  type IssueDetails
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { assistantCapabilityNote } from './assistantCapability';
import { sanitizeImages } from './aiIpc';
import { reviewIssueWithRuntime } from './aiReviewRuntime';
import { getSettingsBackend } from './settingsBackendInstance';
import { broadcastToAllWindows } from './windowBroadcast';
import { getAiSessionManager } from './aiInstance';
import { continueAgentTask, launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';

let chatStore: TeamChatStore | undefined;
const activeToolSessions = new Set<string>();
const TRANSCRIPT_CHECKPOINT = 'Virtual Team transcript checkpoint';

/** `userData/team-chats.json` — per-profile like the other AI stores, so e2e profiles never share chats. */
function getTeamChatStore(): TeamChatStore {
  if (!chatStore) chatStore = new TeamChatStore(new JsonKeyValueStore(path.join(app.getPath('userData'), 'team-chats.json')));
  return chatStore;
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

type AssistantRuntimeOptions = { provider?: AiProvider; model?: string; reasoningEffort?: ReasoningEffort; permissionMode?: AgentPermissionMode; mode?: 'chat' | 'analysis' | 'review'; toolMode?: AgentToolMode; workingDirectory?: string; toolSessionPrefix?: string; personaId?: AssistantRole; images?: WireImageAttachment[] };

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
  const completed = new Promise<AgentSessionRecord>(resolve => {
    subscription = manager.onDidChangeAgentSession(record => {
      if (record.issueKey !== issue.key) return;
      if (!['completed', 'failed', 'aborted'].includes(record.state)) started = true;
      // Continuation preparation also emits the previous completed record.
      else if (started) resolve(record);
    });
  });
  try {
    const prepared = await prepareAgentLaunch({ provider });
    if (existing) {
      await continueAgentTask(prepared, {
        issueKey: issue.key,
        message: userPrompt,
        model: runtime.model,
        workingDirectory,
        toolMode,
        ...(runtime.images?.length ? { images: runtime.images } : {})
      });
    } else await launchAgentTask(prepared, {
      issue,
      taskDefinition,
      provider,
      model: runtime.model?.trim() || undefined,
      workingDirectory,
      toolMode,
      ...(runtime.images?.length ? { images: runtime.images } : {}),
      permissionMode: runtime.permissionMode ?? 'manual',
      reasoningEffort: runtime.reasoningEffort,
      ...((runtime.permissionMode === 'bypass' || runtime.permissionMode === 'autopilot') ? { autoApprovePermissions: true } : {})
    });
    const record = await completed;
    if (record.state !== 'completed') throw new Error(record.lastError ?? `Assistant tool turn ${record.state}.`);
    const reply = [...record.events].reverse().find(event => event.type === 'message')?.detail ?? record.responseText;
    if (!reply?.trim()) throw new Error('The assistant tool turn returned no reply.');
    return reply.trim();
  } finally {
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

  ipcMain.handle('assistant:turn', async (_event, rawRequest: AssistantTurnRequest & AssistantRuntimeOptions) => {
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
      const reply = result.messages.find(message => !message.error);
      if (sessionKey && reply) {
        manager.appendAgentEvents(sessionKey, [{ type: 'info', timestamp: new Date().toISOString(), summary: TRANSCRIPT_CHECKPOINT, detail: reply.id }]);
      }
      return result;
    } finally {
      if (sessionKey) activeToolSessions.delete(sessionKey);
    }
  });
  ipcMain.handle('assistant:teamReview', (_event, request: AssistantTeamReviewRequest) => runTeamReview(request, completionFor({})));

  ipcMain.handle('assistant:listChats', (_event, projectId: string) => getTeamChatStore().list(projectId));
  ipcMain.handle('assistant:getChat', (_event, chatId: string) => getTeamChatStore().get(chatId));
  ipcMain.handle('assistant:createChat', async (_event, projectId: string, issueKey?: string) => {
    const chat = await getTeamChatStore().create(projectId, issueKey);
    changed();
    return chat;
  });
  ipcMain.handle('assistant:saveChat', async (_event, chatId: string, messages: AssistantMessage[]) => {
    const chat = await getTeamChatStore().saveMessages(chatId, messages);
    changed();
    return chat;
  });
  ipcMain.handle('assistant:renameChat', async (_event, chatId: string, title: string) => {
    const chat = await getTeamChatStore().rename(chatId, title);
    changed();
    return chat;
  });
  ipcMain.handle('assistant:deleteChat', async (_event, chatId: string) => {
    await getTeamChatStore().remove(chatId);
    changed();
  });
}
