import React, { useState, useEffect, useMemo } from 'react';
import type { AgentSessionRecord, ProjectRecord, GitStatusSnapshot, AppSettings, AppSettingsPatch } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { sessionTitle, formatStarted } from '../ai/sessionNav';
import { isTerminalAgentState, agentStateLabel } from '../ai/aiSessionState';
import { applyThemePreference } from '../settings/themes';

export interface EasyModeCanvasProps {
  project?: ProjectRecord;
  sessions: AgentSessionRecord[];
  settings?: AppSettings;
  updateSettings: (patch: AppSettingsPatch) => Promise<void>;
  onStartSession: (goal?: string) => void;
  onSelectSession: (sessionKey: string) => void;
  onOpenFolder?: () => void;
  onOpenGit?: () => void;
  onOpenAutomations?: () => void;
  onOpenSessions?: () => void;
}

const STARTER_PROMPTS = [
  {
    icon: 'search' as const,
    label: 'Explain codebase',
    prompt: 'Explain the architecture and codebase structure of this project'
  },
  {
    icon: 'git-branch' as const,
    label: 'Review git changes',
    prompt: 'Review current git changes, inspect modified files, and propose improvements'
  },
  {
    icon: 'check-square' as const,
    label: 'Run test suite',
    prompt: 'Run the project test suite and investigate any test failures'
  },
  {
    icon: 'zap' as const,
    label: 'Quick bugfix',
    prompt: 'Investigate and fix any issues or errors in the codebase'
  }
];

