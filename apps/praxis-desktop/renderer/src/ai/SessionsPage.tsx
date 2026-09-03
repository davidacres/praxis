import { useEffect, useRef, useState } from 'react';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AiAnalysisState,
  AiProviderStatus,
  PermissionDecision,
  TerminalSessionInfo
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { agentEventIcon, agentEventToneClass, isTerminalAgentState } from './aiSessionState';
import { useSettings } from '../settings/useSettings';
import { BrowserPane } from '../browser/BrowserPane';
import { getActiveTerminalId, onActiveTerminalChanged } from './terminalSelection';
import { sessionLabel, sessionTitle } from './sessionNav';
import { resolveToolView, toolArgsLabel, ToolDiff, ToolTerminal } from './toolEventView';

export interface SessionsPageProps {
  /** All known agent sessions, most recent first. Live-updated by the App-level push subscription. */
  sessions: AgentSessionRecord[];
  selectedKey: string | undefined;
  onNewSession: () => void;
  onOpenAiSettings: () => void;
  initialBrowserOpen?: boolean;
  initialBrowserUrl?: string;
  onBrowserOpenChange?: (open: boolean) => void;
  onBrowserUrlChange?: (url: string) => void;
  browserSuspended?: boolean;
}

/** Per-session override of the profile-wide "Plain chat background" setting.
 *  A sparse map keyed by session (issue) key: only sessions the user has
 *  explicitly toggled appear; the rest inherit the global default. */
const PLAIN_SURFACE_KEY = 'tm-sessions-plain-surface';

function readPlainSurfaceOverrides(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAIN_SURFACE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writePlainSurfaceOverrides(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(PLAIN_SURFACE_KEY, JSON.stringify(value));
  } catch {
    // Private mode / storage disabled — the override just won't persist.
  }
}

/**
 * The oldest still-unresolved `permission_requested` event — i.e. the next
 * one `respondToPermission` will resolve (both hosts `.shift()` a FIFO
 * queue). Neither host persists pending-permission detail on the session
 * record itself, so this is derived from the event log instead of a
 * separate fetch: everything after the last `permission_completed` event
 * that hasn't been resolved yet.
 */
