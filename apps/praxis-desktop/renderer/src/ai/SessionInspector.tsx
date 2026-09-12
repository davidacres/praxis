import { useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { agentStateBadgeClass, agentStateLabel, isTerminalAgentState } from './aiSessionState';
import { SessionChanges } from './SessionChanges';
import { SessionTasks } from './SessionTasks';
import { formatCost, formatElapsed, formatStarted, formatTokens, lastMessagePreview, liveActivity, reasoningSnippet, sessionMode } from './sessionNav';

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
 * Mirrors `AgentRuntimePanel`, which does the same job for the `agents` route.
 */

export interface SessionInspectorProps {
  session?: AgentSessionRecord;
}

export function SessionInspector({ session }: SessionInspectorProps) {
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
  const lastMessage = lastMessagePreview(session);
  const reasoning = reasoningSnippet(session);

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
    <section className="inspector agent-runtime" aria-label="Session context" data-testid="session-inspector">
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

      {/* What the agent says it's doing, live — stays put here while the
          transcript in the centre pane keeps scrolling past it. */}
      <SessionTasks session={session} />

      {/* Same "don't scroll away" reasoning as the task list above: the
          console shows its own copy of the activity line, but that one sits
          at the bottom of the scrolling transcript. */}
      {activity && (
        <div className="session-activity-status" data-testid="session-live-activity">
          <span className="session-activity-dot" aria-hidden="true" />
          <span>{activity}</span>
        </div>
      )}

      {lastMessage && (
        <div className="agent-runtime-block session-last-message" data-testid="session-last-message">
          <span className="rail-sub">Last message</span>
          <p className="session-summary-text">{lastMessage}</p>
        </div>
      )}

      {reasoning && (
        <div className="agent-runtime-block session-reasoning" data-testid="session-reasoning">
          <span className="rail-sub">Reasoning</span>
          <p className="session-summary-text session-reasoning-text">{reasoning}</p>
        </div>
      )}

      {/* What the session did to the working tree, and what to do about it.
          Renders nothing when the folder is not a repository or is clean —
          note the divider that sets it apart from the summary above lives on
          its own root element for exactly that reason (see SessionChanges.tsx),
          so no orphan rule shows up when there's nothing to divide.
          Collapsed by default (persisted) — reviewing changes is a deliberate
          step after the chat summary above, not something to scroll past. */}
      <SessionChanges session={session} />

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