export function EasyModeCanvas({
  project,
  sessions,
  settings,
  updateSettings,
  onStartSession,
  onSelectSession,
  onOpenFolder,
  onOpenGit,
  onOpenAutomations,
  onOpenSessions
}: EasyModeCanvasProps) {
  const [promptText, setPromptText] = useState('');
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);

  // Fetch git status if project has a workspaceFolder
  useEffect(() => {
    let cancelled = false;
    if (!project?.workspaceFolder || !window.praxis?.git?.status) {
      setGitStatus(null);
      return;
    }

    setGitLoading(true);
    window.praxis.git.status(project.workspaceFolder)
      .then((status: GitStatusSnapshot) => {
        if (!cancelled) {
          setGitStatus(status);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitStatus(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setGitLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project?.workspaceFolder]);

  // Project-relevant sessions
  const projectSessions = useMemo(() => {
    if (!project) return sessions;
    const keys = new Set(project.workItems.map(item => item.key));
    return sessions.filter(s =>
      keys.has(s.issueKey) ||
      Boolean(project.workspaceFolder && s.workingDirectory === project.workspaceFolder)
    );
  }, [project, sessions]);

  const activeSessions = useMemo(() => {
    return projectSessions.filter(s => !isTerminalAgentState(s.state));
  }, [projectSessions]);

  const recentSessions = useMemo(() => {
    return [...projectSessions]
      .sort((a, b) => (new Date(b.startedAt).getTime() || 0) - (new Date(a.startedAt).getTime() || 0))
      .slice(0, 4);
  }, [projectSessions]);

  const isSimpleTheme = settings?.appearance?.themeId === 'simple';

  const handleToggleSimpleTheme = () => {
    const targetTheme = isSimpleTheme ? 'praxis-dark' : 'simple';
    applyThemePreference(targetTheme, 'dark');
    void updateSettings({
      appearance: {
        themeId: targetTheme,
        themeMode: 'dark'
      }
    });
  };

  const handleLaunchPrompt = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = promptText.trim();
    onStartSession(trimmed || undefined);
  };

  const handleStarterClick = (prompt: string) => {
    setPromptText(prompt);
    onStartSession(prompt);
  };

  // Extract compact path display
  const folderPath = project?.workspaceFolder || '';
  const displayFolder = folderPath.length > 50 ? `…${folderPath.slice(-48)}` : folderPath;
  const projectName = project?.name || 'Workspace';

  return (
    <main className="easymode-canvas" data-testid="easymode-canvas">
      {/* Hero Header */}
      <header className="easymode-canvas__header">
        <div className="easymode-canvas__title-area">
          <div className="easymode-canvas__badge-group">
            <span className="easymode-badge easymode-badge--accent">
              <Icon name="sparkles" size={12} /> EasyMode
            </span>
            {project?.type && (
              <span className="easymode-badge easymode-badge--subtle">
                {project.type}
              </span>
            )}
          </div>
          <h1 className="easymode-canvas__title">{projectName}</h1>
          {displayFolder ? (
            <p className="easymode-canvas__path" title={folderPath}>
              <Icon name="folder" size={13} />
              <span>{displayFolder}</span>
            </p>
          ) : (
            <p className="easymode-canvas__path">
              <span>Open a folder or start with an AI agent below.</span>
            </p>
          )}
        </div>

        {/* Status Chips Row */}
        <div className="easymode-canvas__chips">
          {project?.workspaceFolder ? (
            <button
              type="button"
              className="easymode-chip"
              onClick={onOpenGit}
              title="Open Git changes"
              data-testid="easymode-chip-git"
            >
              <Icon name="git-branch" size={13} />
              <span>
                {gitLoading ? 'Checking git…' : (
                  gitStatus
                    ? `${gitStatus.branch || 'HEAD'} · ${gitStatus.files.length === 0 ? 'Clean' : `${gitStatus.files.length} changed`}`
                    : 'Git'
                )}
              </span>
            </button>
          ) : onOpenFolder ? (
            <button
              type="button"
              className="easymode-chip"
              onClick={onOpenFolder}
              title="Open a folder"
              data-testid="easymode-chip-open-folder"
            >
              <Icon name="folder" size={13} />
              <span>Open Folder</span>
            </button>
          ) : null}

          <button
            type="button"
            className="easymode-chip"
            onClick={onOpenSessions}
            title="View all sessions"
            data-testid="easymode-chip-sessions"
          >
            <Icon name="robot" size={13} />
            <span>
              {activeSessions.length > 0
                ? `${activeSessions.length} active agent${activeSessions.length > 1 ? 's' : ''}`
                : `${projectSessions.length} session${projectSessions.length !== 1 ? 's' : ''}`}
            </span>
          </button>

          <button
            type="button"
            className={`easymode-chip easymode-chip--theme ${isSimpleTheme ? 'is-active' : ''}`}
            onClick={handleToggleSimpleTheme}
            title={isSimpleTheme ? 'Simple Dark theme active (click to revert)' : 'Switch to Orca-inspired Simple dark theme'}
            data-testid="easymode-chip-theme"
          >
            <Icon name="theme" size={13} />
            <span>{isSimpleTheme ? 'Simple Dark Active' : 'Switch to Simple Dark'}</span>
          </button>
        </div>
      </header>

      {/* Prompt Composer Hero */}
      <section className="easymode-composer-card" aria-label="AI Prompt Composer">
        <form onSubmit={handleLaunchPrompt} className="easymode-composer-form">
          <div className="easymode-composer-input-wrap">
            <textarea
              className="easymode-composer-textarea"
              placeholder="What do you want to build, debug, or explore in this folder?"
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleLaunchPrompt();
                }
              }}
              rows={3}
              data-testid="easymode-prompt-input"
            />
          </div>

          <div className="easymode-composer-footer">
            <div className="easymode-starter-chips">
              {STARTER_PROMPTS.map(starter => (
                <button
                  key={starter.label}
                  type="button"
                  className="easymode-starter-chip"
                  onClick={() => handleStarterClick(starter.prompt)}
                  data-testid={`easymode-starter-${starter.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <Icon name={starter.icon} size={12} />
                  <span>{starter.label}</span>
                </button>
              ))}
            </div>

            <div className="easymode-composer-actions">
              <button
                type="submit"
                className="btn btn-primary easymode-launch-btn"
                data-testid="easymode-launch-btn"
              >
                <Icon name="sparkles" size={14} />
                <span>Start Agent</span>
              </button>
            </div>
          </div>
        </form>
      </section>

      {/* Recent Sessions & Fast Actions Grid */}
      <div className="easymode-canvas__grid">
        {/* Recent Sessions Card */}
        <section className="easymode-card" aria-label="Recent Sessions">
          <div className="easymode-card__head">
            <div className="easymode-card__title-row">
              <Icon name="chats" size={14} />
              <h2>Recent Sessions</h2>
            </div>
            {projectSessions.length > 0 && onOpenSessions && (
              <button
                type="button"
                className="btn-quiet"
                onClick={onOpenSessions}
                data-testid="easymode-view-all-sessions"
              >
                View all
              </button>
            )}
          </div>

          {recentSessions.length === 0 ? (
            <div className="easymode-card__empty">
              <p>No AI sessions in this folder yet. Use the prompt hero above to start one.</p>
            </div>
          ) : (
            <div className="easymode-recent-list">
              {recentSessions.map(session => {
                const title = sessionTitle(session);
                const isRunning = !isTerminalAgentState(session.state);
                return (
                  <div
                    key={session.issueKey}
                    className="easymode-recent-item"
                    onClick={() => onSelectSession(session.issueKey)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectSession(session.issueKey);
                      }
                    }}
                    data-testid={`easymode-recent-session-${session.issueKey}`}
                  >
                    <span
                      className={`easymode-status ${isRunning ? 'easymode-status--running' : 'easymode-status--idle'}`}
                      aria-label={`Status: ${agentStateLabel(session.state)}`}
                    />
                    <div className="easymode-recent-item__details">
                      <span className="easymode-recent-item__title" title={title}>
                        {title}
                      </span>
                      <span className="easymode-recent-item__meta">
                        {agentStateLabel(session.state)} · {session.stepCount} steps
                      </span>
                    </div>
                    {session.startedAt && (
                      <span className="easymode-recent-item__time">
                        {formatStarted(session.startedAt)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Quick Tools & Automations Card */}
        <section className="easymode-card" aria-label="Quick Actions">
          <div className="easymode-card__head">
            <div className="easymode-card__title-row">
              <Icon name="sliders" size={14} />
              <h2>Quick Actions</h2>
            </div>
          </div>

          <div className="easymode-tools-grid">
            {onOpenGit && (
              <button
                type="button"
                className="easymode-tool-card"
                onClick={onOpenGit}
                data-testid="easymode-tool-git"
              >
                <div className="easymode-tool-card__icon">
                  <Icon name="git-branch" size={18} />
                </div>
                <div className="easymode-tool-card__info">
                  <strong>Git Changes & History</strong>
                  <span>Review staged changes, branches, and diffs</span>
                </div>
              </button>
            )}

            {onOpenAutomations && (
              <button
                type="button"
                className="easymode-tool-card"
                onClick={onOpenAutomations}
                data-testid="easymode-tool-automations"
              >
                <div className="easymode-tool-card__icon">
                  <Icon name="play" size={18} />
                </div>
                <div className="easymode-tool-card__info">
                  <strong>Automations & Workflows</strong>
                  <span>Run governed multistep delivery pipelines</span>
                </div>
              </button>
            )}

            <button
              type="button"
              className="easymode-tool-card"
              onClick={handleToggleSimpleTheme}
              data-testid="easymode-tool-theme"
            >
              <div className="easymode-tool-card__icon">
                <Icon name="theme" size={18} />
              </div>
              <div className="easymode-tool-card__info">
                <strong>{isSimpleTheme ? 'Revert Theme' : 'Simple Dark Theme'}</strong>
                <span>Orca-inspired high contrast charcoal theme</span>
              </div>
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
