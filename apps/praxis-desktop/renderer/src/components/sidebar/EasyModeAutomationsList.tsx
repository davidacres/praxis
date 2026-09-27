import React from 'react';
import type { ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { formatStarted } from '../../ai/sessionNav';

export interface EasyModeAutomationsListProps {
  projects: ProjectRecord[];
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  activeWorkflowRunId?: string;
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
}

function resolveRunStatusClass(status: WorkflowRunSummary['status']): string {
  switch (status) {
    case 'running':
    case 'awaiting-approval':
      return 'easymode-status--running';
    case 'succeeded':
      return 'easymode-status--success';
    case 'failed':
      return 'easymode-status--failed';
    default:
      return 'easymode-status--idle';
  }
}

function resolveRunStatusLabel(status: WorkflowRunSummary['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'awaiting-approval':
      return 'Awaiting approval';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending';
  }
}

export function EasyModeAutomationsList({
  projects,
  runsByProjectId,
  activeWorkflowRunId,
  onSelectWorkflowRun
}: EasyModeAutomationsListProps) {
  // Aggregate runs from all projects, sorted newest first
  const allRuns = React.useMemo(() => {
    const list: Array<{ project: ProjectRecord; run: WorkflowRunSummary }> = [];
    for (const project of projects) {
      const runs = runsByProjectId[project.id] ?? [];
      for (const run of runs) {
        if (!run.archived) {
          list.push({ project, run });
        }
      }
    }
    // Sort descending by startedAt
    return list.sort((a, b) => {
      const timeA = new Date(a.run.startedAt).getTime() || 0;
      const timeB = new Date(b.run.startedAt).getTime() || 0;
      return timeB - timeA;
    });
  }, [projects, runsByProjectId]);

  if (allRuns.length === 0) {
    return <div className="easymode-empty-hint">No automations yet</div>;
  }

  return (
    <div className="easymode-automations-list" data-testid="easymode-automations-list">
      {allRuns.map(({ project, run }) => {
        const isSelected = activeWorkflowRunId === run.runId;
        const statusClass = resolveRunStatusClass(run.status);
        const statusLabel = resolveRunStatusLabel(run.status);
        const timeFormatted = run.startedAt ? formatStarted(run.startedAt) : '';

        return (
          <div
            key={run.runId}
            className={`easymode-automation-row ${isSelected ? 'is-selected' : ''}`}
            data-testid={`easymode-run-${run.runId}`}
            onClick={() => onSelectWorkflowRun(project, run.runId)}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectWorkflowRun(project, run.runId);
              }
            }}
          >
            <span
              className={`easymode-status ${statusClass}`}
              aria-label={`Status: ${statusLabel}`}
              title={statusLabel}
            />
            <div className="easymode-automation-row__details">
              <span className="easymode-automation-row__title" title={run.workflowName}>
                {run.workflowName}
              </span>
              <span className="easymode-automation-row__project" title={project.name}>
                {project.name}
              </span>
            </div>
            {timeFormatted && (
              <span className="easymode-automation-row__time">
                {timeFormatted}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
