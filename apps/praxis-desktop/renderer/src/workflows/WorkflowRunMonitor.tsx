import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { WorkflowPipeline } from './WorkflowPipeline';

/**
 * Workflow run monitor (FX-BE-022 / FX-BE-029).
 *
 * Three columns: a live run list, the run board (a one-sentence explanation, a
 * read-only pipeline diagram, the gate ledger, a collapsible timeline), and the
 * detail for whichever stage is selected in the diagram.
 *
 * Stages the orchestrator can drive advance on their own and the board updates
 * live; Mark done / Mark failed remain for stages it declines (no provider, no
 * folder) and are how the E2E suite exercises a run without an agent.
 */

const STATUS_TONE: Record<WorkflowRunSummary['status'], string> = {
  running: 'lane--running',
  'awaiting-approval': 'lane--awaiting',
  succeeded: 'lane--done',
  failed: 'lane--failed',
  cancelled: 'lane--skipped'
};

const GATE_CHIP: Record<string, string> = {
  passed: 'chip-success',
  failed: 'chip-danger',
  pending: 'chip-warn',
  bypassed: 'chip-warn',
  missing: 'chip-danger'
};

export interface WorkflowRunMonitorProps {
  project: ProjectRecord;
  runnableWorkflows: Array<{ id: string; name: string }>;
  /** The shell's right-pane element the stage detail portals into. */
  auxSlot: HTMLElement | null;
  /** Ask the shell to reveal the right pane (a stage was selected). */
  onRequireAux?: () => void;
  onOpenSession?: (sessionKey: string) => void;
}

