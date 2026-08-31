import { useEffect, useRef, useState } from 'react';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AiAnalysisState,
  AiProviderStatus,
  PermissionDecision,
  SessionMode,
  TerminalSessionInfo
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import {
  agentEventIcon,
  agentEventToneClass,
  agentStateBadgeClass,
  agentStateLabel,
  isTerminalAgentState
} from './aiSessionState';
import { useSettings } from '../settings/useSettings';
import { BrowserPane } from '../browser/BrowserPane';
import { PROVIDER_LABELS, providerIconName } from './modelProviders';
import { getActiveTerminalId, onActiveTerminalChanged } from './terminalSelection';
import { resolveToolView, toolArgsLabel, ToolDiff, ToolTerminal } from './toolEventView';

export interface SessionsPageProps {
  /** All known agent sessions, most recent first. Live-updated by the App-level push subscription. */
  sessions: AgentSessionRecord[];
  selectedKey: string | undefined;
  onSelect: (issueKey: string) => void;
  onNewSession: () => void;
  onOpenAiSettings: () => void;
  initialBrowserOpen?: boolean;
  initialBrowserUrl?: string;
  onBrowserOpenChange?: (open: boolean) => void;
  onBrowserUrlChange?: (url: string) => void;
}

/** Which edge the session list docks to, and whether it's tucked away — a
 *  per-user layout preference, persisted like `tm-sidebar-mode`. */
type ListSide = 'left' | 'right';
const LIST_SIDE_KEY = 'tm-sessions-list-side';
const LIST_COLLAPSED_KEY = 'tm-sessions-list-collapsed';

function readListSide(): ListSide {
  try {
    return localStorage.getItem(LIST_SIDE_KEY) === 'right' ? 'right' : 'left';
  } catch {
    return 'left';
  }
}

