import { useState } from 'react';
import type { AgentSessionRecord, SessionMode } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { agentStateBadgeClass, agentStateLabel, isTerminalAgentState } from './aiSessionState';
import { PROVIDER_LABELS, providerIconName } from './modelProviders';
import { basename, formatStarted, isWorkflowStageSession, sessionMode, toolModeLabel } from './sessionNav';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!session) {
    return (
      <div className="empty-state" data-testid="session-inspector-empty">
        <Icon name="robot" size={26} />
        <span>Select a session to see its context.</span>
      </div>
    );
  }

  const finished = isTerminalAgentState(session.state);

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

  const removeWorktree = () => {
    if (!session.worktreePath) return;
    if (!window.confirm(`Remove the git worktree for this session?\n\n${session.worktreePath}\n\nThe branch ${session.worktreeBranch ?? ''} and its checkout are deleted.`)) {
      return;
    }
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
          <p className="rail-sub">
            {formatStarted(session.startedAt)} · {session.stepCount} {session.stepCount === 1 ? 'step' : 'steps'}
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
            onClick={removeWorktree}
          >
            <Icon name="git-branch" size={13} /> {busy ? 'Removing…' : 'Remove worktree'}
          </button>
        )}
      </div>
      {error && <p className="hint is-danger">{error}</p>}
    </section>
  );
}
