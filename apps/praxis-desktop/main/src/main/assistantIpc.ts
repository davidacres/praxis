import * as path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  runAssistantTurn,
  runTeamReview,
  TeamChatStore,
  type AssistantCompletion,
  type AssistantMessage,
  type AssistantTeamReviewRequest,
  type AssistantTurnRequest,
  type IssueDetails
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { reviewIssueWithRuntime } from './aiReviewRuntime';
import { getSettingsBackend } from './settingsBackendInstance';
import { broadcastToAllWindows } from './windowBroadcast';

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

const complete: AssistantCompletion = async ({ systemPrompt, userPrompt, allowMutations }) => {
  const settings = getSettingsBackend().read();
  const provider = settings.ai.activeProvider;
  const configuredModel = provider === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[provider]?.defaultModel;
  const reply = await reviewIssueWithRuntime(ASSISTANT_ISSUE, {
    provider,
    model: configuredModel?.trim() || undefined,
    systemPrompt,
    userPrompt,
    allowMutations
  });
  return stripReviewHeading(reply);
};

export function registerAssistantIpc(): void {
  const changed = () => broadcastToAllWindows('assistant:chatsChanged');

  ipcMain.handle('assistant:turn', (_event, request: AssistantTurnRequest) => runAssistantTurn(request, complete));
  ipcMain.handle('assistant:teamReview', (_event, request: AssistantTeamReviewRequest) => runTeamReview(request, complete));

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
