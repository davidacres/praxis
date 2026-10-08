import React, { useState, useMemo } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { EasyModeSessionCard } from './EasyModeSessionCard';
import { Icon } from '../../ui/Icon';

export interface EasyModeSessionsListProps {
  sessions: AgentSessionRecord[];
  allSessions?: AgentSessionRecord[];
  selectedSessionKey?: string;
  activeAgentId?: string;
  filterTab?: 'all' | 'live' | 'gates';
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
  onNewSession?: () => void;
  onAbortSession?: (sessionKey: string) => void;
  onDeleteSession?: (sessionKey: string) => void;
  onRenameSession?: (sessionKey: string, title: string) => Promise<void>;
  onArchiveSession?: (sessionKey: string, archived: boolean) => Promise<void>;
}

export function EasyModeSessionsList({
  sessions,
  allSessions,
  selectedSessionKey,
  activeAgentId,
  filterTab,
  onSelectSession,
  onSelectAgent,
  onNewSession,
  onAbortSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession
}: EasyModeSessionsListProps) {
  const [filterQuery, setFilterQuery] = useState('');

  // Only display user root sessions at top level; subagents appear inside their parent session's card,
  // and automation stage sessions appear under their respective automation.
  const rootSessions = useMemo(() => {
    let list = sessions.filter(s => !s.parentSessionKey && !s.workflowRunId);
    if (filterTab === 'live') {
      list = list.filter(s => s.state === 'executing' || s.state === 'planning' || s.state === 'awaiting_approval' || s.state === 'awaiting_input');
    } else if (filterTab === 'gates') {
      list = list.filter(s => s.state === 'awaiting_approval' || s.state === 'awaiting_input');
    }
    return list;
  }, [sessions, filterTab]);

  const filteredSessions = useMemo(() => {
    if (!filterQuery.trim()) return rootSessions;
    const q = filterQuery.toLowerCase().trim();
    return rootSessions.filter(s => {
      const title = (s.title || s.issueKey).toLowerCase();
      const model = (s.model || '').toLowerCase();
      return title.includes(q) || model.includes(q);
    });
  }, [rootSessions, filterQuery]);

  if (rootSessions.length === 0) {
    return (
      <div className="easymode-empty-card" data-testid="easymode-sessions-empty-card">
        <div className="easymode-empty-card__icon">
          <Icon name="feather" size={20} />
        </div>
        <div className="easymode-empty-card__content">
          <span className="easymode-empty-card__title">No active sessions</span>
          <p className="easymode-empty-card__desc">Launch an AI agent to investigate, code, or debug in this folder.</p>
        </div>
        {onNewSession && (
          <button
            type="button"
            className="btn btn-secondary btn-sm easymode-empty-card__btn"
            onClick={onNewSession}
            data-testid="easymode-empty-new-session"
          >
            <Icon name="plus" size={13} />
            Start a session
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="easymode-sessions-list" data-testid="easymode-sessions-list">
      {rootSessions.length >= 3 && (
        <div className="easymode-search-bar">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="easymode-search-bar__input"
            placeholder="Filter sessions..."
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
            data-testid="easymode-sessions-filter"
            aria-label="Filter sessions"
          />
          {filterQuery && (
            <button
              type="button"
              className="easymode-search-bar__clear"
              onClick={() => setFilterQuery('')}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
      )}

      {filteredSessions.map(session => (
        <EasyModeSessionCard
          key={session.issueKey}
          session={session}
          allSessions={allSessions || sessions}
          isSelected={selectedSessionKey === session.issueKey}
          activeAgentId={activeAgentId}
          onSelectSession={onSelectSession}
          onSelectAgent={onSelectAgent}
          onAbortSession={onAbortSession}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
          onArchiveSession={onArchiveSession}
        />
      ))}

      {filteredSessions.length === 0 && filterQuery && (
        <div className="easymode-empty-hint">No sessions match &quot;{filterQuery}&quot;</div>
      )}
    </div>
  );
}
