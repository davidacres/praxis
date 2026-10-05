import React, { useMemo } from 'react';
import type { AgentSessionRecord, WorkflowRunSummary, ProjectRecord } from '@praxis/core';
import { SectionHeader } from './SectionHeader';
import { EasyModeSessionsList } from './EasyModeSessionsList';
import { EasyModeAutomationsList } from './EasyModeAutomationsList';

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
  projects: ProjectRecord[];
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  activeWorkflowRunId?: string;
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onNewWorkflowRun: () => void;
  onRerunWorkflowRun?: (project: ProjectRecord, run: WorkflowRunSummary) => void;
  renderSessionsContent?: () => React.ReactNode;
  renderAutomationsContent?: () => React.ReactNode;
}

/**
 * EasyMode Sidebar: Occupies the entire sidebar panel when enableEasyMode is active.
 * Houses the Sessions and Automations sections with Orca-inspired layouts and actions.
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
  projects,
  runsByProjectId,
  activeWorkflowRunId,
  onSelectWorkflowRun,
  onNewWorkflowRun,
  onRerunWorkflowRun,
  renderSessionsContent,
  renderAutomationsContent
}: EasyModeSidebarProps) {
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

  return (
    <aside className="easymode-sidebar" data-testid="easymode-sidebar" aria-label="EasyMode Workspace Sidebar">
      {/* Sessions Section */}
      <section className="easymode-section" aria-label="Sessions">
        <SectionHeader
          title="Sessions"
          count={sessions.length}
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
              onSelectSession={onSelectSession}
              onSelectAgent={onSelectAgent}
              onNewSession={onNewSession}
              onAbortSession={onAbortSession}
              onDeleteSession={onDeleteSession}
            />
          )}
        </div>
      </section>

      {/* Automations Section */}
      <section className="easymode-section" aria-label="Automations">
        <SectionHeader
          title="Automations"
          count={allRuns.length}
          onAdd={onNewWorkflowRun}
          addAriaLabel="Create new automation run"
          testId="section-header-add-automations"
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
            />
          )}
        </div>
      </section>
    </aside>
  );
}
