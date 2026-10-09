import React, { useState } from 'react';
import type { AgentSessionRecord, AgentTaskState } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { useDialogs } from '../../ui/dialogs';
import { sessionTitle, extractSubagents, formatStarted, extractSessionAiProviders } from '../../ai/sessionNav';
import { SessionAiIcons } from '../../ai/SessionAiIcons';

export interface EasyModeSessionCardProps {
  session: AgentSessionRecord;
  allSessions?: AgentSessionRecord[];
  isSelected: boolean;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
  onAbortSession?: (sessionKey: string) => void;
  onDeleteSession?: (sessionKey: string) => void;
  onRenameSession?: (sessionKey: string, title: string) => Promise<void>;
  onArchiveSession?: (sessionKey: string, archived: boolean) => Promise<void>;
  onAssignSession?: (session: AgentSessionRecord) => void;
}

function resolveAgentStatusClass(state: AgentTaskState): string {
  if (state === 'failed' || state === 'aborted') {
    return 'easymode-status--failed';
  }
  if (state === 'completed') {
    return 'easymode-status--success';
  }
  if (state === 'executing' || state === 'planning' || state === 'awaiting_approval' || state === 'awaiting_input') {
    return 'easymode-status--running';
  }
  return 'easymode-status--idle';
}

function resolveAgentStatusLabel(state: AgentTaskState): string {
  if (state === 'failed' || state === 'aborted') return 'Failed';
  if (state === 'completed') return 'Completed';
  if (state === 'executing' || state === 'planning') return 'In progress';
  return 'Idle';
}

