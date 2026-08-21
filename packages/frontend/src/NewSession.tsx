import { useState } from 'react';
import { Icon } from './Icon';

export interface NewSessionProps {
  workspaceName: string;
  agentName: string;
  branchName: string;
  onSubmit: (goal: string) => void;
  /**
   * Number of configured tracker connections. Zero means every board on screen
   * comes from the built-in demo backend, which is worth saying out loud before
   * someone starts a session against throwaway data.
   */
  connectionCount: number;
  onOpenConnections: () => void;
}

/**
 * The default centre view. Laid out against the reference chrome: a muted
 * sentence with inline chips, then a single composer card whose first row is the
 * notice, then the borderless run-options row split left/right.
 */
export function NewSession({
  workspaceName,
  agentName,
  branchName,
  onSubmit,
  connectionCount,
  onOpenConnections
}: NewSessionProps) {
  const [goal, setGoal] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const noticeVisible = connectionCount === 0 && !dismissed;

  const submit = () => {
    const trimmed = goal.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setGoal('');
  };

  return (
    <div className="session-view" data-testid="new-session-view">
      <div className="session-inner">
        <h1 className="session-heading">
          New session in{' '}
          <button className="heading-chip">
            <Icon name="folder" size={17} />
            {workspaceName}
            <Icon name="chevron-down" size={14} />
          </button>{' '}
          with{' '}
          <button className="heading-chip">
            <Icon name="robot" size={17} />
            {agentName}
            <Icon name="chevron-down" size={14} />
          </button>
        </h1>

        <div className="composer">
          {noticeVisible && (
            <div className="composer-notice" role="status">
              <span className="composer-notice-icon">
                <Icon name="info" size={15} />
              </span>
              <div className="composer-notice-body">
                <div className="composer-notice-title">No tracker connected</div>
                <div className="composer-notice-text">
                  You're working against the built-in demo boards. Add a Jira, GitLab, or Live
                  Folder connection to run sessions on real issues.{' '}
                  <button className="notice-link" onClick={onOpenConnections}>
                    Open Connections
                  </button>
                </div>
              </div>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="Dismiss notice"
                onClick={() => setDismissed(true)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}

          <textarea
            className="composer-input"
            placeholder="What's the goal?"
            value={goal}
            rows={2}
            onChange={event => setGoal(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />

          <div className="composer-controls">
            <button className="composer-chip" aria-label="Attach">
              <Icon name="plus" size={16} />
            </button>
            <button className="composer-chip">
              <Icon name="pencil" size={14} />
              Agent
            </button>
            <button className="composer-chip">
              <Icon name="robot" size={14} />
              Auto
            </button>
            <span className="spacer" />
            <button className="composer-chip" aria-label="Dictate">
              <Icon name="mic" size={15} />
            </button>
            <button
              className="composer-send"
              aria-label="Start session"
              disabled={!goal.trim()}
              onClick={submit}
            >
              <Icon name="arrow-up" size={15} />
            </button>
          </div>
        </div>

        <div className="session-footer">
          <button className="footer-chip">
            <Icon name="chats" size={14} />
            Interactive
          </button>
          <button className="footer-chip">
            <Icon name="shield" size={14} />
            Manual permissions
          </button>
          <span className="spacer" />
          <button className="footer-chip">
            <Icon name="check-square" size={14} />
            New Worktree
          </button>
          <button className="footer-chip">
            <Icon name="git-branch" size={14} />
            {branchName}
          </button>
        </div>
      </div>
    </div>
  );
}
