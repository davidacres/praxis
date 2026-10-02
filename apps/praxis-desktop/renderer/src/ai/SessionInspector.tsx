import { useEffect, useState } from 'react';
import type { AgentSessionRecord, WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { agentStateBadgeClass, isTerminalAgentState } from './aiSessionState';
import { SessionChanges } from './SessionChanges';
import { SessionHandoverBrief, SessionPurposeBlock, SessionRuntimeHistory } from './SessionHandover';
import { SessionTasks } from './SessionTasks';
import { SessionActivity } from './SessionActivity';
import { SessionSubagentsSummaryBlock, SessionSubagentsTab } from './SessionSubagents';
import { extractSubagents, failedToolCount, formatCost, formatElapsed, formatStarted, formatTokens, liveActivity, reasoningSnippet, sessionMode, sessionTitle } from './sessionNav';
import { agentStateLaneClass, agentStateLabel } from './aiSessionState';

/**
 * Sessions runtime panel — the shell's right pane for the `sessions` route.
 *
 * Answers "what is this session and what can I do to it?": live state and
 * every action that changes it. The facts fixed when the session started
 * (provider, model, tool access, folder, worktree), the mode switch, and the
 * context indicator all live on the composer in the centre pane instead —
 * visible right where you are about to act, not in a panel you have to go
 * looking at.
 *
 * Three tabs, because those are three different questions and only one of them
 * is usually being asked: what state is it in, what did it run, what did it
 * change.
 *
 * It deliberately does **not** echo the conversation. A "Last message" block
 * here once rendered the full assistant reply as Markdown, which made the rail
 * a second copy of the transcript beside the first — it had grown from a
 * truncated preview into a complete render precisely because truncating broke
 * tables and code fences, which was the signal that conversational content did
 * not belong here at all. The task list and the live activity line stay because
 * they are live state that scrolls away; a finished message is neither.
 *
 * Mirrors `AgentRuntimePanel`, which does the same job for the `agents` route.
 */

export interface SessionInspectorProps {
  session?: AgentSessionRecord;
  /**
   * Every known session for the Sessions browser tab — the same list the App
   * keeps live, so archived sessions stay reachable even though they have
   * left the sidebar tree and focus tabs.
   */
  sessions?: AgentSessionRecord[];
  /** Opens a session from the browser tab. */
  onSelectSession?: (issueKey: string) => void;
  /** Archives or restores a session from the browser tab. */
  onArchiveSession?: (issueKey: string, archived: boolean) => Promise<void>;
  /** Open this session's durable workflow run in the detailed monitor. */
  onOpenWorkflowRun?: (runId: string) => void;
}

type InspectorTab = 'summary' | 'activity' | 'changes' | 'subagents' | 'sessions';

export function SessionInspector({
  session,
  sessions = [],
  onSelectSession,
  onArchiveSession,
  onOpenWorkflowRun
}: SessionInspectorProps) {
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<InspectorTab>('summary');
  const [workflowRun, setWorkflowRun] = useState<WorkflowRunSummary>();
  const [copiedReasoning, setCopiedReasoning] = useState(false);

  // Switching session resets to Summary. Keeping the previous tab would land
  // you on another session's Activity with no idea why you are looking at it.
  const sessionId = session?.sessionId;
  useEffect(() => setTab('summary'), [sessionId]);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ tab: InspectorTab }>;
      if (custom.detail?.tab) {
        setTab(custom.detail.tab);
      }
    };
    window.addEventListener('praxis:session-tab', handler);
    return () => window.removeEventListener('praxis:session-tab', handler);
  }, []);

  const workflowRunId = session?.workflowRunId;
  useEffect(() => {
    let active = true;
    setWorkflowRun(undefined);
    if (!workflowRunId) return () => { active = false; };

    const refresh = () => {
      void window.praxis.workflows.getRun(workflowRunId).then(run => {
        if (active) setWorkflowRun(run);
      });
    };
    refresh();
    const unsubscribe = window.praxis.workflows.onRunChanged(runId => {
      if (runId === workflowRunId) refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workflowRunId]);

  if (!session) {
    // With sessions in the workspace but none selected (e.g. every one of
    // them archived), the browser is the one surface that can reopen one —
    // it must stay reachable rather than collapsing to a dead empty state.
    if (sessions.length > 0) {
      return (
        <section className="inspector inspector--tabbed session-inspector" aria-label="Sessions" data-testid="session-inspector">
          <SessionBrowser
            sessions={sessions}
            onSelectSession={onSelectSession}
            onArchiveSession={onArchiveSession}
          />
        </section>
      );
    }
    return (
      <div className="empty-state" data-testid="session-inspector-empty">
        <Icon name="robot" size={26} />
        <span>A session&rsquo;s status, changes, and actions appear here.</span>
      </div>
    );
  }

  const finished = isTerminalAgentState(session.state);
  const elapsed = formatElapsed(session.startedAt, session.completedAt);
  // Both depend on what the provider reports: API providers give tokens, ACP
  // agents give cost. Neither is guessed when absent — see sessionNav.
  const tokens = formatTokens(session.tokenUsage);
  const cost = formatCost(session.cost);
  const activity = liveActivity(session);
  const reasoning = reasoningSnippet(session);
  const failedTools = failedToolCount(session.events);
  const subagents = extractSubagents(session, sessions);
  const parentSession = session.parentSessionKey
    ? sessions.find(s => s.issueKey === session.parentSessionKey)
    : undefined;

  const copyReasoning = () => {
    if (!reasoning) return;
    void navigator.clipboard.writeText(reasoning);
    setCopiedReasoning(true);
    setTimeout(() => setCopiedReasoning(false), 2000);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeWorktree = async () => {
    if (!session.worktreePath) return;
    const ok = await confirm({
      title: 'Remove the git worktree?',
      message: `${session.worktreePath}\n\nThe branch ${session.worktreeBranch ?? ''} and its checkout are deleted.`,
      confirmLabel: 'Remove worktree',
      danger: true
    });
    if (!ok) return;
    void run(() => window.praxis.ai.removeWorktree(session.issueKey));
  };

  const visibleTabs: Array<{ id: InspectorTab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'activity', label: 'Activity' },
    { id: 'changes', label: 'Changes' }
  ];
  if (subagents.length > 0 || tab === 'subagents') {
    visibleTabs.push({ id: 'subagents', label: 'Subagents' });
  }
  visibleTabs.push({ id: 'sessions', label: 'Sessions' });

  return (
    <section className="inspector inspector--tabbed session-inspector" aria-label="Session context" data-testid="session-inspector">
      <div className="agent-runtime-status">
        <span className={agentStateBadgeClass(session.state)} data-testid="session-state-badge">
          {agentStateLabel(session.state)}
        </span>
        <div>
          <strong data-testid="session-mode-badge">{sessionMode(session)}</strong>
          <p className="rail-sub" data-testid="session-meta">
            {formatStarted(session.startedAt)} · {session.stepCount} {session.stepCount === 1 ? 'step' : 'steps'}
            {elapsed && <> · {elapsed}</>}
            {tokens && <> · <span data-testid="session-tokens">{tokens}</span></>}
            {cost && <> · <span data-testid="session-cost">{cost}</span></>}
          </p>
        </div>
      </div>

      {session.parentSessionKey && (
        <div className="session-parent-banner" data-testid="session-parent-banner">
          <Icon name="robot" size={12} />
          <span>Subagent of</span>
          <button
            type="button"
            className="session-parent-link"
            data-testid="session-parent-link"
            onClick={() => onSelectSession?.(session.parentSessionKey!)}
            title={`Open parent agent (${session.parentSessionKey})`}
          >
            {parentSession ? sessionTitle(parentSession) : session.parentSessionKey}
          </button>
        </div>
      )}

      <div className="inspector-tabs" role="tablist" aria-label="Session detail">
        {visibleTabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'active' : undefined}
            data-testid={`session-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === 'subagents' && subagents.length > 0 && (
              <span className="inspector-tab-badge" data-testid="session-tab-subagents-count">{subagents.length}</span>
            )}
            {/* The failure count is the one urgent thing the log carries, so it
                has to be readable without opening the tab. */}
            {entry.id === 'activity' && failedTools > 0 && (
              <span className="inspector-tab-attention" data-testid="session-tab-activity-failed">{failedTools}</span>
            )}
          </button>
        ))}
      </div>

      <div className="inspector-body" role="tabpanel" data-testid={`session-panel-${tab}`}>
        {tab === 'summary' && (
          <>
            {/* Live operations at top so active work and thoughts are immediately visible */}
            {activity && (
              <div className="session-activity-status" data-testid="session-live-activity">
                <span className="session-activity-dot" aria-hidden="true" />
                <span>{activity}</span>
              </div>
            )}

            {/* Open while the agent is working, as its current focus; folded away once
                it has finished, because the same thought is already in the chat. */}
            {reasoning && (
              <details
                key={finished ? 'finished' : 'live'}
                className="agent-runtime-block session-reasoning"
                data-testid="session-reasoning"
                open={!finished}
              >
                <summary className="session-reasoning-header">
                  <span className="rail-sub">Reasoning</span>
                  <button
                    type="button"
                    className="btn btn-sm session-reasoning-copy"
                    data-testid="session-reasoning-copy"
                    onClick={copyReasoning}
                    title="Copy thought process"
                  >
                    <Icon name={copiedReasoning ? 'check' : 'copy'} size={12} />
                    <span>{copiedReasoning ? 'Copied' : 'Copy'}</span>
                  </button>
                </summary>
                <div className="session-reasoning-scroll">
                  <pre className="session-summary-text session-reasoning-text session-reasoning-body">{reasoning}</pre>
                </div>
              </details>
            )}

            {/* What the agent says it's doing, live */}
            <SessionTasks session={session} />

            {subagents.length > 0 && (
              <SessionSubagentsSummaryBlock
                subagents={subagents}
                onViewAll={() => setTab('subagents')}
                onSelectSession={onSelectSession}
              />
            )}

            {(session.workflowRunId || session.taskDefinition.workflow) && (
              <div className="agent-runtime-block session-workflow-context" data-testid="session-workflow-context">
                <span className="rail-sub">Governed workflow</span>
                <strong>{workflowRun?.workflowName ?? session.taskDefinition.workflow?.name ?? session.workflowId ?? 'Workflow run'}</strong>
                {session.workflowRunId && (
                  <p className="rail-sub">
                    Run {session.workflowRunId}
                    {session.workflowNodeId ? ` · ${session.workflowNodeId}` : ''}
                    {session.workflowRole ? ` · ${session.workflowRole}` : ''}
                  </p>
                )}
                {session.taskDefinition.workflow && (
                  <p className="rail-sub">
                    Pack: {session.taskDefinition.workflow.name}
                    {session.taskDefinition.workflow.version ? ` · v${session.taskDefinition.workflow.version}` : ''}
                    {session.taskDefinition.workflowProvenance?.fingerprint
                      ? ` · ${session.taskDefinition.workflowProvenance.fingerprint.slice(0, 12)}`
                      : ''}
                  </p>
                )}
              </div>
            )}
            {session.workflowRunId && (
              <WorkflowExecutionSummary
                run={workflowRun}
                currentNodeId={session.workflowNodeId}
                onOpenRun={onOpenWorkflowRun}
              />
            )}
            <SessionPurposeBlock session={session} />
            <SessionHandoverBrief session={session} />
            <SessionRuntimeHistory session={session} />

            {/* Everything on this tab is live state, so a finished session with
                no recorded plan has genuinely nothing to show. Saying so beats
                a blank pane, which reads as a failure to load. */}
            {!activity && !reasoning && !session.taskList?.length && !session.purpose && !session.handoverBrief && subagents.length === 0 && (
              <div className="empty-state" data-testid="session-summary-idle">
                <Icon name="check" size={24} />
                <span>
                  {finished
                    ? 'This session has finished. Its tool runs are under Activity and what it changed is under Changes.'
                    : 'Nothing to report yet — the agent has not said what it is doing.'}
                </span>
              </div>
            )}
          </>
        )}

        {tab === 'activity' && <SessionActivity session={session} />}

        {tab === 'subagents' && (
          <SessionSubagentsTab
            subagents={subagents}
            onSelectSession={onSelectSession}
          />
        )}

        {/* What the session did to the working tree, and what to do about it.
            Renders its own empty state when the folder is not a repository or
            is clean. */}
        {tab === 'changes' && <SessionChanges session={session} />}

        {tab === 'sessions' && (
          <SessionBrowser
            sessions={sessions}
            activeKey={session?.issueKey}
            onSelectSession={onSelectSession}
            onArchiveSession={onArchiveSession}
          />
        )}
      </div>

      <div className="inspector-actions">
        {!finished && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="session-abort-btn"
            onClick={() => void window.praxis.ai.abort(session.issueKey)}
          >
            <Icon name="close" size={13} /> Abort
          </button>
        )}
        {finished && session.worktreePath && (
          <button
            type="button"
            className="btn"
            data-testid="session-remove-worktree"
            disabled={busy}
            onClick={() => void removeWorktree()}
          >
            <Icon name="git-branch" size={13} /> {busy ? 'Removing…' : 'Remove worktree'}
          </button>
        )}
      </div>
      {error && <p className="hint is-danger">{error}</p>}
    </section>
  );
}

function WorkflowExecutionSummary({
  run,
  currentNodeId,
  onOpenRun
}: {
  run?: WorkflowRunSummary;
  currentNodeId?: string;
  onOpenRun?: (runId: string) => void;
}) {
  if (!run) {
    return (
      <div className="agent-runtime-block session-workflow-progress" data-testid="session-workflow-progress-loading">
        <span className="rail-sub">Workflow execution</span>
        <span className="placeholder-text">Loading current stage…</span>
      </div>
    );
  }

  const completed = run.stages.filter(stage => stage.outcome === 'succeeded' || stage.outcome === 'skipped').length;
  const active = run.stages.find(stage => stage.nodeId === currentNodeId)
    ?? run.stages.find(stage => stage.lane === 'running' || stage.lane === 'awaiting' || stage.lane === 'ready');
  const blockedGate = run.gates.find(gate => !['passed', 'bypassed'].includes(gate.state));

  return (
    <div className="agent-runtime-block session-workflow-progress" data-testid="session-workflow-progress">
      <div className="session-workflow-progress-heading">
        <span className="rail-sub">Workflow execution</span>
        <span className={`chip session-workflow-status session-workflow-status-${run.status}`}>{run.status}</span>
      </div>
      <div className="session-workflow-progress-track" aria-label={`${completed} of ${run.stages.length} workflow stages complete`}>
        <span style={{ width: `${run.stages.length ? Math.round((completed / run.stages.length) * 100) : 0}%` }} />
      </div>
      <p className="rail-sub session-workflow-progress-summary">
        {completed} of {run.stages.length} stages complete
        {active ? ` · ${active.name}: ${active.phase ?? (active.outcome === 'pending' ? active.lane : active.outcome)}` : ''}
      </p>
      {active && (
        <p className="session-workflow-current-activity" data-testid="session-workflow-current-activity">
          <strong>Now:</strong> {active.name} {active.phase ? `— ${active.phase}` : active.outcome === 'pending' ? `is ${active.lane}` : active.outcome}
        </p>
      )}
      {blockedGate && (
        <p className="session-workflow-gate" data-testid="session-workflow-blocked-gate">
          {blockedGate.gate} gate: {blockedGate.state}
        </p>
      )}
      <ol className="session-workflow-stage-list" aria-label="Workflow stages">
        {run.stages.map(stage => {
          const done = stage.outcome === 'succeeded' || stage.outcome === 'skipped';
          const current = stage.nodeId === currentNodeId || (!currentNodeId && stage === active);
          return (
            <li key={stage.nodeId} className={`${done ? 'is-done' : ''}${current ? ' is-current' : ''}`}>
              <span className="session-workflow-stage-marker" aria-hidden="true">{done ? '✓' : '·'}</span>
              <span className="session-workflow-stage-name">{stage.name}</span>
              <span className="rail-sub">{stage.phase ?? (stage.outcome === 'pending' ? stage.lane : stage.outcome)}</span>
            </li>
          );
        })}
      </ol>
      {onOpenRun && (
        <button
          type="button"
          className="btn btn-compact session-workflow-open-run"
          data-testid="session-workflow-open-run"
          onClick={() => onOpenRun(run.runId)}
        >
          Open full run
        </button>
      )}
    </div>
  );
}

/**
 * The Sessions tab of the session inspector: every session in the workspace,
 * split into active and archived groups. This is the management surface that
 * keeps archived sessions reachable once they leave the sidebar tree and
 * focus tabs — archive from a row here (or the sidebar), restore from here.
 * Rows deliberately mirror the sidebar tree's compact vocabulary (robot mark,
 * key, title, state dot, per-row actions) so the two read as one list.
 */
function SessionBrowser({
  sessions,
  activeKey,
  onSelectSession,
  onArchiveSession
}: {
  sessions: AgentSessionRecord[];
  activeKey?: string;
  onSelectSession?: (issueKey: string) => void;
  onArchiveSession?: (issueKey: string, archived: boolean) => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState<string>();
  const [error, setError] = useState<string>();
  // Archived rows start collapsed: archiving exists to get finished work out
  // of the way, so the default view answers "what is live?" first.
  const [archivedCollapsed, setArchivedCollapsed] = useState(true);

  const activeSessions = sessions.filter(session => !session.archived);
  const archivedSessions = sessions.filter(session => session.archived);

  const archive = async (session: AgentSessionRecord, archived: boolean) => {
    if (!onArchiveSession) return;
    setBusyKey(session.issueKey);
    setError(undefined);
    try {
      await onArchiveSession(session.issueKey, archived);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(undefined);
    }
  };

  return (
    <div className="session-browser" data-testid="session-browser">
      {error && <p className="hint is-danger" data-testid="session-browser-error">{error}</p>}
      <div className="session-browser-group" data-testid="session-browser-active">
        <div className="session-browser-heading">
          <span>Active</span>
          <span className="session-browser-count">{activeSessions.length}</span>
        </div>
        {activeSessions.length === 0 && (
          <span className="placeholder-text" data-testid="session-browser-active-empty">No active sessions</span>
        )}
        {activeSessions.map(session => (
          <SessionBrowserRow
            key={session.issueKey}
            session={session}
            active={session.issueKey === activeKey}
            busy={busyKey === session.issueKey}
            onSelect={onSelectSession}
            onArchive={onArchiveSession ? () => void archive(session, true) : undefined}
          />
        ))}
      </div>
      <div className="session-browser-group" data-testid="session-browser-archived">
        <button
          type="button"
          className="session-browser-heading session-browser-heading-toggle"
          aria-expanded={!archivedCollapsed}
          data-testid="session-browser-archived-toggle"
          onClick={() => setArchivedCollapsed(collapsed => !collapsed)}
        >
          <span className="tree-section-icon">
            <Icon name={archivedCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </span>
          <span>Archived</span>
          <span className="session-browser-count">{archivedSessions.length}</span>
        </button>
        {!archivedCollapsed && archivedSessions.length === 0 && (
          <span className="placeholder-text" data-testid="session-browser-archived-empty">
            Archived sessions are kept here — archive a session from its row to tidy the sidebar.
          </span>
        )}
        {!archivedCollapsed && archivedSessions.map(session => (
          <SessionBrowserRow
            key={session.issueKey}
            session={session}
            active={session.issueKey === activeKey}
            busy={busyKey === session.issueKey}
            onSelect={onSelectSession}
            onArchive={onArchiveSession ? () => void archive(session, false) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/** One session row in the browser: select it, or archive/restore it. */
function SessionBrowserRow({
  session,
  active,
  busy,
  onSelect,
  onArchive
}: {
  session: AgentSessionRecord;
  active: boolean;
  busy: boolean;
  onSelect?: (issueKey: string) => void;
  onArchive?: () => void;
}) {
  const title = sessionTitle(session);
  return (
    <div
      className={`session-browser-row${active ? ' active' : ''}${session.archived ? ' is-archived' : ''}`}
      data-testid="session-browser-row"
      role="button"
      tabIndex={0}
      title={title}
      onClick={() => onSelect?.(session.issueKey)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(session.issueKey);
        }
      }}
    >
      <span className="tree-icon">
        <Icon name="robot" size={14} />
      </span>
      <span className="session-browser-main">
        <span className="session-browser-title">{title}</span>
        <span className="session-browser-meta">{session.issueKey}</span>
      </span>
      {!session.archived && (
        <span
          className={agentStateLaneClass(session.state)}
          role="img"
          aria-label={`Status: ${agentStateLabel(session.state)}`}
          title={agentStateLabel(session.state)}
        >
          ●
        </span>
      )}
      {session.archived && (
        <span className="tree-badge">Archived</span>
      )}
      {onArchive && (
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={`${session.archived ? 'Restore' : 'Archive'} session ${title}`}
          title={session.archived ? 'Restore this session' : 'Archive this session'}
          data-testid={session.archived ? 'session-restore-btn' : 'session-archive-btn'}
          disabled={busy}
          onClick={event => {
            event.stopPropagation();
            onArchive();
          }}
        >
          <Icon name={session.archived ? 'refresh' : 'archive'} size={12} />
        </button>
      )}
    </div>
  );
}