export function EasyModeSessionCard({
  session,
  allSessions,
  isSelected,
  activeAgentId,
  onSelectSession,
  onSelectAgent,
  onAbortSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  onAssignSession
}: EasyModeSessionCardProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const { confirmChoice } = useDialogs();
  const title = sessionTitle(session);
  const [draft, setDraft] = useState(title);
  const timeFormatted = session.startedAt ? formatStarted(session.startedAt) : '';

  const isRunning = session.state === 'executing' || session.state === 'planning' || session.state === 'awaiting_approval' || session.state === 'awaiting_input';
  const latestEvent = session.events && session.events.length > 0 ? session.events[session.events.length - 1] : undefined;
  const tickerText = isRunning
    ? (latestEvent?.summary || (session.state === 'planning' ? 'Planning next steps…' : 'Agent working…'))
    : null;

  // Extract subagents using sessionNav helper
  const subagents = React.useMemo(() => {
    return extractSubagents(session, allSessions);
  }, [session, allSessions]);

  const childSessions = React.useMemo(() => {
    return (allSessions ?? []).filter(s => s && s.parentSessionKey === session.issueKey);
  }, [allSessions, session.issueKey]);

  const providers = React.useMemo(() => {
    return extractSessionAiProviders(session, childSessions);
  }, [session, childSessions]);

  // Primary agent item followed by all subagents
  const agentItems: Array<{ id: string; title: string; role: string; status: AgentTaskState; meta?: string }> = React.useMemo(() => {
    const items: Array<{ id: string; title: string; role: string; status: AgentTaskState; meta?: string }> = [
      {
        id: session.issueKey,
        title: title || 'Primary Agent',
        role: 'Primary Agent',
        status: session.state,
        meta: session.model || undefined
      }
    ];
    if (subagents.length > 0) {
      for (const sub of subagents) {
        items.push({
          id: sub.id,
          title: sub.title,
          role: sub.role || 'Subagent',
          status: sub.status,
          meta: sub.elapsed || sub.model
        });
      }
    }
    return items;
  }, [subagents, session, title]);

  const handleCardClick = () => {
    onSelectSession(session.issueKey);
  };

  const handleAgentClick = (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSelectAgent) {
      onSelectAgent(session.issueKey, agentId);
    } else {
      onSelectSession(session.issueKey);
    }
  };

  const handleAbort = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBusy) return;
    setIsBusy(true);
    try {
      if (onAbortSession) {
        onAbortSession(session.issueKey);
      } else if (window.praxis?.ai?.abort) {
        await window.praxis.ai.abort(session.issueKey);
      }
    } catch {
      // ignore abort error
    } finally {
      setIsBusy(false);
    }
  };

  const commitRename = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) return;
    setIsBusy(true);
    try {
      if (onRenameSession) {
        await onRenameSession(session.issueKey, next);
      } else if (window.praxis?.ai?.renameSession) {
        await window.praxis.ai.renameSession(session.issueKey, next);
      }
    } catch {
      // ignore rename error
    } finally {
      setIsBusy(false);
    }
  };

  const archive = async () => {
    setIsBusy(true);
    try {
      if (onArchiveSession) {
        await onArchiveSession(session.issueKey, true);
      } else if (window.praxis?.ai?.archiveSession) {
        await window.praxis.ai.archiveSession(session.issueKey, true);
      }
    } catch {
      // ignore archive error
    } finally {
      setIsBusy(false);
    }
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBusy) return;
    await archive();
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBusy) return;
    const choice = await confirmChoice({
      title: 'Delete this session?',
      message: 'This can’t be undone.',
      confirmLabel: 'Delete',
      tertiaryLabel: 'Archive',
      danger: true
    });
    if (choice === 'cancel') return;
    if (choice === 'tertiary') {
      await archive();
      return;
    }
    setIsBusy(true);
    try {
      if (onDeleteSession) {
        onDeleteSession(session.issueKey);
      } else if (window.praxis?.ai?.deleteSession) {
        await window.praxis.ai.deleteSession(session.issueKey);
      }
    } catch {
      // ignore delete error
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className={`easymode-session-card ${isSelected ? 'is-selected' : ''}`}
      data-testid={`easymode-session-card-${session.issueKey}`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectSession(session.issueKey);
        }
      }}
    >
      <div className="easymode-session-card__head">
        {isRunning ? (
          <span className="harmonic-pulse-glyph" aria-hidden="true" />
        ) : session.state === 'completed' ? (
          <Icon name="check" size={13} className="completed-glyph" />
        ) : session.state === 'failed' || session.state === 'aborted' ? (
          <Icon name="warning" size={13} className="failed-glyph" />
        ) : providers.length === 0 ? (
          <Icon name="robot" size={13} />
        ) : null}
        {providers.length > 0 && (
          <SessionAiIcons providers={providers} size={14} className="easymode-session-ai-icons" />
        )}
        {editing ? (
          <input
            className="session-title-input"
            data-testid={`easymode-session-title-input-${session.issueKey}`}
            aria-label={`Session title for ${title}`}
            value={draft}
            disabled={isBusy}
            autoFocus
            onClick={e => e.stopPropagation()}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="easymode-session-card__title" title={title}>
            {title}
          </span>
        )}
        {timeFormatted && (
          <span className="easymode-session-card__time">
            {timeFormatted}
          </span>
        )}
        <div className="easymode-card-actions">
          {isRunning && (
            <button
              type="button"
              className="easymode-card-action-btn easymode-card-action-btn--abort"
              title="Stop running agent"
              aria-label="Stop running agent"
              data-testid={`easymode-session-abort-${session.issueKey}`}
              onClick={handleAbort}
              disabled={isBusy}
            >
              <Icon name="close" size={11} />
            </button>
          )}
          <button
            type="button"
            className="easymode-card-action-btn"
            title="Assign to ticket"
            aria-label="Assign to ticket"
            data-testid={`easymode-session-assign-${session.issueKey}`}
            onClick={e => {
              e.stopPropagation();
              onAssignSession?.(session);
            }}
            disabled={isBusy}
          >
            <Icon name="ticket" size={11} />
          </button>
          <button
            type="button"
            className="easymode-card-action-btn"
            title="Rename session"
            aria-label="Rename session"
            data-testid={`easymode-session-rename-${session.issueKey}`}
            onClick={e => {
              e.stopPropagation();
              setDraft(title);
              setEditing(true);
            }}
            disabled={isBusy}
          >
            <Icon name="pencil" size={11} />
          </button>
          <button
            type="button"
            className="easymode-card-action-btn"
            title="Archive session"
            aria-label="Archive session"
            data-testid={`easymode-session-archive-${session.issueKey}`}
            onClick={handleArchive}
            disabled={isBusy}
          >
            <Icon name="archive" size={11} />
          </button>
          <button
            type="button"
            className="easymode-card-action-btn easymode-card-action-btn--delete"
            title="Delete session"
            aria-label="Delete session"
            data-testid={`easymode-session-delete-${session.issueKey}`}
            onClick={handleDelete}
            disabled={isBusy}
          >
            <Icon name="trash" size={11} />
          </button>
        </div>
      </div>

      {(session.state === 'awaiting_approval' || session.state === 'awaiting_input') && (
        <div className="action-gate-callout" data-testid={`easymode-session-gate-${session.issueKey}`}>
          <Icon name="warning" size={12} />
          <span>Action Gate: {session.state === 'awaiting_approval' ? 'Approval required' : 'Input required'}</span>
        </div>
      )}

      {tickerText && (
        <div className="easymode-session-card__ticker" title={tickerText}>
          <span className="easymode-ticker-dot" />
          <span className="easymode-ticker-text">{tickerText}</span>
        </div>
      )}

      {/* A lone agent repeats the card title, so only show the tree once there are subagents under it. */}
      {agentItems.length === 1 && session.model && (
        <div className="easymode-session-card__meta" data-testid={`easymode-session-model-${session.issueKey}`}>
          {session.model}
        </div>
      )}

      {agentItems.length > 1 && (
      <div className="easymode-subagents-list" data-testid={`easymode-subagents-${session.issueKey}`}>
        {agentItems.map((agent, index) => {
          const statusClass = resolveAgentStatusClass(agent.status);
          const statusLabel = resolveAgentStatusLabel(agent.status);
          const isActive = activeAgentId === agent.id;
          const isPrimary = agent.id === session.issueKey;
          const branchSym = agentItems.length > 1 ? (index === agentItems.length - 1 ? '└─' : '├─') : null;

          return (
            <div
              key={agent.id}
              className={`easymode-agent-row ${isActive ? 'is-active' : ''}`}
              data-testid={isPrimary ? `easymode-agent-${agent.id}` : `easymode-subagent-${agent.id}`}
              onClick={e => handleAgentClick(agent.id, e)}
              role="button"
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleAgentClick(agent.id, e as unknown as React.MouseEvent);
                }
              }}
            >
              {branchSym && <span className="lineage-sym" aria-hidden="true">{branchSym}</span>}
              <span
                className={`easymode-status ${statusClass}`}
                aria-label={`Status: ${statusLabel}`}
                title={statusLabel}
              />
              <span className="easymode-agent-row__title" title={agent.title}>
                {agent.title}
              </span>
              {agent.meta && (
                <span className="easymode-agent-row__meta">
                  {agent.meta}
                </span>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
