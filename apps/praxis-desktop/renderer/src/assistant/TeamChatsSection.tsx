import { useCallback, useEffect, useState } from 'react';
import type { TeamChatSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { useAssistant } from './AssistantProvider';
import { personaMeta } from './personaMeta';

interface TeamChatsSectionProps {
  projectId: string;
  projectName: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** A project's persisted team conversations — kept apart from autonomous Sessions. */
export function TeamChatsSection({ projectId, projectName, collapsed, onToggle }: TeamChatsSectionProps) {
  const assistant = useAssistant();
  const { confirm, prompt } = useDialogs();
  const [chats, setChats] = useState<TeamChatSummary[]>([]);

  const refresh = useCallback(() => {
    void window.praxis.assistant.listChats(projectId).then(setChats).catch(() => setChats([]));
  }, [projectId]);
  useEffect(() => {
    refresh();
    return window.praxis.assistant.onChatsChanged(refresh);
  }, [refresh]);

  const startNew = () => {
    assistant.setProjectId(projectId);
    assistant.newChat();
    assistant.setOpen(true);
  };
  const open = (chat: TeamChatSummary) => {
    assistant.setProjectId(projectId);
    void assistant.loadChat(chat.id);
  };
  const rename = async (chat: TeamChatSummary) => {
    const title = await prompt({ title: 'Rename team chat', label: 'Name', initialValue: chat.title, validate: value => (value.trim() ? undefined : 'A chat needs a name.') });
    if (title) await window.praxis.assistant.renameChat(chat.id, title);
  };
  const remove = async (chat: TeamChatSummary) => {
    if (!(await confirm({ title: 'Delete team chat?', message: `"${chat.title}" will be removed permanently.`, confirmLabel: 'Delete', danger: true }))) return;
    await window.praxis.assistant.deleteChat(chat.id);
    assistant.chatDeleted(chat.id);
  };

  return (
    <div className="project-sidebar-section" data-testid="team-chats-section">
      <div className="feature-section-header feature-section-toggle project-team-chats-header">
        <button type="button" className="feature-section-title" aria-expanded={!collapsed} data-testid="project-team-chats-nav-item" onClick={onToggle}>
          <span className="sidebar-section-label" style={{ margin: 0 }}>Team Chats</span>
          {chats.length > 0 && <span className="tree-meta" data-testid="team-chats-count">{chats.length}</span>}
        </button>
        <div className="feature-section-actions">
          <button type="button" className="feature-section-action" data-testid="team-chat-new" aria-label={`New team chat in ${projectName}`} onClick={startNew}>
            <Icon name="plus" size={13} />
          </button>
          <button type="button" className="feature-section-action" aria-label={collapsed ? 'Expand team chats' : 'Collapse team chats'} onClick={onToggle}>
            <span className={`tree-section-icon${collapsed ? '' : ' open'}`}><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} /></span>
          </button>
        </div>
      </div>
      {!collapsed && (chats.length === 0 ? (
        <div className="project-session-empty"><span>No team chats yet</span></div>
      ) : chats.map(chat => (
        <div key={chat.id} className={`team-chat-row${assistant.chatId === chat.id ? ' active' : ''}`} data-testid="team-chat-row">
          <button type="button" className="team-chat-main" title={chat.title} onClick={() => open(chat)} onDoubleClick={() => void rename(chat)}>
            <span className="tree-icon"><Icon name="chats" size={14} /></span>
            <span className="tree-label">{chat.title}</span>
            {chat.issueKey && <span className="team-chat-issue">{chat.issueKey}</span>}
            <span className="team-chat-personas" aria-hidden="true">
              {chat.personas.map(role => <span key={role} className={`team-chat-dot persona-badge--${role}`} title={personaMeta(role).name} />)}
            </span>
          </button>
          <button type="button" className="icon-btn icon-btn-sm team-chat-delete" aria-label={`Delete team chat ${chat.title}`} onClick={() => void remove(chat)}>
            <Icon name="trash" size={12} />
          </button>
        </div>
      )))}
    </div>
  );
}
