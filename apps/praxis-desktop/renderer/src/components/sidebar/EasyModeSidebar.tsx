import React, { useState, useMemo, useEffect } from 'react';
import type { AgentSessionRecord, GitStatusSnapshot, WorkflowRunSummary, ProjectRecord } from '@praxis/core';
import { SectionHeader } from './SectionHeader';
import { EasyModeSessionsList } from './EasyModeSessionsList';
import { EasyModeAutomationsList } from './EasyModeAutomationsList';
import { Icon } from '../../ui/Icon';

export interface EasyModeSidebarProps {
  sessions: AgentSessionRecord[];
  allSessions?: AgentSessionRecord[];
  activeSessionKey?: string;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
  onNewSession: () => void;
  onAbortSession?: (sessionKey: string) => void;
  onDeleteSession?: (sessionKey: string) => void;
  onRenameSession?: (sessionKey: string, title: string) => Promise<void>;
  onArchiveSession?: (sessionKey: string, archived: boolean) => Promise<void>;
  projects: ProjectRecord[];
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  activeWorkflowRunId?: string;
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onNewWorkflowRun: () => void;
  onRerunWorkflowRun?: (project: ProjectRecord, run: WorkflowRunSummary) => void;
  onRenameWorkflowRun?: (run: WorkflowRunSummary, name: string) => Promise<void>;
  onArchiveWorkflowRun?: (run: WorkflowRunSummary, archived: boolean) => Promise<void>;
  onDeleteWorkflowRun?: (run: WorkflowRunSummary) => Promise<void>;
  /** Workflows that can be started from the runs launchpad. */
  runnableWorkflows?: Array<{ id: string; name: string }>;
  /** Opens the start-run dialog with this workflow preselected. */
  onStartWorkflow?: (workflowId: string) => void;
  renderSessionsContent?: () => React.ReactNode;
  renderAutomationsContent?: () => React.ReactNode;
}

/**
 * EasyMode Sidebar: The artisan peripheral workspace sidebar.
 * Features the Horizon workspace anchor, micro filter rail, and symmetrical Sessions & Runs pipelines.
 */
