import { useEffect, useRef, useState } from 'react';
import type { AgentSessionRecord, AiProviderStatus } from '@ticket-manager/core';
import { Icon } from './Icon';
import {
  agentEventIcon,
  agentEventToneClass,
  agentStateBadgeClass,
  agentStateLabel,
  isTerminalAgentState
} from './aiSessionState';

export interface SessionsPageProps {
  /** All known agent sessions, most recent first. Live-updated by the App-level push subscription. */
  sessions: AgentSessionRecord[];
  selectedKey: string | undefined;
  onSelect: (issueKey: string) => void;
  onNewSession: () => void;
  onOpenAiSettings: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}

/**
 * The Sessions feature: every AI agent session the desktop app has run, newest
 * first, with a console for the selected one. The list is fed from the main
 * process (`ai:listSessions` + the `ai:sessionChanged` push channel subscribed
 * in App), so state transitions and streamed events render live.
 */
export function SessionsPage({
  sessions,
  selectedKey,
  onSelect,
  onNewSession,
  onOpenAiSettings
}: SessionsPageProps) {
  const [status, setStatus] = useState<AiProviderStatus | undefined>();
  const eventsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ticketManager.ai
      .getStatus()
      .then(next => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = sessions.find(session => session.issueKey === selectedKey) ?? sessions[0];
  const selectedEventCount = selected?.events.length ?? 0;

  // Follow the stream: whenever the selected session gains events, pin the
  // console to the latest one (the list replaces the record object on every
  // push, so the count is the reliable change signal).
  useEffect(() => {
    const node = eventsRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [selected?.issueKey, selectedEventCount]);

  return (
    <div className="sessions-layout" data-testid="sessions-view">
      <div className="sessions-list">
        <div className="sessions-list-header">
          <span className="sessions-list-title">Sessions</span>
          <button className="btn" onClick={onNewSession} data-testid="sessions-new-btn">
            <Icon name="plus" size={13} />
            New session
          </button>
        </div>
        <div className="sessions-list-scroll">
          {sessions.length === 0 && (
            <div className="empty-state" data-testid="sessions-empty" style={{ minHeight: 200 }}>
              <Icon name="robot" size={28} />
              <span>No AI sessions yet.</span>
              {status && !status.configured && (
                <>
                  <span className="placeholder-text" style={{ textAlign: 'center' }}>
                    Set up the Vercel AI Gateway to delegate issues to an agent.
                  </span>
                  <button className="btn" onClick={onOpenAiSettings} data-testid="sessions-open-ai-settings">
                    Open AI Provider settings
                  </button>
                </>
              )}
            </div>
          )}
          {sessions.map(session => (
            <button
              key={session.issueKey}
              className={`session-item${selected?.issueKey === session.issueKey ? ' active' : ''}`}
              data-testid="session-list-row"
              onClick={() => onSelect(session.issueKey)}
            >
              <span className="session-item-top">
                <span className="session-item-key">{session.issueKey}</span>
                <span className={agentStateBadgeClass(session.state)}>
                  {agentStateLabel(session.state)}
                </span>
              </span>
              <span className="session-item-goal" title={session.taskDefinition.goal}>
                {session.taskDefinition.goal.split('\n')[0]}
              </span>
              <span className="session-item-meta">
                {formatStarted(session.startedAt)} · {session.stepCount}{' '}
                {session.stepCount === 1 ? 'step' : 'steps'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="session-console" data-testid="session-console">
        {!selected && (
          <div className="empty-state" style={{ flex: 1 }}>
            <Icon name="terminal" size={28} />
            <span>Select a session to see its console.</span>
          </div>
        )}
        {selected && (
          <>
            <div className="session-console-header">
              <Icon name="robot" size={14} />
              <span className="session-console-title" title={selected.taskDefinition.goal}>
                {selected.issueKey} — {selected.taskDefinition.goal.split('\n')[0]}
              </span>
              <span className={agentStateBadgeClass(selected.state)} data-testid="session-state-badge">
                {agentStateLabel(selected.state)}
              </span>
              <span className="session-item-meta">{selected.stepCount} steps</span>
              {!isTerminalAgentState(selected.state) && (
                <button
                  className="btn"
                  data-testid="session-abort-btn"
                  onClick={() => void window.ticketManager.ai.abort(selected.issueKey)}
                >
                  <Icon name="close" size={13} />
                  Abort
                </button>
              )}
            </div>

            <div className="session-events" ref={eventsRef} data-testid="session-events">
              {selected.events.length === 0 && (
                <span className="placeholder-text">Waiting for the agent to start…</span>
              )}
              {selected.events.map((event, index) => (
                <div className="event-row" key={`${event.timestamp}-${index}`} data-testid="session-event-row">
                  <span className="event-time">{formatTime(event.timestamp)}</span>
                  <span className={agentEventToneClass(event.type)}>
                    <Icon name={agentEventIcon(event.type)} size={13} />
                  </span>
                  <span className="event-body">
                    <span className="event-summary">{event.summary}</span>
                    {event.detail && <div className="event-detail">{event.detail}</div>}
                  </span>
                </div>
              ))}
            </div>

            {selected.responseText && (
              <div className="session-plan" data-testid="session-response">
                <div className="detail-section-label">Final response</div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{selected.responseText}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
