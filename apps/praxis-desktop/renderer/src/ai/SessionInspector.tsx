import { useState } from 'react';
import type { AgentSessionRecord, SessionMode } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { useDialogs } from '../ui/dialogs';
import { agentStateBadgeClass, agentStateLabel, isTerminalAgentState } from './aiSessionState';
import { PROVIDER_LABELS, providerIconName } from './modelProviders';
import { SessionChanges } from './SessionChanges';
import { basename, contextPressure, formatElapsed, formatStarted, formatTokens, isWorkflowStageSession, sessionMode, toolModeLabel } from './sessionNav';

/**
 * Sessions runtime panel — the shell's right pane for the `sessions` route.
 *
 * Answers "what is this session and what can I do to it?": live state, the
 * facts fixed when it started (provider, model, tool access, folder, worktree),
 * and every action that changes it. The centre pane stays the conversation.
 *
 * Mirrors `AgentRuntimePanel`, which does the same job for the `agents` route.
 */

export interface SessionInspectorProps {
  session?: AgentSessionRecord;
}

/**
 * Switching mode is not just a flag: the session is told, in its own thread,
 * what the new mode means. These are the prompts the console used to send.
 */
const MODE_TRANSITION: Record<SessionMode, string> = {
  analysis:
    'Switch this conversation into Analysis mode. Inspect the relevant ticket and workspace read-only, then return a concrete analysis and implementation plan. Do not make changes.',
  review:
    'Switch this conversation into Review mode. Review the relevant ticket, workspace, and current implementation read-only, then report findings, risks, and actionable recommendations. Do not make changes.',
  chat:
    'Switch this conversation into Chat mode. Answer my next requests directly and do not inspect or modify tickets unless I explicitly ask.'
};

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="agent-runtime-line">
      <span className="rail-sub">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function SessionInspector({ session }: SessionInspectorProps) {
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!session) {
    return (
      <div className="empty-state" data-testid="session-inspector-empty">
        <Icon name="robot" size={26} />
        <span>A session&rsquo;s provider, tools, and worktree appear here.</span>
      </div>
    );
  }

  const finished = isTerminalAgentState(session.state);
  const elapsed = formatElapsed(session.startedAt, session.completedAt);
  // Only providers that report usage have a token figure. A CLI-hosted agent
  // runs on its own account and reports none, so its sessions show duration and
  // steps alone rather than a zero that would read as "this was free".
  const tokens = formatTokens(session.tokenUsage);
  const context = contextPressure(session);

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

  const switchMode = (mode: SessionMode) => {
    if (mode === (session.mode ?? 'chat') || !finished) return;
    void run(async () => {
      await window.praxis.ai.switchSessionMode(session.issueKey, mode);
      await window.praxis.ai.continueSession(session.issueKey, MODE_TRANSITION[mode]);
    });
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
          </p>
        </div>
      </div>

      {/* Fixed for the session's life — the same facts the New Session composer
          asks for, read back as the record of what this session actually got. */}
      <div className="agent-runtime-block">
        {session.provider && (
          <Line label="Provider">
            <span data-testid="session-provider">
              <Icon name={providerIconName(session.provider)} size={13} /> {PROVIDER_LABELS[session.provider]}
            </span>
          </Line>
        )}
        {session.model && <Line label="Model"><span data-testid="session-model">{session.model}</span></Line>}
        <Line label="Tool access">
          <span data-testid="session-tool-mode">
            <Icon name={session.toolMode === 'full' ? 'tools' : 'search'} size={13} /> {toolModeLabel(session.toolMode)}
          </span>
        </Line>
        {session.workingDirectory && (
          <Line label="Folder">
            <span data-testid="session-working-directory" title={session.workingDirectory}>
              {basename(session.workingDirectory)}
            </span>
          </Line>
        )}
        {session.worktreeBranch && (
          <Line label="Worktree">
            <span data-testid="session-worktree" title={session.worktreePath}>
              {session.worktreeBranch}
              {session.worktreeBaseBranch && (
                <span className="session-worktree-base"> from {session.worktreeBaseBranch}</span>
              )}
            </span>
          </Line>
        )}
      </div>

      {/* How much of the model's window the next turn will start from. Shown
          only once it matters — a mostly-empty context is not news. */}
      {context && context.level !== 'ok' && (
        <div className="agent-runtime-block session-context" data-testid="session-context">
          <div className="session-context-heading">
            <span className="rail-sub">Context</span>
            <span className={`session-context-figure is-${context.level}`} data-testid="session-context-figure">
              {context.percent}% of {Math.round(context.limit / 1000)}k
            </span>
          </div>
          <div
            className={`session-context-bar is-${context.level}`}
            role="progressbar"
            aria-valuenow={context.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Context window used"
          >
            <span style={{ width: `${context.percent}%` }} />
          </div>
          <p className="hint">
            {context.level === 'critical'
              ? 'The next turn may not fit. Start a fresh session to carry on with a clean context.'
              : 'This conversation is filling the model’s window. Long tool output is the usual cause.'}
          </p>
        </div>
      )}

      {/* What the session did to the working tree, and what to do about it.
          Renders nothing when the folder is not a repository or is clean. */}
      <SessionChanges session={session} />

      {/* A finished session can be re-run in a different mode; a live one can
          only be stopped. */}
      {finished && !isWorkflowStageSession(session) && (
        <div className="agent-runtime-block">
          <span className="rail-sub">Continue as</span>
          <div className="session-mode-switch" role="group" aria-label="Switch session mode">
            {(['chat', 'analysis', 'review'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                className={session.mode === mode || (!session.mode && mode === 'chat') ? 'active' : ''}
                disabled={busy}
                onClick={() => switchMode(mode)}
                data-testid={`session-switch-mode-${mode}`}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}

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
