import { useCallback, useEffect, useState } from 'react';
import type { TeamChatSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { useAssistant } from './AssistantProvider';
import { personaMeta } from './personaMeta';

/** A project's persisted team chats, kept current as chats are created, renamed or removed. */
export function useProjectTeamChats(projectId: string): TeamChatSummary[] {
  return useProjectsTeamChats([projectId]);
}

/** Workspace-scoped counterpart, also used by Easy Mode's combined feed. */
export function useProjectsTeamChats(projectIds: string[]): TeamChatSummary[] {
  return useProjectsTeamChatsState(projectIds).chats;
}

export interface TeamChatsState {
  chats: TeamChatSummary[];
  /** Why the last read failed. Unreadable storage is never shown as an empty list. */
  error?: string;
  retry: () => void;
}

/**
 * The project's team chats plus any storage error. A failed read keeps the last list it had and
 * reports the error: main refuses to load a malformed team-chats.json rather than replace it,
 * and an empty sidebar would hide that.
 */
export function useProjectsTeamChatsState(projectIds: string[]): TeamChatsState {
  const key = JSON.stringify([...new Set(projectIds)].sort());
  const [result, setResult] = useState<{ key: string; chats: TeamChatSummary[]; error?: string }>({ key, chats: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      const ids = JSON.parse(key) as string[];
      try {
        const groups = await Promise.all(ids.map(id => window.praxis.assistant.listChats(id)));
        if (!disposed && current === revision) setResult({ key, chats: groups.flat() });
      } catch (error) {
        if (disposed || current !== revision) return;
        // Electron prefixes the channel name; the storage error that follows is what matters.
        const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': /, '');
        setResult(previous => ({ key, chats: previous.key === key ? previous.chats : [], error: message }));
      }
    };
    const unsubscribe = window.praxis.assistant.onChatsChanged(() => { void refresh(); });
    void refresh();
    return () => { disposed = true; unsubscribe(); };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return result.key === key ? { chats: result.chats, error: result.error, retry } : { chats: [], retry };
}

/** Shown in place of a silently empty team-chat list when storage cannot be read. */
export function TeamChatStorageAlert({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="team-chat-storage-error" role="alert" data-testid="team-chat-storage-error">
      <span className="team-chat-storage-error__lead" aria-hidden="true"><Icon name="warning" size={14} /></span>
      <span className="team-chat-storage-error__body">
        <span className="team-chat-storage-error__title">Team chats can't be read. The file was left unchanged.</span>
        <span className="team-chat-storage-error__detail" title={error}>{error}</span>
      </span>
      <button type="button" className="btn btn-sm team-chat-storage-error__retry" data-testid="team-chat-storage-retry" onClick={onRetry}>Retry</button>
    </div>
  );
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