export function EasyModeSidebar({
  sessions,
  allSessions,
  activeSessionKey,
  activeAgentId,
  onSelectSession,
  onSelectAgent,
  onNewSession,
  onAbortSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  projects,
  runsByProjectId,
  activeWorkflowRunId,
  onSelectWorkflowRun,
  onNewWorkflowRun,
  onRerunWorkflowRun,
  onRenameWorkflowRun,
  onArchiveWorkflowRun,
  onDeleteWorkflowRun,
  runnableWorkflows,
  onStartWorkflow,
  renderSessionsContent,
  renderAutomationsContent
}: EasyModeSidebarProps) {
  const [filterTab, setFilterTab] = useState<'all' | 'live' | 'gates'>('all');
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);

  const activeProject = projects[0];
  const workspaceFolder = activeProject?.workspaceFolder;

  // Real repository state for the Horizon badge. No repo → no badge, never a guess.
  useEffect(() => {
    let cancelled = false;
    if (!workspaceFolder || !window.praxis?.git?.status) { setGitStatus(null); return; }
    window.praxis.git.status(workspaceFolder)
      .then((status: GitStatusSnapshot) => { if (!cancelled) setGitStatus(status); })
      .catch(() => { if (!cancelled) setGitStatus(null); });
    return () => { cancelled = true; };
  }, [workspaceFolder, sessions.length]);

  // Aggregate total active/recent workflow runs across all projects
  const allRuns = useMemo(() => {
    const list: Array<{ project: ProjectRecord; run: WorkflowRunSummary }> = [];
    for (const project of projects) {
      const runs = runsByProjectId[project.id] ?? [];
      for (const run of runs) {
        if (!run.archived) {
          list.push({ project, run });
        }
      }
    }
    return list;
  }, [projects, runsByProjectId]);

  const rootSessions = useMemo(() => {
    return sessions.filter(s => !s.parentSessionKey && !s.workflowRunId);
  }, [sessions]);

  // Counts for filter rail tabs
  const { allCount, liveCount, gateCount } = useMemo(() => {
    const total = rootSessions.length + allRuns.length;
    const live = rootSessions.filter(
      s => s.state === 'executing' || s.state === 'planning' || s.state === 'awaiting_approval' || s.state === 'awaiting_input'
    ).length + allRuns.filter(r => r.run.status === 'running' || r.run.status === 'awaiting-approval').length;
    const gates = rootSessions.filter(
      s => s.state === 'awaiting_approval' || s.state === 'awaiting_input'
    ).length + allRuns.filter(
      r => r.run.status === 'awaiting-approval' || r.run.stages?.some(st => st.lane === 'awaiting')
    ).length;

    return { allCount: total, liveCount: live, gateCount: gates };
  }, [rootSessions, allRuns]);

  return (
    <aside className="easymode-sidebar" data-testid="easymode-sidebar" aria-label="EasyMode Workspace Sidebar">
      {/* Horizon Bar: Workspace Anchor */}
      <div className="horizon-bar">
        <div className="horizon-row-main">
          <div className="workspace-title-wrap" title={activeProject?.name || 'Workspace'}>
            <Icon name="folder" size={14} className="workspace-folder-icon" />
            <span>{activeProject?.name || 'Workspace'}</span>
          </div>
          <button
            type="button"
            className="btn-new-session-compact"
            onClick={onNewSession}
            title="Create new session (⌘N)"
            aria-label="Create new session"
          >
            <Icon name="plus" size={11} />
            <span>New</span>
            <kbd>⌘N</kbd>
          </button>
        </div>
        {gitStatus && (
          <div className="horizon-row-sub">
            <div
              className={`git-status-tag${gitStatus.files.length > 0 ? ' is-dirty' : ''}`}
              data-testid="easymode-git-status"
              title={gitStatus.repositoryPath}
            >
              <span className="git-clean-dot" />
              <span>
                {gitStatus.branch || 'HEAD'} · {gitStatus.files.length === 0 ? 'clean' : `${gitStatus.files.length} changed`}
                {gitStatus.ahead > 0 ? ` · ↑${gitStatus.ahead}` : ''}
                {gitStatus.behind > 0 ? ` · ↓${gitStatus.behind}` : ''}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Micro Filter Rail */}
      <div className="filter-rail" role="tablist" aria-label="Filter sidebar items">
        <div className="filter-tabs">
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'all'}
            className={`filter-tab ${filterTab === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            <span>All</span>
            <span className="filter-count">{allCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'live'}
            className={`filter-tab ${filterTab === 'live' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('live')}
          >
            <span>Live</span>
            <span className="filter-count">{liveCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterTab === 'gates'}
            className={`filter-tab ${filterTab === 'gates' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('gates')}
          >
            <span>Gates</span>
            <span className="filter-count">{gateCount}</span>
          </button>
        </div>
      </div>

      {/* Sidebar Feed Container */}
      <div className="easymode-sidebar-feed">
        {/* Sessions Section */}
        <section className="easymode-section" aria-label="Sessions">
          <SectionHeader
            title="Sessions"
            count={rootSessions.length}
            onAdd={onNewSession}
            addAriaLabel="Create new session"
            testId="section-header-add-sessions"
          />
          <div className="easymode-section__body">
            {renderSessionsContent ? renderSessionsContent() : (
              <EasyModeSessionsList
                sessions={sessions}
                allSessions={allSessions}
                selectedSessionKey={activeSessionKey}
                activeAgentId={activeAgentId}
                filterTab={filterTab}
                onSelectSession={onSelectSession}
                onSelectAgent={onSelectAgent}
                onNewSession={onNewSession}
                onAbortSession={onAbortSession}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
              />
            )}
          </div>
        </section>

        {/* Runs Section (Structured Workflows) */}
        <section className="easymode-section" aria-label="Runs">
          <SectionHeader
            title="Runs"
            count={allRuns.length}
            onAdd={onNewWorkflowRun}
            addAriaLabel="Create new run"
            testId="section-header-add-automations"
            containerTestId="section-header-automations"
          />
          <div className="easymode-section__body">
            {renderAutomationsContent ? renderAutomationsContent() : (
              <EasyModeAutomationsList
                projects={projects}
                runsByProjectId={runsByProjectId}
                activeWorkflowRunId={activeWorkflowRunId}
                allSessions={allSessions}
                filterTab={filterTab}
                onSelectSession={onSelectSession}
                onSelectWorkflowRun={onSelectWorkflowRun}
                onNewWorkflowRun={onNewWorkflowRun}
                onRerunWorkflowRun={onRerunWorkflowRun}
                onRenameWorkflowRun={onRenameWorkflowRun}
                onArchiveWorkflowRun={onArchiveWorkflowRun}
                onDeleteWorkflowRun={onDeleteWorkflowRun}
                runnableWorkflows={runnableWorkflows}
                onStartWorkflow={onStartWorkflow}
              />
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}
