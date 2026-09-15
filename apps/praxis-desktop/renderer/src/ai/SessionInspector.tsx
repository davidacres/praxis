import { useEffect, useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { agentStateBadgeClass, agentStateLabel, isTerminalAgentState } from './aiSessionState';
import { SessionChanges } from './SessionChanges';
import { SessionHandoverBrief, SessionPurposeBlock, SessionRuntimeHistory } from './SessionHandover';
import { SessionTasks } from './SessionTasks';
import { SessionActivity } from './SessionActivity';
import { failedToolCount, formatCost, formatElapsed, formatStarted, formatTokens, liveActivity, reasoningSnippet, sessionMode } from './sessionNav';

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
}

type InspectorTab = 'summary' | 'activity' | 'changes';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' }
];

export function SessionInspector({ session }: SessionInspectorProps) {
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<InspectorTab>('summary');

  // Switching session resets to Summary. Keeping the previous tab would land
  // you on another session's Activity with no idea why you are looking at it.
  const sessionId = session?.sessionId;
  useEffect(() => setTab('summary'), [sessionId]);

  if (!session) {
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

      <div className="inspector-tabs" role="tablist" aria-label="Session detail">
        {TABS.map(entry => (
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
            <SessionPurposeBlock session={session} />
            <SessionHandoverBrief session={session} />
            <SessionRuntimeHistory session={session} />
            {/* What the agent says it's doing, live — stays put here while the
                transcript in the centre pane keeps scrolling past it. */}
            <SessionTasks session={session} />

            {/* Same "don't scroll away" reasoning as the task list above: the
                console shows its own copy of the activity line, but that one
                sits at the bottom of the scrolling transcript. */}
            {activity && (
              <div className="session-activity-status" data-testid="session-live-activity">
                <span className="session-activity-dot" aria-hidden="true" />
                <span>{activity}</span>
              </div>
            )}

            {reasoning && (
              <div className="agent-runtime-block session-reasoning" data-testid="session-reasoning">
                <span className="rail-sub">Reasoning</span>
                <p className="session-summary-text session-reasoning-text">{reasoning}</p>
              </div>
            )}

            {/* Everything on this tab is live state, so a finished session with
                no recorded plan has genuinely nothing to show. Saying so beats
                a blank pane, which reads as a failure to load. */}
            {!activity && !reasoning && !session.taskList?.length && !session.purpose && !session.handoverBrief && (
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

        {/* What the session did to the working tree, and what to do about it.
            Renders its own empty state when the folder is not a repository or
            is clean. */}
        {tab === 'changes' && <SessionChanges session={session} />}
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