export function WorkflowRunMonitor({ project, runnableWorkflows, auxSlot, onRequireAux, onOpenSession }: WorkflowRunMonitorProps) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [taskTitle, setTaskTitle] = useState('');
  const [startWorkflowId, setStartWorkflowId] = useState('');
  const [timelineOpen, setTimelineOpen] = useState(false);

  // Preselect the only workflow, so a project with one goes straight to "Task".
  useEffect(() => {
    if (runnableWorkflows.length === 1) setStartWorkflowId(runnableWorkflows[0].id);
  }, [runnableWorkflows]);

  const reload = useCallback(
    async (keepId?: string) => {
      const list = await window.praxis.workflows.listRuns(project.id);
      setRuns(list);
      setSelectedRunId(current => keepId ?? current ?? list[0]?.runId);
    },
    [project.id]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates: the orchestrator advances stages in the background, coalesced
  // into one reload per frame; the current selection is kept.
  const pendingReload = useRef<number | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = window.praxis.workflows.onRunChanged(() => {
      if (pendingReload.current !== undefined) return;
      pendingReload.current = window.requestAnimationFrame(() => {
        pendingReload.current = undefined;
        void reload();
      });
    });
    return () => {
      unsubscribe();
      if (pendingReload.current !== undefined) window.cancelAnimationFrame(pendingReload.current);
    };
  }, [reload]);

  const selected = runs.find(run => run.runId === selectedRunId);
  const stage = selected?.stages.find(row => row.nodeId === selectedStageId);

  const act = useCallback(
    async (fn: () => Promise<WorkflowRunSummary>) => {
      setError(undefined);
      try {
        const updated = await fn();
        await reload(updated.runId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload]
  );

  const canApprove = selected?.actions.some(a => a.kind === 'approve') ?? false;
  const canCancel = selected?.actions.some(a => a.kind === 'cancel-run') ?? false;

  return (
    <div className="wf-runs">
      <nav className="rail" aria-label="Runs">
        <form
          className="wf-runstart"
          onSubmit={event => {
            event.preventDefault();
            if (!startWorkflowId || !taskTitle.trim()) return;
            void act(() => window.praxis.workflows.startRun(project.id, startWorkflowId, taskTitle.trim())).then(() =>
              setTaskTitle('')
            );
          }}
        >
          <strong>Start a run</strong>
          {!project.workspaceFolder && (
            <p className="hint is-warn">
              No folder is attached — agent and check stages will need to be advanced by hand.
            </p>
          )}
          {runnableWorkflows.length === 0 && (
            <p className="hint">Save a workflow in the designer first.</p>
          )}
          {runnableWorkflows.length > 1 && (
            <label>
              <span>Workflow</span>
              <select aria-label="Run workflow" value={startWorkflowId} onChange={e => setStartWorkflowId(e.target.value)}>
                <option value="">—</option>
                {runnableWorkflows.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Task</span>
            <input
              aria-label="Run task"
              value={taskTitle}
              onChange={e => setTaskTitle(e.target.value)}
              placeholder="What is this run for?"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={!startWorkflowId || !taskTitle.trim()}>
            Start
          </button>
        </form>

        <ul className="rail-list">
          {runs.map(run => (
            <li key={run.runId}>
              <button
                type="button"
                className="rail-row"
                aria-pressed={run.runId === selectedRunId}
                aria-label={`${run.workflowName}, ${run.status}`}
                onClick={() => {
                  setSelectedRunId(run.runId);
                  setSelectedStageId(undefined);
                }}
              >
                <span className={`lane ${STATUS_TONE[run.status]}`} aria-hidden>
                  ●
                </span>
                <span className="rail-main">
                  <span className="rail-name">{run.workflowName}</span>
                  <span className="rail-sub">{run.status}</span>
                </span>
              </button>
            </li>
          ))}
          {runs.length === 0 && <li className="rail-empty">No runs yet.</li>}
        </ul>
      </nav>

      <section className="wf-board" aria-label="Run detail">
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}

        {!selected ? (
          <div className="empty-state">
            <Icon name="play" size={26} />
            <span>Select a run, or start one.</span>
          </div>
        ) : (
          <>
            <div className="wf-board-status" role="status" aria-live="polite">
              <span className={`lane ${STATUS_TONE[selected.status]}`}>●</span>
              <div>
                <strong>{selected.status}</strong>
                <p>{selected.explanation}</p>
              </div>
              <div className="wf-board-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canApprove}
                  title={canApprove ? undefined : 'Every required gate must pass first'}
                  onClick={() => void act(() => window.praxis.workflows.approveRun(selected.runId, 'desktop-user'))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!canCancel}
                  onClick={() => void act(() => window.praxis.workflows.cancelRun(selected.runId, 'cancelled from the monitor'))}
                >
                  Cancel run
                </button>
              </div>
            </div>

            <WorkflowPipeline
              summary={selected}
              selectedNodeId={selectedStageId}
              onSelectNode={nodeId => {
                setSelectedStageId(nodeId);
                onRequireAux?.();
              }}
            />

            {selected.gates.length > 0 && (
              <table className="wf-gates">
                <caption>Gates</caption>
                <thead>
                  <tr>
                    <th scope="col">Gate</th>
                    <th scope="col">State</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.gates.map(gate => (
                    <tr key={gate.gate}>
                      <th scope="row">{gate.gate}</th>
                      <td>
                        <span className={`chip ${GATE_CHIP[gate.state] ?? 'chip-muted'}`}>{gate.state}</span>
                        {gate.deterministic && <span className="wf-gates-tag"> deterministic check</span>}
                      </td>
                      <td>{gate.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <details className="wf-timeline" open={timelineOpen} onToggle={e => setTimelineOpen((e.target as HTMLDetailsElement).open)}>
              <summary>Timeline ({selected.events.length})</summary>
              <ol>
                {selected.events.map(event => (
                  <li key={event.id}>
                    <span className="rail-sub">{new Date(event.at).toLocaleTimeString()}</span> {event.message}
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}
      </section>

      {auxSlot &&
        createPortal(
          <aside className="inspector aux-panel" aria-label="Stage detail">
            {!stage || !selected ? (
          <div className="empty-state">
            <Icon name="cursor" size={24} />
            <span>Select a stage to see its evidence.</span>
          </div>
        ) : (
          <div className="wf-stagecard">
            <h2>{stage.name}</h2>
            <p className="rail-sub">
              {stage.type}
              {stage.gate ? ` · ${stage.gate} gate` : ''} · {stage.outcome}
              {stage.maxAttempts && stage.attempts > 0 ? ` (${stage.attempts}/${stage.maxAttempts})` : ''}
            </p>

            {stage.lastError && <p className="wf-stage-error">{stage.lastError}</p>}

            {stage.snapshotRef && (
              <p>
                <span className="rail-sub">snapshot</span>{' '}
                <code>{stage.snapshotRef}</code>
              </p>
            )}

            {stage.artifacts.length > 0 && (
              <ul className="wf-stage-artifacts">
                {stage.artifacts.map(artifact => (
                  <li key={artifact.contractId}>
                    {artifact.kind}: {artifact.contractId}
                  </li>
                ))}
              </ul>
            )}

            <div className="inspector-actions">
              {stage.sessionKey && onOpenSession && (
                <button type="button" className="btn btn-compact" onClick={() => onOpenSession(stage.sessionKey as string)}>
                  Open session
                </button>
              )}
              {selected?.actions.some(a => a.kind === 'retry-stage' && a.nodeId === stage.nodeId) && (
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => void act(() => window.praxis.workflows.retryStage(selected.runId, stage.nodeId))}
                >
                  Retry
                </button>
              )}
              {stage.lane === 'ready' && stage.type !== 'approval' && (
                <>
                  <button
                    type="button"
                    className="btn btn-compact"
                    onClick={() =>
                      void act(() =>
                        window.praxis.workflows.advanceStage(selected.runId, stage.nodeId, 'succeeded', {
                          snapshotRef: stage.type === 'agent-task' ? `snapshot-${stage.nodeId}` : undefined
                        })
                      )
                    }
                  >
                    Mark done
                  </button>
                  <button
                    type="button"
                    className="btn btn-compact"
                    onClick={() =>
                      void act(() =>
                        window.praxis.workflows.advanceStage(selected.runId, stage.nodeId, 'failed', {
                          error: 'Marked failed from the monitor.'
                        })
                      )
                    }
                  >
                    Mark failed
                  </button>
                </>
              )}
            </div>
              </div>
            )}
          </aside>,
          auxSlot
        )}
    </div>
  );
}