function readListCollapsed(): boolean {
  try {
    return localStorage.getItem(LIST_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
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

/** Last path segment, for a compact working-directory label. */
function basename(fsPath: string): string {
  const parts = fsPath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? fsPath;
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

function sessionTitle(session: AgentSessionRecord): string {
  return session.title?.trim() || session.taskDefinition.goal.split('\n')[0];
}

/**
 * A free-form session (New Session composer, no tracker issue) is stored under a
 * synthesized `SESSION-<hex>` key — a unique internal handle, not something the
 * user chose. The UI shows the session's title instead; only a real tracker
 * issue keeps its key (e.g. `PROJ-123`) on screen.
 */
function isSynthesizedKey(issueKey: string): boolean {
  return /^SESSION-[0-9a-f]{6,}$/i.test(issueKey);
}

/** What to show as the session's name: the title alone for free-form sessions,
 *  `KEY — title` for tracker-issue sessions. */
function sessionLabel(session: AgentSessionRecord): string {
  const title = sessionTitle(session);
  return isSynthesizedKey(session.issueKey) ? title : `${session.issueKey} — ${title}`;
}

function sessionMode(session: AgentSessionRecord): 'Chat' | 'Analysis' | 'Review' {
  if (session.mode === 'analysis' || session.taskDefinition.kind === 'analysis') return 'Analysis';
  if (session.mode === 'review' || session.taskDefinition.kind === 'review') return 'Review';
  return 'Chat';
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
  onOpenAiSettings,
  initialBrowserOpen,
  initialBrowserUrl,
  onBrowserOpenChange,
  onBrowserUrlChange
}: SessionsPageProps) {
  const [status, setStatus] = useState<AiProviderStatus | undefined>();
  const [respondingTo, setRespondingTo] = useState<string | undefined>();
  const [followUp, setFollowUp] = useState('');
  const [followUpError, setFollowUpError] = useState<string | undefined>();
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [abortingSession, setAbortingSession] = useState(false);
  const [analysisState, setAnalysisState] = useState<AiAnalysisState | undefined>();
  const [confirmingAnalysis, setConfirmingAnalysis] = useState(false);
  const [editingSessionKey, setEditingSessionKey] = useState<string | undefined>();
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [sessionMutationKey, setSessionMutationKey] = useState<string | undefined>();
  const [sessionListError, setSessionListError] = useState<string | undefined>();
  const [switchingMode, setSwitchingMode] = useState(false);
  const [removingWorktree, setRemovingWorktree] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | undefined>(() => getActiveTerminalId());
  const [attachTerminalContext, setAttachTerminalContext] = useState(false);
  const [listSide, setListSide] = useState<ListSide>(readListSide);
  const [listCollapsed, setListCollapsed] = useState<boolean>(readListCollapsed);
  const [plainSurfaceOverrides, setPlainSurfaceOverrides] = useState<Record<string, boolean>>(readPlainSurfaceOverrides);
  const [browserOpen, setBrowserOpen] = useState(initialBrowserOpen ?? false);
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
    try {
      localStorage.setItem(LIST_SIDE_KEY, listSide);
    } catch {
      // Private mode / storage disabled — the preference just won't persist.
    }
  }, [listSide]);

  useEffect(() => {
    try {
      localStorage.setItem(LIST_COLLAPSED_KEY, listCollapsed ? '1' : '0');
    } catch {
      // As above.
    }
  }, [listCollapsed]);

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
    onBrowserOpenChange?.(open);
  };
  const conversationEvents = selected?.events.filter(
    event =>
      (event.type === 'message' || event.type === 'user_input_completed' || event.type === 'tool_start' || event.type === 'tool_complete') && Boolean(event.detail || event.summary)
  ) ?? [];
  const latestEventResponse = [...conversationEvents]
    .reverse()
    .find(event => event.type === 'message')?.detail;

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

  const switchMode = async (mode: SessionMode) => {
    if (!selected || mode === (selected.mode ?? 'chat') || !isTerminalAgentState(selected.state)) return;
    setSwitchingMode(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.switchSessionMode(selected.issueKey, mode);
      const transition = mode === 'analysis'
        ? 'Switch this conversation into Analysis mode. Inspect the relevant ticket and workspace read-only, then return a concrete analysis and implementation plan. Do not make changes.'
        : mode === 'review'
          ? 'Switch this conversation into Review mode. Review the relevant ticket, workspace, and current implementation read-only, then report findings, risks, and actionable recommendations. Do not make changes.'
          : 'Switch this conversation into Chat mode. Answer my next requests directly and do not inspect or modify tickets unless I explicitly ask.';
      await window.praxis.ai.continueSession(selected.issueKey, transition);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingMode(false);
    }
  };

  const removeWorktree = async () => {
    if (!selected?.worktreePath || removingWorktree) return;
    if (!window.confirm(`Remove the git worktree for this session?\n\n${selected.worktreePath}\n\nThe branch ${selected.worktreeBranch ?? ''} and its checkout are deleted.`)) {
      return;
    }
    setRemovingWorktree(true);
    setFollowUpError(undefined);
    try {
      await window.praxis.ai.removeWorktree(selected.issueKey);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemovingWorktree(false);
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

  const beginRename = (session: AgentSessionRecord) => {
    setSessionListError(undefined);
    setEditingSessionKey(session.issueKey);
    setSessionTitleDraft(sessionTitle(session));
  };

  const commitRename = async (session: AgentSessionRecord) => {
    const title = sessionTitleDraft.trim();
    if (!title) {
      setSessionListError('Session title cannot be empty.');
      return;
    }
    if (title === sessionTitle(session)) {
      setEditingSessionKey(undefined);
      return;
    }
    setSessionMutationKey(session.issueKey);
    setSessionListError(undefined);
    try {
      await window.praxis.ai.renameSession(session.issueKey, title);
      setEditingSessionKey(undefined);
    } catch (error) {
      setSessionListError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionMutationKey(undefined);
    }
  };

  const deleteSession = async (session: AgentSessionRecord) => {
    setSessionMutationKey(session.issueKey);
    setSessionListError(undefined);
    try {
      await window.praxis.ai.deleteSession(session.issueKey);
      setEditingSessionKey(undefined);
    } catch (error) {
      setSessionListError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionMutationKey(undefined);
    }
  };

  const otherSide = listSide === 'left' ? 'right' : 'left';

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
      className={`sessions-layout side-${listSide}${listCollapsed ? ' list-collapsed' : ''}${plainSurface ? ' plain-surface' : ''}`}
      data-testid="sessions-view"
    >
      {listCollapsed ? (
        <div className="sessions-list-rail">
          <button
            className="icon-btn"
            aria-label="Expand session list"
            title="Expand session list"
            data-testid="sessions-list-expand"
            onClick={() => setListCollapsed(false)}
          >
            <Icon name={listSide === 'left' ? 'sidebar-left' : 'sidebar-right'} size={15} />
          </button>
          <button
            className="icon-btn"
            aria-label="New session"
            title="New session"
            onClick={onNewSession}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      ) : (
      <div className="sessions-list">
        <div className="sessions-list-header">
          <span className="sessions-list-title">Sessions</span>
          <button
            className="icon-btn icon-btn-sm"
            aria-label={`Move session list to the ${otherSide}`}
            title={`Move list to the ${otherSide}`}
            data-testid="sessions-list-swap-side"
            onClick={() => setListSide(otherSide)}
          >
            <Icon name={listSide === 'left' ? 'arrow-right' : 'arrow-left'} size={14} />
          </button>
          <button
            className="icon-btn icon-btn-sm"
            aria-label="Collapse session list"
            title="Collapse session list"
            data-testid="sessions-list-collapse"
            onClick={() => setListCollapsed(true)}
          >
            <Icon name={listSide === 'left' ? 'sidebar-left' : 'sidebar-right'} size={14} />
          </button>
          <button className="btn" onClick={onNewSession} data-testid="sessions-new-btn">
            <Icon name="plus" size={13} />
            New session
          </button>
        </div>
        <div className="sessions-list-scroll">
          {sessionListError && (
            <div className="error-banner session-list-error" data-testid="session-list-error">
              {sessionListError}
            </div>
          )}
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
          {sessions.map(session => {
            const editing = editingSessionKey === session.issueKey;
            const mutating = sessionMutationKey === session.issueKey;
            const title = sessionTitle(session);
            return (
              <div
                key={session.issueKey}
                className={`session-item${selected?.issueKey === session.issueKey ? ' active' : ''}`}
                data-testid="session-list-row"
                role="button"
                tabIndex={0}
                onClick={() => !editing && onSelect(session.issueKey)}
                onKeyDown={event => {
                  if (!editing && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSelect(session.issueKey);
                  }
                }}
              >
                <span className="session-item-top">
                  {!isSynthesizedKey(session.issueKey) && (
                    <span className="session-item-key">{session.issueKey}</span>
                  )}
                  <span className="session-mode-badge">{sessionMode(session)}</span>
                  <span className={agentStateBadgeClass(session.state)}>
                    {agentStateLabel(session.state)}
                  </span>
                  <span className="session-item-actions">
                    <button
                      className="icon-btn icon-btn-sm"
                      aria-label={`Rename session ${sessionTitle(session)}`}
                      title="Rename session"
                      data-testid="session-rename-btn"
                      disabled={mutating}
                      onClick={event => {
                        event.stopPropagation();
                        beginRename(session);
                      }}
                    >
                      <Icon name="pencil" size={12} />
                    </button>
                    <button
                      className="icon-btn icon-btn-sm"
                      aria-label={`Delete session ${sessionTitle(session)}`}
                      title="Delete session"
                      data-testid="session-delete-btn"
                      disabled={mutating}
                      onClick={event => {
                        event.stopPropagation();
                        void deleteSession(session);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </span>
                {editing ? (
                  <input
                    className="session-title-input"
                    data-testid="session-title-input"
                    aria-label={`Session title for ${sessionTitle(session)}`}
                    value={sessionTitleDraft}
                    disabled={mutating}
                    autoFocus
                    onClick={event => event.stopPropagation()}
                    onChange={event => setSessionTitleDraft(event.target.value)}
                    onBlur={() => void commitRename(session)}
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setEditingSessionKey(undefined);
                      }
                    }}
                  />
                ) : (
                  <span className="session-item-goal" title={title} data-testid="session-title">
                    {title}
                  </span>
                )}
                <span className="session-item-meta">
                  {formatStarted(session.startedAt)} · {session.stepCount}{' '}
                  {session.stepCount === 1 ? 'step' : 'steps'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      )}

      <div
        className={`session-console${browserOpen && selected ? ' browser-open' : ''}`}
        data-testid="session-console"
      >
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
              <span
                className="session-console-title"
                data-testid="session-console-title"
                title={sessionTitle(selected)}
              >
                {sessionLabel(selected)}
              </span>
              <span className={agentStateBadgeClass(selected.state)} data-testid="session-state-badge">
                {agentStateLabel(selected.state)}
              </span>
              <span className="session-mode-badge" data-testid="session-mode-badge">{sessionMode(selected)}</span>
              {isTerminalAgentState(selected.state) && (
                <div className="session-mode-switch" role="group" aria-label="Switch session mode">
                  {(['chat', 'analysis', 'review'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      className={selected.mode === mode || (!selected.mode && mode === 'chat') ? 'active' : ''}
                      disabled={switchingMode}
                      onClick={() => void switchMode(mode)}
                      data-testid={`session-switch-mode-${mode}`}
                    >
                      {mode[0].toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              <span className="session-item-meta">{selected.stepCount} steps</span>
              {/* Provider, model, tool mode, folder and worktree live on the
                  composer below — the same row a new session shows them in —
                  since they are fixed for the session's life, not live status. */}
              {isTerminalAgentState(selected.state) && selected.worktreePath && (
                <button
                  className="btn"
                  data-testid="session-remove-worktree"
                  disabled={removingWorktree}
                  onClick={() => void removeWorktree()}
                >
                  <Icon name="git-branch" size={13} />
                  {removingWorktree ? 'Removing…' : 'Remove worktree'}
                </button>
              )}
              {!isTerminalAgentState(selected.state) && (
                <button
                  className="btn"
                  data-testid="session-abort-btn"
                  onClick={() => void window.praxis.ai.abort(selected.issueKey)}
                >
                  <Icon name="close" size={13} />
                  Abort
                </button>
              )}
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

            {selected.state === 'awaiting_approval' &&
              (() => {
                const pending = pendingPermissionEvent(selected.events);
                if (!pending) {
                  return null;
                }
                const respond = (decision: PermissionDecision) => {
                  setRespondingTo(selected.issueKey);
                  void window.praxis.ai
                    .respondToPermission(selected.issueKey, decision)
                    .finally(() => setRespondingTo(undefined));
                };
                const busy = respondingTo === selected.issueKey;
                return (
                  <div className="session-permission-card" data-testid="session-permission-card">
                    <Icon name="shield" size={15} />
                    <div className="session-permission-body">
                      <div className="session-permission-summary">{pending.summary}</div>
                      {pending.detail && <div className="session-permission-detail">{pending.detail}</div>}
                    </div>
                    <div className="session-permission-actions">
                      <button
                        className="btn"
                        data-testid="session-permission-deny"
                        disabled={busy}
                        onClick={() => respond('deny')}
                      >
                        Deny
                      </button>
                      <button
                        className="btn"
                        data-testid="session-permission-allow-always"
                        disabled={busy}
                        onClick={() => respond('allow_always')}
                      >
                        Always allow
                      </button>
                      <button
                        className="btn btn-primary"
                        data-testid="session-permission-allow-once"
                        disabled={busy}
                        onClick={() => respond('allow_once')}
                      >
                        Allow
                      </button>
                    </div>
                  </div>
                );
              })()}

            <div className="session-chat-scroll" ref={eventsRef} data-testid="session-chat-thread">
              <div className="session-chat-message is-user">
                <div className="session-chat-author">You</div>
                <div>{selected.taskDefinition.goal}</div>
              </div>
              {conversationEvents.map((event, index) => {
                if (event.type === 'tool_start' || event.type === 'tool_complete') {
                  const view = resolveToolView(event);
                  const argsLabel = toolArgsLabel(event);
                  const fileChanges = event.data?.fileChanges?.filter(change => change.diff);
                  const singleDiff = event.data?.diff;
                  const shellOutput = event.data?.output ?? event.detail ?? '';
                  return (
                    <details
                      className={`session-chat-tool${event.type === 'tool_start' ? ' is-running' : ''}`}
                      key={`${event.timestamp}-${index}`}
                      data-testid="session-chat-tool"
                      open={event.type === 'tool_complete'}
                    >
                      <summary>
                        <Icon name={event.type === 'tool_start' ? 'tools' : 'check-square'} size={13} />
                        <span>{event.summary}</span>
                        {argsLabel && <code className="session-tool-args">{argsLabel}</code>}
                        <span className="session-chat-tool-time">{formatTime(event.timestamp)}</span>
                      </summary>
                      {event.type === 'tool_complete' && view === 'shell' ? (
                        <ToolTerminal text={shellOutput} />
                      ) : event.type === 'tool_complete' && view === 'write' && (fileChanges?.length || singleDiff) ? (
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
              {!selected.responseText && conversationEvents.length === 0 && (
                <span className="placeholder-text">Waiting for the agent to respond…</span>
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
                  {selected.provider && (
                    <span className="composer-chip session-runtime-chip" data-testid="session-provider" title="This session's AI provider">
                      <Icon name={providerIconName(selected.provider)} size={14} />
                      {PROVIDER_LABELS[selected.provider]}
                    </span>
                  )}
                  {selected.model && (
                    <span className="composer-chip session-runtime-chip" data-testid="session-model" title="This session's AI model">
                      <Icon name="sparkles" size={14} />
                      {selected.model}
                    </span>
                  )}
                  <span
                    className="composer-chip session-runtime-chip"
                    data-testid="session-tool-mode"
                    title="Tool access for this session — fixed when it started"
                  >
                    <Icon name={selected.toolMode === 'full' ? 'tools' : 'search'} size={14} />
                    {selected.toolMode === 'project-only'
                      ? 'Project only'
                      : selected.toolMode === 'read-only' ? 'Read only' : 'Full tools'}
                  </span>
                  {selected.workingDirectory && (
                    <span
                      className="composer-chip session-runtime-chip"
                      data-testid="session-working-directory"
                      title={selected.workingDirectory}
                    >
                      <Icon name="folder" size={14} />
                      {basename(selected.workingDirectory)}
                    </span>
                  )}
                  {selected.worktreeBranch && (
                    <span
                      className="composer-chip session-runtime-chip"
                      data-testid="session-worktree"
                      title={selected.worktreePath}
                    >
                      <Icon name="git-branch" size={14} />
                      {selected.worktreeBranch}
                      {selected.worktreeBaseBranch && (
                        <span className="session-worktree-base"> from {selected.worktreeBaseBranch}</span>
                      )}
                    </span>
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
              <div className="session-browser-dock">
                <BrowserPane
                  initialUrl={initialBrowserUrl}
                  onNavigate={onBrowserUrlChange}
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
