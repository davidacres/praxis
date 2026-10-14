import { useCallback, useEffect, useState } from 'react';
import type { TeamChatSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { useAssistant } from './AssistantProvider';
import { personaMeta } from './personaMeta';

/** A project's persisted team chats, kept current as chats are created, renamed or removed. */
export function useProjectTeamChats(projectId: string): TeamChatSummary[] {
  const [chats, setChats] = useState<TeamChatSummary[]>([]);
  const refresh = useCallback(() => {
    void window.praxis.assistant.listChats(projectId).then(setChats).catch(() => setChats([]));
  }, [projectId]);
  useEffect(() => {
    refresh();
    return window.praxis.assistant.onChatsChanged(refresh);
  }, [refresh]);
  return chats;
}

/** Opens a fresh team chat for the project in the assistant. */
export function useStartTeamChat(projectId: string): () => void {
  const assistant = useAssistant();
  return () => {
    assistant.setProjectId(projectId);
    assistant.newChat();
    assistant.setOpen(true);
  };
}

interface TeamChatRowProps {
  projectId: string;
  chat: TeamChatSummary;
  /** "5m ago", from the ledger's shared clock. */
  ago?: string;
}

/**
 * A team chat as one row of the sidebar's recency feed (E6), beside the project's sessions: the
 * participants stack in the lead gutter where a session shows its provider's mark, and the meta
 * line names it as a team chat.
 */
export function TeamChatRow({ projectId, chat, ago }: TeamChatRowProps) {
  const assistant = useAssistant();
  const { confirm, prompt } = useDialogs();
  const open = () => {
    assistant.setProjectId(projectId);
    void assistant.loadChat(chat.id);
  };
  const rename = async () => {
    const title = await prompt({ title: 'Rename team chat', label: 'Name', initialValue: chat.title, validate: value => (value.trim() ? undefined : 'A chat needs a name.') });
    if (title) await window.praxis.assistant.renameChat(chat.id, title);
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete team chat?', message: `"${chat.title}" will be removed permanently.`, confirmLabel: 'Delete', danger: true }))) return;
    await window.praxis.assistant.deleteChat(chat.id);
    assistant.chatDeleted(chat.id);
  };
  const participants = chat.personas.length;

  return (
    <div className={`team-chat-row ledger-row${assistant.chatId === chat.id ? ' active' : ''}`} data-testid="team-chat-row">
      <button type="button" className="team-chat-main" title={chat.title} onClick={open} onDoubleClick={() => void rename()}>
        <span className="ledger-lead team-chat-personas" aria-hidden="true">
          {participants > 0
            ? chat.personas.map(role => <span key={role} className={`team-chat-dot persona-badge--${role}`} title={personaMeta(role).name} />)
            : <Icon name="chats" size={14} />}
        </span>
        <span className="ledger-body">
          <span className="ledger-title-row">
            <span className="ledger-title tree-label">{chat.title}</span>
            {ago && <time className="ledger-time" dateTime={chat.updatedAt}>{ago}</time>}
          </span>
          <span className="ledger-meta">
            {chat.issueKey && <span className="ledger-chip">{chat.issueKey}</span>}
            <span>team chat · {participants} participant{participants === 1 ? '' : 's'}</span>
          </span>
        </span>
      </button>
      <button type="button" className="icon-btn icon-btn-sm team-chat-delete" aria-label={`Delete team chat ${chat.title}`} onClick={() => void remove()}>
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}