function pendingPermissionEvent(events: AgentEventSummary[]): AgentEventSummary | undefined {
  const lastCompletedIndex = events.map(e => e.type).lastIndexOf('permission_completed');
  return events.slice(lastCompletedIndex + 1).find(e => e.type === 'permission_requested');
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function decodeContextText(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function parseTerminalContext(detail: string | undefined) {
  const match = detail?.match(/^<terminal_context cwd="([^"]*)" captured_at="([^"]*)">\n([\s\S]*?)\n<\/terminal_context>\n\n([\s\S]*)$/);
  return match ? {
    cwd: decodeContextText(match[1]),
    capturedAt: match[2],
    output: decodeContextText(match[3]),
    message: match[4]
  } : undefined;
}

/**
 * The Sessions feature's centre pane: the console for the selected session.
 *
 * The list of sessions is the shell's sidebar tree, and the session's context
 * and lifecycle actions are the shell's right pane (`SessionInspector`) — this
 * is the conversation and nothing else. Records are fed from the main process
 * (`ai:listSessions` + the `ai:sessionChanged` push channel subscribed in App),
 * so state transitions and streamed events render live.
 */
export function SessionsPage({
  sessions,
  selectedKey,
  onNewSession,
  onOpenAiSettings,
  initialBrowserOpen,
  initialBrowserUrl,
  onBrowserOpenChange,
  onBrowserUrlChange,
  browserSuspended
}: SessionsPageProps) {
  const [status, setStatus] = useState<AiProviderStatus | undefined>();
  const [respondingTo, setRespondingTo] = useState<string | undefined>();
  const [followUp, setFollowUp] = useState('');
  const [followUpError, setFollowUpError] = useState<string | undefined>();
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [abortingSession, setAbortingSession] = useState(false);
  const [analysisState, setAnalysisState] = useState<AiAnalysisState | undefined>();
  const [confirmingAnalysis, setConfirmingAnalysis] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | undefined>(() => getActiveTerminalId());
  const [attachTerminalContext, setAttachTerminalContext] = useState(false);
  const [plainSurfaceOverrides, setPlainSurfaceOverrides] = useState<Record<string, boolean>>(readPlainSurfaceOverrides);
  const [browserOpen, setBrowserOpen] = useState(initialBrowserOpen ?? false);
  const [browserMaximized, setBrowserMaximized] = useState(false);
  const browserDismissed = useRef(initialBrowserOpen === false);
  const { settings } = useSettings();
  const eventsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBrowserOpen(initialBrowserOpen ?? false);
    browserDismissed.current = initialBrowserOpen === false;
  }, [initialBrowserOpen, selectedKey]);

  useEffect(() => {
    writePlainSurfaceOverrides(plainSurfaceOverrides);
  }, [plainSurfaceOverrides]);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
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

  useEffect(() => {
    void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
    const unsubscribeAvailability = window.praxis.terminal.onContextAvailability(event => {
      setTerminalSessions(current => {
        if (current.some(session => session.id === event.sessionId)) {
          return current.map(session => session.id === event.sessionId
            ? { ...session, hasContext: event.terminalHasContext }
            : session);
        }
        void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
        return current;
      });
    });
    const unsubscribeExit = window.praxis.terminal.onExit(event => {
      setTerminalSessions(current => current.map(session => session.id === event.sessionId
        ? { ...session, exited: true }
        : session));
    });
    const unsubscribeActive = onActiveTerminalChanged(sessionId => {
      setActiveTerminalId(sessionId);
      void window.praxis.terminal.list().then(setTerminalSessions).catch(() => undefined);
    });
    return () => { unsubscribeAvailability(); unsubscribeExit(); unsubscribeActive(); };
  }, []);

  const selected = sessions.find(session => session.issueKey === selectedKey) ?? sessions[0];
  const terminalForContext = terminalSessions.find(session => session.id === activeTerminalId && session.hasContext)
    ?? [...terminalSessions].reverse().find(session => session.hasContext && (
      !selected?.workingDirectory || session.cwd === selected.workingDirectory
    ));
  const selectedEventCount = selected?.events.length ?? 0;
  // Surface the browser as soon as the agent drives it, so the user sees the
  // page it is working against.
  const agentUsedBrowser = selected?.events.some(event => event.data?.toolName?.startsWith('browser_')) ?? false;
  useEffect(() => {
    if (agentUsedBrowser && !browserDismissed.current) {
      setBrowserOpen(true);
      onBrowserOpenChange?.(true);
    }
  }, [agentUsedBrowser, onBrowserOpenChange]);

  const setBrowserVisibility = (open: boolean) => {
    browserDismissed.current = !open;
    setBrowserOpen(open);
    if (!open) setBrowserMaximized(false);
    onBrowserOpenChange?.(open);
  };
  // `tool_start` feeds the live status line, not the transcript — only the
  // completed run gets a (collapsed) row, so the chat stays readable.
  const conversationEvents = selected?.events.filter(
    event =>
      (event.type === 'message' || event.type === 'user_input_completed' || event.type === 'tool_complete') && Boolean(event.detail || event.summary)
  ) ?? [];
  const latestEventResponse = [...conversationEvents]
    .reverse()
    .find(event => event.type === 'message')?.detail;

  // One line describing what the agent is doing right now — shown only while a
  // turn is in flight, in place of streaming every tool block.
  const liveActivity = ((): string | undefined => {
    if (!selected || isTerminalAgentState(selected.state) || selected.state === 'awaiting_approval' || selected.state === 'awaiting_input') {
      return undefined;
    }
    const events = selected.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'tool_complete' || event.type === 'message') break;
      if (event.type === 'tool_start') {
        const tool = event.data?.toolName ?? event.summary?.replace(/^Running tool:\s*/i, '');
        return tool ? `Running ${tool}…` : 'Running a tool…';
      }
    }
    if (selected.state === 'planning') return 'Planning…';
    return selected.reasoningText?.trim() ? 'Thinking…' : 'Working…';
  })();

  // The pending permission the agent is blocked on, if any — surfaced as a
  // slide-up dock directly above the chat input.
  const pendingPermission = selected?.state === 'awaiting_approval'
    ? pendingPermissionEvent(selected.events)
    : undefined;
  const respondToPermission = (decision: PermissionDecision) => {
    if (!selected) return;
    setRespondingTo(selected.issueKey);
    void window.praxis.ai
      .respondToPermission(selected.issueKey, decision)
      .finally(() => setRespondingTo(undefined));
  };
  const permissionBusy = respondingTo === selected?.issueKey;

  // Follow the stream: whenever the selected session gains events, pin the
  // console to the latest one (the list replaces the record object on every
  // push, so the count is the reliable change signal).
  useEffect(() => {
    const node = eventsRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [selected?.issueKey, selectedEventCount, selected?.responseText, latestEventResponse]);

  useEffect(() => {
    setFollowUp('');
    setFollowUpError(undefined);
  }, [selected?.issueKey]);

  useEffect(() => {
    setAnalysisState(undefined);
    if (!selected || selected.taskDefinition.kind !== 'analysis') {
      return;
    }
    let cancelled = false;
    void window.praxis.ai.getAnalysis(selected.issueKey).then(next => {
      if (!cancelled) setAnalysisState(next);
    });
    const unsubscribe = window.praxis.ai.onAnalysisChanged(next => {
      if (next.issueKey === selected.issueKey) setAnalysisState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selected?.issueKey, selected?.taskDefinition.kind]);

  const sendFollowUp = async () => {
    if (!selected || !followUp.trim() || !isTerminalAgentState(selected.state)) return;
    setSendingFollowUp(true);
    setFollowUpError(undefined);
    try {
      let message = followUp.trim();
      if (attachTerminalContext) {
        if (!terminalForContext) throw new Error('The selected terminal has no recent output to attach.');
        const context = await window.praxis.terminal.getContext(terminalForContext.id);
        if (!context.output) throw new Error('The selected terminal has no recent output to attach.');
        const escapeContext = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        message = `<terminal_context cwd="${escapeContext(context.cwd)}" captured_at="${context.capturedAt}">\n${escapeContext(context.output)}\n</terminal_context>\n\n${message}`;
      }
      await window.praxis.ai.continueSession(selected.issueKey, message);
      setFollowUp('');
      setAttachTerminalContext(false);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingFollowUp(false);
    }
  };

  const abortSession = async () => {
    if (!selected || isTerminalAgentState(selected.state)) return;
    setAbortingSession(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.abort(selected.issueKey);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setAbortingSession(false);
    }
  };

  useEffect(() => {
    setAttachTerminalContext(false);
  }, [selected?.issueKey]);

  const confirmAndContinue = async () => {
    if (!selected || selected.taskDefinition.kind !== 'analysis' || selected.state !== 'completed') return;
    setConfirmingAnalysis(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.setAnalysisConfirmed(selected.issueKey, true);
      await window.praxis.ai.continueSession(
        selected.issueKey,
        'I confirm the analysis and implementation plan. Continue in this same session and implement the ticket now. Test the result and report back.'
      );
    } catch (error) {
      await window.praxis.ai.setAnalysisConfirmed(selected.issueKey, false).catch(() => undefined);
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirmingAnalysis(false);
    }
  };

  // Profile-wide "Plain chat background", overridable per session from the
  // console header. Undefined settings (still loading) fall back to themed.
  const globalPlainSurface = settings?.appearance.surface.plainChatSurface ?? false;
  const plainSurface = selected && selected.issueKey in plainSurfaceOverrides
    ? plainSurfaceOverrides[selected.issueKey]!
    : globalPlainSurface;
  const togglePlainSurface = () => {
    if (!selected) return;
    setPlainSurfaceOverrides(current => ({ ...current, [selected.issueKey]: !plainSurface }));
  };

  return (
    <div
      className={`sessions-layout${plainSurface ? ' plain-surface' : ''}`}
      data-testid="sessions-view"
    >
      <div
        className={`session-console${browserOpen && selected ? ' browser-open' : ''}${browserOpen && selected && browserMaximized ? ' browser-maximized' : ''}`}
        data-testid="session-console"
      >
        {!selected && (
          sessions.length === 0 ? (
            <div className="empty-state" style={{ flex: 1 }} data-testid="sessions-empty">
              <Icon name="robot" size={28} />
              <span>No AI sessions yet.</span>
              <button className="btn" onClick={onNewSession} data-testid="sessions-new-session">
                <Icon name="plus" size={13} />
                New session
              </button>
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
          ) : (
            <div className="empty-state" style={{ flex: 1 }}>
              <Icon name="terminal" size={28} />
              <span>Select a session in the sidebar to see its console.</span>
            </div>
          )
        )}
        {selected && (
          <>
            <div className="session-console-header">
              <Icon name="robot" size={14} />
              <span
                className="session-console-title"
                data-testid="session-console-title"
                title={sessionTitle(selected)}
              >
                {sessionLabel(selected)}
              </span>
              <button
                type="button"
                className={`icon-btn icon-btn-sm${plainSurface ? ' active' : ''}`}
                data-testid="session-plain-surface-toggle"
                aria-pressed={plainSurface}
                title={plainSurface
                  ? 'Plain background — click to show the theme surface behind this session'
                  : 'Theme surface — click for a plain background behind this session'}
                onClick={togglePlainSurface}
              >
                <Icon name="theme" size={13} />
              </button>
              <button
                type="button"
                className={`icon-btn icon-btn-sm${browserOpen ? ' active' : ''}`}
                data-testid="session-browser-toggle"
                aria-pressed={browserOpen}
                title={browserOpen ? 'Hide the in-app browser' : 'Show the in-app browser'}
                onClick={() => setBrowserVisibility(!browserOpen)}
              >
                <Icon name="globe" size={13} />
              </button>
            </div>

            {selected.taskDefinition.kind === 'analysis' && (
              <div className="session-analysis-banner" data-testid="session-analysis-banner">
                <Icon name={analysisState?.confirmed ? 'check-square' : 'search'} size={15} />
                <div>
                  <strong>{analysisState?.confirmed ? 'Analysis confirmed' : 'Ticket analysis'}</strong>
                  <span>
                    {analysisState?.confirmed
                      ? 'Implementation is continuing in this conversation.'
                      : selected.state === 'completed'
                        ? 'Review the analysis below, then confirm it to implement in this same session.'
                        : 'The agent is analysing the ticket in this conversation.'}
                  </span>
                </div>
                {!analysisState?.confirmed && selected.state === 'completed' && (
                  <button
                    className="btn btn-primary"
                    data-testid="session-analysis-confirm"
                    disabled={confirmingAnalysis}
                    onClick={() => void confirmAndContinue()}
                  >
                    <Icon name="check-square" size={13} />
                    {confirmingAnalysis ? 'Continuing…' : 'Confirm & implement'}
                  </button>
                )}
              </div>
            )}

            <div className="session-chat-scroll" ref={eventsRef} data-testid="session-chat-thread">
              <div className="session-chat-message is-user">
                <div className="session-chat-author">You</div>
                <div>{selected.taskDefinition.goal}</div>
              </div>
              {conversationEvents.map((event, index) => {
                if (event.type === 'tool_complete') {
                  const view = resolveToolView(event);
                  const argsLabel = toolArgsLabel(event);
                  const fileChanges = event.data?.fileChanges?.filter(change => change.diff);
                  const singleDiff = event.data?.diff;
                  const shellOutput = event.data?.output ?? event.detail ?? '';
                  // Collapsed by default: a slim "ran X" row; expand for the
                  // output / diff. The result never lands inline in the chat.
                  return (
                    <details
                      className="session-chat-tool"
                      key={`${event.timestamp}-${index}`}
                      data-testid="session-chat-tool"
                    >
                      <summary>
                        <Icon name="check-square" size={13} />
                        <span>{event.summary}</span>
                        {argsLabel && <code className="session-tool-args">{argsLabel}</code>}
                        <span className="session-chat-tool-time">{formatTime(event.timestamp)}</span>
                      </summary>
                      {view === 'shell' ? (
                        <ToolTerminal text={shellOutput} />
                      ) : view === 'write' && (fileChanges?.length || singleDiff) ? (
                        fileChanges?.length ? (
                          fileChanges.map((change, changeIndex) => (
                            <div className="session-tool-file" key={changeIndex}>
                              <span className="session-tool-file-path">{change.path}</span>
                              <ToolDiff diff={change.diff ?? ''} />
                            </div>
                          ))
                        ) : (
                          <ToolDiff diff={singleDiff ?? ''} />
                        )
                      ) : (
                        event.detail && <pre>{event.detail}</pre>
                      )}
                    </details>
                  );
                }
                const terminalContext = event.type === 'user_input_completed' ? parseTerminalContext(event.detail) : undefined;
                return (
                  <div
                    className={`session-chat-message ${event.type === 'message' ? 'is-assistant' : 'is-user'}`}
                    key={`${event.timestamp}-${index}`}
                    data-testid={event.type === 'message' ? 'session-chat-assistant' : 'session-chat-user'}
                  >
                    <div className="session-chat-author">{event.type === 'message' ? 'AI agent' : 'You'}</div>
                    {terminalContext && (
                      <details className="session-chat-terminal-context">
                        <summary><Icon name="terminal" size={13} /> Recent terminal output <span>{terminalContext.cwd}</span></summary>
                        <pre>{terminalContext.output}</pre>
                      </details>
                    )}
                    <div>{terminalContext?.message ?? event.detail}</div>
                  </div>
                );
              })}
              {selected.responseText && selected.responseText !== latestEventResponse && (
                <div className="session-chat-message is-assistant" data-testid="session-response">
                  <div className="session-chat-author">AI agent</div>
                  <div>{selected.responseText}</div>
                </div>
              )}
              {liveActivity ? (
                <div className="session-activity-status" data-testid="session-activity-status">
                  <span className="session-activity-dot" aria-hidden="true" />
                  <span>{liveActivity}</span>
                </div>
              ) : (
                !selected.responseText && conversationEvents.length === 0 && (
                  <span className="placeholder-text">Waiting for the agent to respond…</span>
                )
              )}

              <details className="session-activity">
                <summary>Activity log · {selected.events.length} events</summary>
                <div className="session-events" data-testid="session-events">
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
              </details>
            </div>

            {pendingPermission && (
              <div className="session-request-dock" data-testid="session-request-dock">
                <div className="session-permission-card" data-testid="session-permission-card">
                  <Icon name="shield" size={15} />
                  <div className="session-permission-body">
                    <div className="session-permission-summary">{pendingPermission.summary}</div>
                    {pendingPermission.detail && (
                      <div className="session-permission-detail">{pendingPermission.detail}</div>
                    )}
                  </div>
                  <div className="session-permission-actions">
                    <button
                      className="btn"
                      data-testid="session-permission-deny"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('deny')}
                    >
                      Deny
                    </button>
                    <button
                      className="btn"
                      data-testid="session-permission-allow-always"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('allow_always')}
                    >
                      Always allow
                    </button>
                    <button
                      className="btn btn-primary"
                      data-testid="session-permission-allow-once"
                      disabled={permissionBusy}
                      onClick={() => respondToPermission('allow_once')}
                    >
                      Allow
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="session-chat-composer">
              {followUpError && <div className="error-banner" data-testid="session-follow-up-error">{followUpError}</div>}
              <div className="composer session-follow-up-composer">
                {attachTerminalContext && terminalForContext && (
                  <div className="terminal-context-attachment" data-testid="terminal-context-attachment">
                    <Icon name="terminal" size={14} />
                    <span>Recent terminal output</span>
                    <span className="terminal-context-cwd" title={terminalForContext.cwd}>{terminalForContext.cwd}</span>
                    <button className="icon-btn icon-btn-sm" aria-label="Remove terminal context" onClick={() => setAttachTerminalContext(false)}>
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                )}
                <textarea
                  className="composer-input"
                  rows={2}
                  data-testid="session-follow-up-input"
                  value={followUp}
                  disabled={!isTerminalAgentState(selected.state) || sendingFollowUp}
                  placeholder={
                    isTerminalAgentState(selected.state)
                      ? 'Ask the agent to clarify, change, or continue…'
                      : 'The agent is working…'
                  }
                  onChange={event => setFollowUp(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && followUp.trim()) {
                      event.preventDefault();
                      void sendFollowUp();
                    }
                  }}
                />
              <div className="composer-controls">
                  {terminalForContext && (
                    <button
                      className={`composer-chip terminal-context-button${attachTerminalContext ? ' active' : ''}`}
                      type="button"
                      aria-pressed={attachTerminalContext}
                      title={attachTerminalContext ? 'Remove terminal output from this message' : 'Attach recent terminal output'}
                      data-testid="attach-terminal-context"
                      onClick={() => setAttachTerminalContext(value => !value)}
                    >
                      <Icon name="terminal" size={14} />
                      Terminal
                      <span className="terminal-context-dot" aria-hidden="true" />
                    </button>
                  )}
                  <span className="spacer" />
                  <button
                    className={`composer-send${!isTerminalAgentState(selected.state) ? ' composer-send-cancel' : ''}`}
                    aria-label={!isTerminalAgentState(selected.state) ? 'Cancel response' : sendingFollowUp ? 'Sending message' : 'Send message'}
                    title={!isTerminalAgentState(selected.state) ? (abortingSession ? 'Cancelling…' : 'Cancel response') : sendingFollowUp ? 'Sending…' : 'Send message'}
                    data-testid="session-follow-up-send"
                    disabled={abortingSession || (isTerminalAgentState(selected.state) && (sendingFollowUp || !followUp.trim()))}
                    onClick={() => {
                      if (!isTerminalAgentState(selected.state)) {
                        void abortSession();
                      } else {
                        void sendFollowUp();
                      }
                    }}
                  >
                    <Icon name={!isTerminalAgentState(selected.state) ? 'close' : 'arrow-up'} size={15} />
                  </button>
                </div>
              </div>
            </div>
            {browserOpen && (
              <div
                className={`session-browser-dock${settings?.ai.browserTools.enabled ? ' ai-controlled' : ''}`}
                title={settings?.ai.browserTools.enabled ? 'The AI can drive this browser' : undefined}
              >
                <BrowserPane
                  initialUrl={initialBrowserUrl}
                  onNavigate={onBrowserUrlChange}
                  suspended={browserSuspended}
                  maximized={browserMaximized}
                  onToggleMaximize={() => setBrowserMaximized(value => !value)}
                  onClose={() => setBrowserVisibility(false)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
