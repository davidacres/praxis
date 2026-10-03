import type { KeyValueStore } from '../../host/stateStore';
import { deriveChatTitle } from './assistantEngine';
import type { AssistantMessage, AssistantRole, TeamChatRecord, TeamChatSummary } from './assistantTypes';

const KEY = 'teamChats';

/** Durable team-chat transcripts, one record per conversation. */
export class TeamChatStore {
  public constructor(private readonly store: KeyValueStore) {}

  private all(): TeamChatRecord[] {
    return this.store.get<TeamChatRecord[]>(KEY) ?? [];
  }

  public list(projectId: string): TeamChatSummary[] {
    return this.all()
      .filter(chat => chat.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ messages, ...rest }) => ({
        ...rest,
        messageCount: messages.length,
        personas: [...new Set(messages.map(message => message.role).filter((role): role is AssistantRole => role !== 'user'))]
      }));
  }

  public get(id: string): TeamChatRecord | undefined {
    return this.all().find(chat => chat.id === id);
  }

  public async create(projectId: string, issueKey?: string): Promise<TeamChatRecord> {
    const now = new Date().toISOString();
    const chat: TeamChatRecord = {
      id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      title: 'New team chat',
      ...(issueKey ? { issueKey } : {}),
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    await this.store.update(KEY, [...this.all(), chat]);
    return chat;
  }

  /** Replaces a chat's transcript. A still-untitled chat is named from its first user message. */
  public async saveMessages(id: string, messages: readonly AssistantMessage[]): Promise<TeamChatRecord> {
    const chats = this.all();
    const index = chats.findIndex(chat => chat.id === id);
    if (index < 0) throw new Error(`Team chat ${id} was not found.`);
    const current = chats[index];
    const firstUser = messages.find(message => message.role === 'user');
    const next: TeamChatRecord = {
      ...current,
      messages: [...messages],
      updatedAt: new Date().toISOString(),
      title: current.title === 'New team chat' && firstUser ? deriveChatTitle(firstUser.text) : current.title
    };
    await this.store.update(KEY, chats.map((chat, i) => (i === index ? next : chat)));
    return next;
  }

  public async rename(id: string, title: string): Promise<TeamChatRecord> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('A chat needs a name.');
    const chats = this.all();
    const current = chats.find(chat => chat.id === id);
    if (!current) throw new Error(`Team chat ${id} was not found.`);
    const next = { ...current, title: trimmed.slice(0, 120) };
    await this.store.update(KEY, chats.map(chat => (chat.id === id ? next : chat)));
    return next;
  }

  public async remove(id: string): Promise<void> {
    await this.store.update(KEY, this.all().filter(chat => chat.id !== id));
  }
}
