import React, { useState } from 'react';
import type { AgentSessionRecord, AgentTaskState } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { sessionTitle, extractSubagents, formatStarted } from '../../ai/sessionNav';

export interface EasyModeSessionCardProps {
  session: AgentSessionRecord;
  allSessions?: AgentSessionRecord[];
  isSelected: boolean;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
  onAbortSession?: (sessionKey: string) => void;
  onDeleteSession?: (sessionKey: string) => void;
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
  onDeleteSession
}: EasyModeSessionCardProps) {
  const [isBusy, setIsBusy] = useState(false);
  const title = sessionTitle(session);
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
    onSelectSession(session.issueKey);
    if (onSelectAgent) {
      onSelectAgent(session.issueKey, agentId);
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

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isBusy) return;
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
        <Icon name="robot" size={14} />
        <span className="easymode-session-card__title" title={title}>
          {title}
        </span>
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

      {tickerText && (
        <div className="easymode-session-card__ticker" title={tickerText}>
          <span className="easymode-ticker-dot" />
          <span className="easymode-ticker-text">{tickerText}</span>
        </div>
      )}

      {/* Agents / Subagents list owned by this session */}
      <div className="easymode-subagents-list" data-testid={`easymode-subagents-${session.issueKey}`}>
        {agentItems.map(agent => {
          const statusClass = resolveAgentStatusClass(agent.status);
          const statusLabel = resolveAgentStatusLabel(agent.status);
          const isActive = activeAgentId === agent.id;
          const isPrimary = agent.id === session.issueKey;

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
    </div>
  );
}
