import React, { useState, useMemo } from 'react';
import type { AgentSessionRecord, ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { formatStarted } from '../../ai/sessionNav';
import { Icon } from '../../ui/Icon';

export interface EasyModeAutomationsListProps {
  projects: ProjectRecord[];
  runsByProjectId: Record<string, WorkflowRunSummary[]>;
  activeWorkflowRunId?: string;
  allSessions?: AgentSessionRecord[];
  filterTab?: 'all' | 'live' | 'gates';
  onSelectWorkflowRun: (project: ProjectRecord, runId: string) => void;
  onSelectSession?: (issueKey: string) => void;
  onNewWorkflowRun?: () => void;
  onRerunWorkflowRun?: (project: ProjectRecord, run: WorkflowRunSummary) => void;
  onRenameWorkflowRun?: (run: WorkflowRunSummary, name: string) => Promise<void>;
  onArchiveWorkflowRun?: (run: WorkflowRunSummary, archived: boolean) => Promise<void>;
  /** Owns the confirmation, since deleting a run can also delete the work it produced. */
  onDeleteWorkflowRun?: (run: WorkflowRunSummary) => Promise<void>;
  /** Workflows offered as one-click starters in the launchpad. */
  runnableWorkflows?: Array<{ id: string; name: string }>;
  /** Opens the start-run dialog with the chosen workflow preselected. */
  onStartWorkflow?: (workflowId: string) => void;
}

/** How many workflow starters the launchpad shows before deferring to "More…". */
const LAUNCHPAD_LIMIT = 3;
/** Above this many stages, per-stage labels would be too narrow to read, so only the meta line is shown. */
const MAX_LABELLED_STAGES = 4;

type StageLane = WorkflowRunSummary['stages'][number]['lane'];

function gaugeSegmentClass(lane: StageLane): string {
  switch (lane) {
    case 'done': return 'is-passed';
    case 'running':
    case 'awaiting': return 'is-active';
    case 'failed': return 'is-failed';
    case 'skipped': return 'is-skipped';
    default: return 'is-queued';
  }
}

function gaugeGlyph(lane: StageLane): string {
  switch (lane) {
    case 'done': return '✓';
    case 'running': return '●';
    case 'awaiting': return '!';
    case 'failed': return '✕';
    case 'skipped': return '–';
    default: return '○';
  }
}

function RunLaunchpad({
  workflows,
  onStartWorkflow,
  onMore
}: {
  workflows: Array<{ id: string; name: string }>;
  onStartWorkflow: (workflowId: string) => void;
  onMore?: () => void;
}) {
  const shown = workflows.slice(0, LAUNCHPAD_LIMIT);
  const hidden = workflows.length - shown.length;
  return (
    <div className="run-launchpad" data-testid="easymode-run-launchpad">
      <span className="run-launchpad__label">Start a run</span>
      <div className="run-launchpad__chips">
        {shown.map(workflow => (
          <button
            key={workflow.id}
            type="button"
            className="run-launchpad__chip"
            title={`Start ${workflow.name}`}
            data-testid={`easymode-launchpad-${workflow.id}`}
            onClick={() => onStartWorkflow(workflow.id)}
          >
            <Icon name="play" size={9} />
            <span>{workflow.name}</span>
          </button>
        ))}
        {hidden > 0 && onMore && (
          <button
            type="button"
            className="run-launchpad__chip run-launchpad__chip--more"
            title="Choose another workflow"
            onClick={onMore}
          >
            +{hidden} more
          </button>
        )}
      </div>
    </div>
  );
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
  filterTab,
  onSelectWorkflowRun,
  onSelectSession,
  onNewWorkflowRun,
  onRerunWorkflowRun,
  onRenameWorkflowRun,
  onArchiveWorkflowRun,
  onDeleteWorkflowRun,
  runnableWorkflows,
  onStartWorkflow
}: EasyModeAutomationsListProps) {
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [editingRunId, setEditingRunId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [busyRunId, setBusyRunId] = useState<string>();

  /** Runs one row action, holding the row's buttons until it settles. Failures surface from the owner of the action. */
  const withBusy = async (runId: string, action: () => Promise<void>) => {
    setBusyRunId(runId);
    try {
      await action();
    } catch {
      // The row simply keeps its previous state.
    } finally {
      setBusyRunId(undefined);
    }
  };

  const commitRename = async (run: WorkflowRunSummary) => {
    const next = draft.trim();
    setEditingRunId(undefined);
    if (!next || next === run.workflowName || !onRenameWorkflowRun) return;
    await withBusy(run.runId, () => onRenameWorkflowRun(run, next));
  };

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
          if (filterTab === 'live') {
            if (run.status !== 'running' && run.status !== 'awaiting-approval') continue;
          } else if (filterTab === 'gates') {
            const hasGate = run.status === 'awaiting-approval' || run.stages?.some(s => s.lane === 'awaiting');
            if (!hasGate) continue;
          }
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
  }, [projects, runsByProjectId, filterTab]);

  const workflows = runnableWorkflows ?? [];
  const launchpad = onStartWorkflow && workflows.length > 0
    ? <RunLaunchpad workflows={workflows} onStartWorkflow={onStartWorkflow} onMore={onNewWorkflowRun} />
    : null;

  if (allRuns.length === 0) {
    if (filterTab && filterTab !== 'all') {
      return (
        <p className="easymode-filter-empty" data-testid="easymode-automations-filter-empty">
          {filterTab === 'live' ? 'No runs in progress.' : 'No runs waiting on you.'}
        </p>
      );
    }
    return (
      <div className="easymode-empty-card easymode-empty-card--compact" data-testid="easymode-automations-empty-card">
        <div className="easymode-empty-card__row">
          <span className="easymode-empty-card__title">No runs yet</span>
          {onNewWorkflowRun && (
            <button
              type="button"
              className="easymode-empty-card__link"
              onClick={onNewWorkflowRun}
              data-testid="easymode-empty-new-run"
            >
              <Icon name="plus" size={11} />
              Start a run
            </button>
          )}
        </div>
        {launchpad ?? (
          <p className="easymode-empty-card__desc">Runs take a workflow through its stages, pausing at review gates.</p>
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
                  {editingRunId === run.runId ? (
                    <input
                      className="session-title-input"
                      data-testid={`easymode-run-title-input-${run.runId}`}
                      aria-label={`Run name for ${run.workflowName}`}
                      value={draft}
                      maxLength={120}
                      disabled={busyRunId === run.runId}
                      autoFocus
                      onClick={e => e.stopPropagation()}
                      onChange={e => setDraft(e.target.value)}
                      onBlur={() => void commitRename(run)}
                      onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingRunId(undefined);
                        }
                      }}
                    />
                  ) : (
                    <span className="easymode-automation-row__title" title={run.workflowName}>
                      {run.workflowName}
                    </span>
                  )}
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
              <div className={`easymode-automation-row__actions${hasStages ? ' has-expand' : ''}`}>
                {onRenameWorkflowRun && (
                  <button
                    type="button"
                    className="easymode-automation-action-btn"
                    title="Rename run"
                    aria-label="Rename run"
                    data-testid={`easymode-run-rename-${run.runId}`}
                    disabled={busyRunId === run.runId}
                    onClick={e => {
                      e.stopPropagation();
                      setDraft(run.workflowName);
                      setEditingRunId(run.runId);
                    }}
                  >
                    <Icon name="pencil" size={11} />
                  </button>
                )}
                {onArchiveWorkflowRun && (
                  <button
                    type="button"
                    className="easymode-automation-action-btn"
                    title="Archive run"
                    aria-label="Archive run"
                    data-testid={`easymode-run-archive-${run.runId}`}
                    disabled={busyRunId === run.runId}
                    onClick={e => {
                      e.stopPropagation();
                      void withBusy(run.runId, () => onArchiveWorkflowRun(run, true));
                    }}
                  >
                    <Icon name="archive" size={11} />
                  </button>
                )}
                {onDeleteWorkflowRun && (
                  <button
                    type="button"
                    className="easymode-automation-action-btn easymode-automation-action-btn--delete"
                    title="Delete run"
                    aria-label="Delete run"
                    data-testid={`easymode-run-delete-${run.runId}`}
                    disabled={busyRunId === run.runId}
                    onClick={e => {
                      e.stopPropagation();
                      void withBusy(run.runId, () => onDeleteWorkflowRun(run));
                    }}
                  >
                    <Icon name="trash" size={11} />
                  </button>
                )}
                <button
                  type="button"
                  className="easymode-automation-action-btn"
                  title={run.status === 'running' ? 'View active run' : 'Rerun'}
                  aria-label={run.status === 'running' ? 'View active run' : 'Rerun'}
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

            {/* Segmented Pipeline Gauge Rail */}
            {hasStages && (
              <div className="pipeline-gauge-container" data-testid={`easymode-gauge-${run.runId}`}>
                <div
                  className={`gauge-track${run.stages.length <= MAX_LABELLED_STAGES ? ' is-labelled' : ''}`}
                  style={{ gridTemplateColumns: `repeat(${run.stages.length}, minmax(0, 1fr))` }}
                >
                  {run.stages.map((stage, idx) => {
                    const segClass = gaugeSegmentClass(stage.lane);
                    return (
                      <span
                        key={stage.nodeId || idx}
                        className={`gauge-step ${segClass}`}
                        title={`${stage.name} · ${stageLaneLabel(stage.lane)}`}
                        data-testid={`easymode-gauge-step-${stage.nodeId || idx}`}
                      >
                        <span className={`gauge-segment ${segClass}`} />
                        {run.stages.length <= MAX_LABELLED_STAGES && (
                          <span className="gauge-step__label">
                            <span className="gauge-step__glyph" aria-hidden="true">{gaugeGlyph(stage.lane)}</span>
                            <span className="gauge-step__name">{stage.name}</span>
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="gauge-meta-row">
                  <span className="gauge-stage-current">
                    {activeStage ? (
                      <>
                        <span className="gauge-indicator-dot" />
                        <span>{run.stages.indexOf(activeStage) + 1}/{run.stages.length} {activeStage.name}{activeStage.chosenModel ? ` · ${activeStage.chosenModel}` : ''}</span>
                      </>
                    ) : run.status === 'succeeded' ? (
                      <>
                        <Icon name="check" size={10} className="completed-glyph" />
                        <span>All {run.stages.length} stages completed</span>
                      </>
                    ) : (
                      <span>{run.stages.length} stages · {resolveRunStatusLabel(run.status)}</span>
                    )}
                  </span>
                  <span className="gauge-ratio">
                    {run.stages.filter(s => s.lane === 'done').length}/{run.stages.length}
                  </span>
                </div>
              </div>
            )}

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
      {(!filterTab || filterTab === 'all') && launchpad}
    </div>
  );
}
