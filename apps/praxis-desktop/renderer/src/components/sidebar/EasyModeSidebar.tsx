import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { AgentSessionRecord, GitStatusSnapshot, WorkflowRunSummary, ProjectRecord } from '@praxis/core';
import { useProjectsTeamChats } from '../../assistant/TeamChatRow';
import { SectionHeader } from './SectionHeader';
import { EasyModeSessionsList } from './EasyModeSessionsList';
import { EasyModeAutomationsList } from './EasyModeAutomationsList';
import { AssignSessionDialog } from './AssignSessionDialog';
import { Icon } from '../../ui/Icon';
import { ChipSelect } from '../../ui/ChipSelect';
import { useStartTeamChat } from '../../assistant/TeamChatRow';

export interface EasyModeSidebarProps {
  sessions: AgentSessionRecord[];
  allSessions?: AgentSessionRecord[];
  activeSessionKey?: string;
  activeAgentId?: string;
  onSelectSession: (issueKey: string) => void;
  onSelectAgent?: (sessionKey: string, agentId: string) => void;
  onNewSession: () => void;
  onNewConversation: () => void;
  generalConversations?: boolean;
  onAbortSession?: (sessionKey: string) => void;
  onDeleteSession?: (sessionKey: string) => void;
  onRenameSession?: (sessionKey: string, title: string) => Promise<void>;
  onArchiveSession?: (sessionKey: string, archived: boolean) => Promise<void>;
  onAssignConversation?: (issueKey: string, projectId: string, ticketKey?: string) => Promise<void>;
  assignableProjects?: ProjectRecord[];
  projects: ProjectRecord[];
  /** All projects in the workspace, while `projects` scopes the current feed. */
  selectableProjects: ProjectRecord[];
  activeProjectId?: string;
  onSelectProject: (projectId: string) => void;
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
 * Features the Horizon workspace anchor and symmetrical Sessions & Runs pipelines.
 */
export function EasyModeSidebar({
  sessions,
  allSessions,
  activeSessionKey,
  activeAgentId,
  onSelectSession,
  onSelectAgent,
  onNewSession,
  onNewConversation,
  generalConversations = false,
  onAbortSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
  onAssignConversation,
  assignableProjects,
  projects,
  selectableProjects,
  activeProjectId,
  onSelectProject,
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
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [assignSession, setAssignSession] = useState<AgentSessionRecord>();
  const feedRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef<HTMLElement>(null);
  const [runsFraction, setRunsFraction] = useState<number | undefined>(() => {
    const stored = localStorage.getItem('praxis-easymode-runs-fraction');
    const value = stored === null ? NaN : Number(stored);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
  });

  const resizeRuns = (height: number) => {
    const feedHeight = feedRef.current?.clientHeight ?? 0;
    if (!feedHeight) return;
    const maxHeight = Math.max(72, feedHeight - 164);
    const fraction = Math.min(maxHeight, Math.max(72, height)) / feedHeight;
    setRunsFraction(fraction);
    localStorage.setItem('praxis-easymode-runs-fraction', String(fraction));
  };

  const activeProject = projects.find(project => project.id === activeProjectId);
  const workspaceFolder = activeProject?.workspaceFolder;
  const creationProject = activeProject ?? projects[0] ?? selectableProjects[0];
  const startTeamChat = useStartTeamChat(creationProject?.id ?? '');

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

  const teamChats = useProjectsTeamChats(generalConversations ? [] : projects.map(project => project.id));

  const rootSessions = useMemo(() => {
    return sessions.filter(s => !s.parentSessionKey && !s.workflowRunId);
  }, [sessions]);

  return (
    <aside className="easymode-sidebar" data-testid="easymode-sidebar" aria-label="EasyMode Workspace Sidebar">
      {/* Horizon Bar: Workspace Anchor */}
      <div className="horizon-bar">
        <div className="horizon-row-main">
          <div className="easymode-new-split">
            <button type="button" className="easymode-new-primary" onClick={onNewSession}
              title="Create new session" aria-label="Create new session" data-testid="easymode-new-session">
              <Icon name="plus" size={12} /><span>New</span>
            </button>
            <ChipSelect value="" placeholder="" menuAlign="end" ariaLabel="Create new" title="More creation options"
              className="easymode-new-options" data-testid="easymode-new-options"
              options={[
                { value: 'session', label: 'New session', icon: 'robot' },
                { value: 'conversation', label: 'New conversation', icon: 'chats' },
                { value: 'team-chat', label: 'New team chat', icon: 'users', disabled: !creationProject },
                { value: 'run', label: 'New run', icon: 'play', disabled: !creationProject }
              ]}
              onChange={value => {
                if (value === 'session') onNewSession();
                else if (value === 'conversation') onNewConversation();
                else if (value === 'team-chat') startTeamChat();
                else if (value === 'run') onNewWorkflowRun();
              }}
            />
          </div>
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

      {/* Sidebar Feed Container */}
      <div className="easymode-sidebar-feed" ref={feedRef}>
        {/* Sessions Section */}
        <section className="easymode-section easymode-section--sessions" aria-label={generalConversations ? "General conversations" : "Sessions"}>
          <SectionHeader
            title={generalConversations ? "General conversations" : "Sessions"}
            count={rootSessions.length + teamChats.length}
            onAdd={generalConversations ? onNewConversation : onNewSession}
            addAriaLabel={generalConversations ? "Create new conversation" : "Create new session"}
            testId="section-header-add-sessions"
          />
          <div className="easymode-section__body">
            {renderSessionsContent ? renderSessionsContent() : (
              <EasyModeSessionsList
                sessions={sessions}
                teamChats={teamChats}
                scope={`easy-mode:${generalConversations ? 'conversations' : activeProjectId ?? 'workspace'}:recency`}
                conversational={generalConversations}
                allSessions={allSessions}
                selectedSessionKey={activeSessionKey}
                activeAgentId={activeAgentId}
                onSelectSession={onSelectSession}
                onSelectAgent={onSelectAgent}
                onNewSession={generalConversations ? onNewConversation : onNewSession}
                onAbortSession={onAbortSession}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
                onAssignSession={setAssignSession}
              />
            )}
          </div>
        </section>

        <div
          className="easymode-feed-divider"
          role="separator"
          aria-label="Resize Sessions and Runs"
          aria-orientation="horizontal"
          tabIndex={0}
          data-testid="easymode-runs-divider"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const feed = feedRef.current;
            if (feed) resizeRuns(feed.getBoundingClientRect().bottom - event.clientY - 8);
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const height = runsRef.current?.getBoundingClientRect().height ?? 72;
            resizeRuns(height + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 40 : 10));
          }}
        />

        {/* Runs Section (Structured Workflows) */}
        <section ref={runsRef} className="easymode-section easymode-section--runs" aria-label="Runs"
          style={runsFraction === undefined ? undefined : { flex: `0 0 ${runsFraction * 100}%`, maxHeight: 'max(72px, calc(100% - 164px))' }}>
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

      <AssignSessionDialog
        session={assignSession}
        assignableProjects={assignableProjects && assignableProjects.length > 0 ? assignableProjects : projects}
        onClose={() => setAssignSession(undefined)}
        onAssign={onAssignConversation ?? (async () => {})}
      />
    </aside>
  );
}
