import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { agentStateLabel, isTerminalAgentState } from '../../ai/aiSessionState';
import {
  extractSubagents,
  formatElapsed,
  sessionTitle,
  type SubagentItem
} from '../../ai/sessionNav';
import { providerLabel } from '../../ai/modelProviders';
import { AgentActivityFeed } from './AgentActivityFeed';
import { SessionTicketCard } from './SessionTicketCard';
import { SessionComposer } from '../../ai/SessionComposer';

export interface AgentDetailsPageProps {
  sessionKey?: string;
  agentId?: string;
  sessions: AgentSessionRecord[];
  onClose: () => void;
  onSelectSession: (sessionKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId?: string) => void;
}

export function AgentDetailsPage({
  sessionKey,
  agentId,
  sessions,
  onClose,
  onSelectSession,
  onSelectAgent
}: AgentDetailsPageProps) {
  const [stopping, setStopping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // 1. Locate parent session
  const parentSession = useMemo(() => {
    if (sessionKey) {
      const found = sessions.find(s => s.issueKey === sessionKey);
      if (found) return found;
    }
    if (agentId) {
      const direct = sessions.find(s => s.issueKey === agentId);
      if (direct) {
        if (direct.parentSessionKey) {
          const parent = sessions.find(s => s.issueKey === direct.parentSessionKey);
          if (parent) return parent;
        }
        return direct;
      }
    }
    return sessions[0];
  }, [sessionKey, agentId, sessions]);

  // 2. Extract subagents of parent
  const allSubagents = useMemo(() => {
    if (!parentSession) return [];
    return extractSubagents(parentSession, sessions);
  }, [parentSession, sessions]);

  // 3. Resolve target agent details
  const isPrimary = !agentId || !parentSession || agentId === parentSession.issueKey || agentId === 'primary';

  const childSession = useMemo(() => {
    if (isPrimary || !agentId) return undefined;
    return sessions.find(s => s.issueKey === agentId);
  }, [isPrimary, agentId, sessions]);

  const matchedSubagent: SubagentItem | undefined = useMemo(() => {
    if (isPrimary || !agentId) return undefined;
    return allSubagents.find(s => s.id === agentId || s.sessionKey === agentId);
  }, [isPrimary, agentId, allSubagents]);

  // Follow the conversation like the classic chat: stick to the latest message
  // until the user scrolls up, and resume once they return near the bottom.
  const followTarget = childSession || parentSession;
  const followKey = `${followTarget?.issueKey ?? ''}:${agentId ?? ''}`;
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    followRef.current = true;
    const onScroll = () => {
      followRef.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 64;
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    // Markdown, gadgets, the ticket card and the composer dock below all settle
    // after React commits, so keep following while any of those heights change.
    const resizeObserver = new ResizeObserver(() => {
      if (followRef.current) node.scrollTop = node.scrollHeight;
    });
    resizeObserver.observe(node);
    Array.from(node.children).forEach(child => resizeObserver.observe(child));
    return () => {
      node.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
    };
  }, [followKey, parentSession]);

  const eventCount = followTarget?.events?.length ?? 0;
  useLayoutEffect(() => {
    if (!followRef.current) return;
    const scrollToLatest = () => {
      const node = bodyRef.current;
      if (node && followRef.current) node.scrollTop = node.scrollHeight;
    };
    scrollToLatest();
    const frame = window.requestAnimationFrame(scrollToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [followKey, eventCount, followTarget?.reasoningText]);

  if (!parentSession) {
    return (
      <div className="agent-details-page is-empty" data-testid="agent-details-empty">
        <div className="empty-state">
          <Icon name="robot" size={32} />
          <strong>No agent session selected</strong>
          <p>Select a session or agent from the sidebar to inspect its activity.</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Back to Sessions
          </button>
        </div>
      </div>
    );
  }

  const targetSession = childSession || parentSession;
  const agentTitle = isPrimary
    ? sessionTitle(parentSession)
    : childSession
      ? sessionTitle(childSession)
      : matchedSubagent?.title || 'Subagent';

  const agentRole = isPrimary
    ? parentSession.workflowNodeId
      ? `Stage: ${parentSession.workflowNodeId}`
      : parentSession.workflowRole
        ? `Role: ${parentSession.workflowRole}`
        : 'Primary Agent'
    : childSession?.workflowNodeId
      ? `Stage: ${childSession.workflowNodeId}`
      : childSession?.workflowRole
        ? `Role: ${childSession.workflowRole}`
        : matchedSubagent?.role || 'Subagent';

  const status = isPrimary
    ? parentSession.state
    : childSession
      ? childSession.state
      : matchedSubagent?.status || 'executing';

  const model = isPrimary
    ? parentSession.model || (parentSession.provider ? providerLabel(parentSession.provider) : 'Default model')
    : childSession
      ? childSession.model || (childSession.provider ? providerLabel(childSession.provider) : 'Default model')
      : matchedSubagent?.model || 'Default model';

  const startedAt = isPrimary
    ? parentSession.startedAt
    : childSession
      ? childSession.startedAt
      : matchedSubagent?.startedAt;

  const completedAt = isPrimary
    ? parentSession.completedAt
    : childSession
      ? childSession.completedAt
      : matchedSubagent?.completedAt;

  const elapsed = startedAt ? formatElapsed(startedAt, completedAt) : undefined;
  const isExecuting = !isTerminalAgentState(status);

  const handleAbort = async () => {
    setStopping(true);
    try {
      await window.praxis.ai.abort(targetSession.issueKey);
    } catch {
      // ignore abort error
    } finally {
      setStopping(false);
    }
  };

  const handleSelectSub = (subId?: string) => {
    if (onSelectAgent) {
      onSelectAgent(parentSession.issueKey, subId);
    }
  };

  return (
    <div className="agent-details-page" data-testid="agent-details-page">
      {/* Top Header Bar */}
      <header className="agent-details-header" data-testid="agent-details-header">
        <div className="agent-details-header__left">
          <button
            type="button"
            className="btn btn-ghost btn-icon agent-details-back-btn"
            data-testid="agent-details-back-btn"
            onClick={onClose}
            aria-label="Back"
            title="Back to Sessions"
          >
            <Icon name="arrow-left" size={16} />
          </button>

          <nav className="agent-details-breadcrumbs" aria-label="Breadcrumb">
            <button
              type="button"
              className="agent-details-breadcrumb-session"
              data-testid="agent-details-session-link"
              onClick={isPrimary ? onClose : () => onSelectSession(parentSession.issueKey)}
              title={isPrimary ? 'Back to Sessions' : `View Session ${parentSession.issueKey}`}
            >
              {isPrimary ? 'Sessions' : parentSession.issueKey}
            </button>
            <span className="agent-details-breadcrumb-sep" aria-hidden="true">/</span>
            <span className="agent-details-breadcrumb-current" data-testid="agent-details-title">
              {agentTitle}
            </span>
          </nav>

          {(allSubagents.length > 0 || !isPrimary || Boolean(parentSession.workflowRole)) && (
            <span
              className={`chip agent-details-role-badge ${isPrimary ? 'chip-accent' : 'chip-muted'}`}
              data-testid="agent-details-role-badge"
            >
              {agentRole}
            </span>
          )}
        </div>

        <div className="agent-details-header__right">
          {/* Status Indicator */}
          <div className="agent-details-status" data-testid="agent-details-status">
            <span
              className={`easymode-status-dot is-${status === 'executing' ? 'running' : status === 'failed' ? 'failed' : 'complete'}`}
              aria-hidden="true"
            />
            <span className="agent-details-status-text">{agentStateLabel(status)}</span>
          </div>

          {/* Telemetry */}
          {elapsed && (
            <span className="chip chip-muted agent-details-metric" data-testid="agent-details-duration">
              <Icon name="clock" size={12} />
              <span>{elapsed}</span>
            </span>
          )}

          {model && (
            <span className="chip chip-muted agent-details-metric" data-testid="agent-details-model">
              <Icon name="robot" size={12} />
              <span>{model}</span>
            </span>
          )}

          {/* Abort Action */}
          {isExecuting && (
            <button
              type="button"
              className="btn btn-sm btn-danger agent-details-stop-btn"
              data-testid="agent-details-stop-btn"
              disabled={stopping}
              onClick={() => void handleAbort()}
              title="Stop agent execution"
            >
              <Icon name="close" size={12} />
              <span>{stopping ? 'Stopping…' : 'Stop'}</span>
            </button>
          )}
        </div>
      </header>

      {/* Subagents Switcher Bar (if session has subagents) */}
      {allSubagents.length > 0 && onSelectAgent && (
        <div className="agent-details-subagents-bar" data-testid="agent-details-subagents-bar">
          <span className="agent-details-subagents-bar__label">Agents in session:</span>
          <button
            type="button"
            className={`btn btn-sm ${isPrimary ? 'btn-primary' : 'btn-ghost'}`}
            data-testid="subagent-nav-primary"
            onClick={() => handleSelectSub(parentSession.issueKey)}
          >
            <span className={`easymode-status-dot is-${parentSession.state === 'executing' ? 'running' : parentSession.state === 'failed' ? 'failed' : 'complete'}`} />
            <span>Primary Agent</span>
          </button>
          {allSubagents.map(sub => {
            const isSubSelected = !isPrimary && (agentId === sub.id || agentId === sub.sessionKey);
            return (
              <button
                key={sub.id}
                type="button"
                className={`btn btn-sm ${isSubSelected ? 'btn-primary' : 'btn-ghost'}`}
                data-testid={`subagent-nav-${sub.id}`}
                onClick={() => handleSelectSub(sub.sessionKey || sub.id)}
              >
                <span className={`easymode-status-dot is-${sub.status === 'executing' ? 'running' : sub.status === 'failed' ? 'failed' : 'complete'}`} />
                <span>{sub.title}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Content Area */}
      <div className="agent-details-body" data-testid="agent-details-body" ref={bodyRef}>
        {/* Ticket Details Card */}
        <SessionTicketCard session={targetSession} />

        {/* Feed Content */}
        <AgentActivityFeed
          session={targetSession}
          subagentId={isPrimary ? undefined : (agentId || undefined)}
          viewMode="conversation"
          onSelectSession={onSelectSession}
          isExecuting={isExecuting}
        />
      </div>

      {/* Standard Session Composer */}
      <div className="agent-details-composer-dock" data-testid="agent-details-composer-dock">
        <SessionComposer
          key={targetSession.issueKey}
          session={targetSession}
          sessions={sessions}
          // Workflows belong to automations in easy mode, so the session composer has no workflow chip.
          options={{ showWorkflowControl: false }}
        />
      </div>
    </div>
  );
}
