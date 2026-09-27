import React from 'react';
import type { AgentSessionRecord, AgentTaskState } from '@praxis/core';
import { Icon, type IconName } from '../../ui/Icon';
import { sessionTitle, extractSubagents, formatStarted, type SubagentItem } from '../../ai/sessionNav';

export interface EasyModeSessionCardProps {
  session: AgentSessionRecord;
  allSessions?: AgentSessionRecord[];
  isSelected: boolean;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
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
  onSelectAgent
}: EasyModeSessionCardProps) {
  const title = sessionTitle(session);
  const timeFormatted = session.startedAt ? formatStarted(session.startedAt) : '';

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

  const handleCardClick = (e: React.MouseEvent) => {
    onSelectSession(session.issueKey);
  };

  const handleAgentClick = (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectSession(session.issueKey);
    if (onSelectAgent) {
      onSelectAgent(session.issueKey, agentId);
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
      </div>

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
