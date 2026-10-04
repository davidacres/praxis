import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { app, ipcMain } from 'electron';
import {
  runAssistantTurn,
  runTeamReview,
  TeamChatStore,
  type AssistantCompletion,
  type AssistantMessage,
  type AssistantTeamReviewRequest,
  type AssistantTurnRequest,
  type AgentPermissionMode,
  type AgentToolMode,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AiProvider,
  type ReasoningEffort,
  type IssueDetails
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { reviewIssueWithRuntime } from './aiReviewRuntime';
import { getSettingsBackend } from './settingsBackendInstance';
import { broadcastToAllWindows } from './windowBroadcast';
import { getAiSessionManager } from './aiInstance';
import { launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';

let chatStore: TeamChatStore | undefined;

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

type AssistantRuntimeOptions = { provider?: AiProvider; model?: string; reasoningEffort?: ReasoningEffort; permissionMode?: AgentPermissionMode; mode?: 'chat' | 'analysis' | 'review'; toolMode?: AgentToolMode; workingDirectory?: string; toolSessionPrefix?: string };

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
  const issue = { ...ASSISTANT_ISSUE, key: `${runtime.toolSessionPrefix?.startsWith('ASSISTANT-') ? runtime.toolSessionPrefix : 'ASSISTANT'}-${randomUUID().slice(0, 8)}`, summary: 'Virtual Team tool turn' };
  const taskDefinition: AgentTaskDefinition = {
    kind: mode === 'chat' ? 'general' : mode,
    sessionMode: mode,
    goal: `${systemPrompt}\n\n${MODE_INSTRUCTIONS[mode]}\n\n${userPrompt}`,
    scope: `Work only in the selected folder: ${workingDirectory}`,
    definitionOfDone: 'Respond to the Virtual Team chat with the result.'
  };
  const manager = getAiSessionManager();
  let subscription: { dispose(): void } | undefined;
  const completed = new Promise<AgentSessionRecord>((resolve, reject) => {
    subscription = manager.onDidChangeAgentSession(record => {
      if (record.issueKey !== issue.key || !['completed', 'failed', 'aborted'].includes(record.state)) return;
      if (record.state === 'completed') resolve(record);
      else reject(new Error(record.lastError ?? `Assistant tool turn ${record.state}.`));
    });
  });
  try {
    const prepared = await prepareAgentLaunch({ provider });
    await launchAgentTask(prepared, {
      issue,
      taskDefinition,
      provider,
      model: runtime.model?.trim() || undefined,
      workingDirectory,
      toolMode,
      permissionMode: runtime.permissionMode ?? 'manual',
      reasoningEffort: runtime.reasoningEffort,
      ...((runtime.permissionMode === 'bypass' || runtime.permissionMode === 'autopilot') ? { autoApprovePermissions: true } : {})
    });
    const record = await completed;
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
      systemPrompt: `${systemPrompt}\n\n${MODE_INSTRUCTIONS[runtime.mode ?? 'chat']}\n\nPermission mode selected in the composer: ${runtime.permissionMode ?? 'manual'}. This Virtual Team chat is read-only and cannot execute tools.`,
      userPrompt,
      allowMutations
    });
    return stripReviewHeading(reply);
  };
}

export function registerAssistantIpc(): void {
  const changed = () => broadcastToAllWindows('assistant:chatsChanged');

  ipcMain.handle('assistant:turn', (_event, rawRequest: AssistantTurnRequest & AssistantRuntimeOptions) => {
    const { provider, model, reasoningEffort, permissionMode, mode, toolMode, workingDirectory, toolSessionPrefix, ...request } = rawRequest;
    return runAssistantTurn(request, completionFor({ provider, model, reasoningEffort, permissionMode, mode, toolMode, workingDirectory, toolSessionPrefix }));
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
