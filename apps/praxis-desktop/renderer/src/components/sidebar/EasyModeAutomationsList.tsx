import React, { useState, useMemo } from 'react';
import type { AgentSessionRecord, ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { formatStarted } from '../../ai/sessionNav';
import { Icon } from '../../ui/Icon';

export interface EasyModeAutomationsListProps {
  projects: ProjectRecord[];
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  activeWorkflowRunId?: string;
  allSessions?: AgentSessionRecord[];
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onSelectSession?: (issueKey: string) => void;
  onNewWorkflowRun?: () => void;
  onRerunWorkflowRun?: (project: ProjectRecord, run: WorkflowRunSummary) => void;
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

function stageLaneLabel(lane: WorkflowRunSummary['stages'][number]['lane']): string {
  switch (lane) {
    case 'idle': return 'Pending';
    case 'ready': return 'Ready';
    case 'running': return 'Running';
    case 'awaiting': return 'Needs review';
    case 'done': return 'Completed';
    case 'failed': return 'Failed';
    case 'skipped': return 'Skipped';
    case 'paused': return 'Paused';
    default: return lane;
  }
}

export function EasyModeAutomationsList({
  projects,
  runsByProjectId,
  activeWorkflowRunId,
  allSessions,
  onSelectWorkflowRun,
  onSelectSession,
  onNewWorkflowRun,
  onRerunWorkflowRun
}: EasyModeAutomationsListProps) {
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});

  const toggleExpand = (runId: string, currentlyExpanded: boolean) => {
    setExpandedRuns(prev => ({
      ...prev,
      [runId]: !currentlyExpanded
    }));
  };

  // Aggregate runs from all projects, sorted newest first
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
    // Sort descending by startedAt
    return list.sort((a, b) => {
      const timeA = new Date(a.run.startedAt).getTime() || 0;
      const timeB = new Date(b.run.startedAt).getTime() || 0;
      return timeB - timeA;
    });
  }, [projects, runsByProjectId]);

  if (allRuns.length === 0) {
    return (
      <div className="easymode-empty-card" data-testid="easymode-automations-empty-card">
        <div className="easymode-empty-card__icon">
          <Icon name="play" size={20} />
        </div>
        <div className="easymode-empty-card__content">
          <span className="easymode-empty-card__title">No automations yet</span>
          <p className="easymode-empty-card__desc">Run structured workflows and task pipelines across your project.</p>
        </div>
        {onNewWorkflowRun && (
          <button
            type="button"
            className="btn btn-secondary btn-sm easymode-empty-card__btn"
            onClick={onNewWorkflowRun}
            data-testid="easymode-empty-new-run"
          >
            <Icon name="plus" size={13} />
            Run an automation
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="easymode-automations-list" data-testid="easymode-automations-list">
      {allRuns.map(({ project, run }) => {
        const isSelected = activeWorkflowRunId === run.runId;
        const statusClass = resolveRunStatusClass(run.status);
        const statusLabel = resolveRunStatusLabel(run.status);
        const timeFormatted = run.startedAt ? formatStarted(run.startedAt) : '';

        const activeStage = run.stages?.find(s => s.lane === 'running' || s.lane === 'awaiting');
        const showStageBadge = run.status === 'running' || run.status === 'awaiting-approval';
        const hasStages = Array.isArray(run.stages) && run.stages.length > 0;
        const isExpanded = expandedRuns[run.runId] ?? (run.status === 'running' || run.status === 'awaiting-approval' || isSelected);

        return (
          <div
            key={run.runId}
            className={`easymode-automation-card ${isSelected ? 'is-selected' : ''}`}
            data-testid={`easymode-run-${run.runId}`}
          >
            <div
              className={`easymode-automation-row ${isSelected ? 'is-selected' : ''}`}
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
                <div className="easymode-automation-row__head-row">
                  <span className="easymode-automation-row__title" title={run.workflowName}>
                    {run.workflowName}
                  </span>
                  {showStageBadge && (
                    <span
                      className="easymode-stage-badge"
                      data-testid={`easymode-stage-badge-${run.runId}`}
                      title={`Current stage: ${activeStage?.name || run.status}`}
                    >
                      {activeStage?.name || (run.status === 'awaiting-approval' ? 'Approval' : 'In progress')}
                    </span>
                  )}
                </div>
                <span className="easymode-automation-row__project" title={project.name}>
                  {project.name}
                </span>
              </div>
              {timeFormatted && (
                <span className="easymode-automation-row__time">
                  {timeFormatted}
                </span>
              )}
              {hasStages && (
                <button
                  type="button"
                  className="easymode-automation-expand-btn"
                  aria-label={isExpanded ? 'Hide stages' : 'Show stages'}
                  title={isExpanded ? 'Hide stages' : 'Show stages'}
                  data-testid={`easymode-run-expand-${run.runId}`}
                  onClick={e => {
                    e.stopPropagation();
                    toggleExpand(run.runId, isExpanded);
                  }}
                >
                  <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={11} />
                </button>
              )}
              <div className="easymode-automation-row__actions">
                <button
                  type="button"
                  className="easymode-automation-action-btn"
                  title={run.status === 'running' ? 'View active run' : 'Rerun automation'}
                  aria-label={run.status === 'running' ? 'View active run' : 'Rerun automation'}
                  data-testid={`easymode-run-action-${run.runId}`}
                  onClick={e => {
                    e.stopPropagation();
                    if (onRerunWorkflowRun) {
                      onRerunWorkflowRun(project, run);
                    } else {
                      onSelectWorkflowRun(project, run.runId);
                    }
                  }}
                >
                  <Icon name={run.status === 'running' ? 'focus' : 'play'} size={11} />
                </button>
              </div>
            </div>

            {/* Nested Stage Sessions under the Automation */}
            {hasStages && isExpanded && (
              <div className="easymode-automation-stages" data-testid={`easymode-stages-${run.runId}`}>
                {run.stages.map(stage => {
                  const isStageLive = stage.lane === 'running' || stage.lane === 'awaiting';
                  return (
                    <div
                      key={stage.nodeId}
                      className={`easymode-stage-session-row${isStageLive ? ' is-live' : ''}`}
                      data-testid={`easymode-stage-${stage.nodeId}`}
                      onClick={e => {
                        e.stopPropagation();
                        if (stage.sessionKey && onSelectSession) {
                          onSelectSession(stage.sessionKey);
                        } else {
                          onSelectWorkflowRun(project, run.runId);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      title={`Stage: ${stage.name} (${stageLaneLabel(stage.lane)})`}
                    >
                      <span className={`easymode-stage-dot easymode-stage-dot--${stage.lane}`} />
                      <span className="easymode-stage-name">{stage.name}</span>
                      {stage.chosenModel && (
                        <span className="easymode-stage-model">{stage.chosenModel}</span>
                      )}
                      <span className="easymode-stage-status">{stageLaneLabel(stage.lane)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
