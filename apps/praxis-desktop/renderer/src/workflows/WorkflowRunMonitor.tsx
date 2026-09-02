import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRecord, WorkflowRunSummary } from '@praxis/core';

/**
 * Workflow run monitor (FX-BE-022 / TASK-105).
 *
 * Renders the `WorkflowRunSummary` view model from core: a stage lane per node,
 * the parallel branches and where they converge, the gate ledger, and a single
 * sentence explaining why the run is active, blocked, failed, or complete.
 * Approve and the per-stage actions stay unavailable until the engine says
 * they are allowed — the buttons mirror `summary.actions`.
 *
 * Stages the orchestrator can drive (FX-BF-013) advance on their own; the
 * Mark done / Mark failed controls remain for stages it declines — a project
 * with no working directory, or no configured provider — and are how the E2E
 * suite exercises a run without an agent.
 */

const LANE_DOT: Record<WorkflowRunSummary['stages'][number]['lane'], string> = {
  idle: '○',
  ready: '◔',
  running: '◑',
  done: '●',
  failed: '✕',
  skipped: '–',
  awaiting: '◆'
};

export interface WorkflowRunMonitorProps {
  project: ProjectRecord;
  /** Start-a-run affordance needs the workflow ids available to the project. */
  runnableWorkflows: Array<{ id: string; name: string }>;
  /** Opens the agent session behind a stage, when one exists. */
  onOpenSession?: (sessionKey: string) => void;
}

export function WorkflowRunMonitor({ project, runnableWorkflows, onOpenSession }: WorkflowRunMonitorProps) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [taskTitle, setTaskTitle] = useState('');
  const [startWorkflowId, setStartWorkflowId] = useState('');

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

  // Live updates: the orchestrator advances stages in the background, so the
  // monitor must refresh without a user action. A burst of transitions
  // coalesces into one reload on the next frame.
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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 20, alignItems: 'start' }}>
      <section aria-label="Runs" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <form
          onSubmit={event => {
            event.preventDefault();
            if (!startWorkflowId || !taskTitle.trim()) return;
            void act(() => window.praxis.workflows.startRun(project.id, startWorkflowId, taskTitle.trim())).then(() => {
              setTaskTitle('');
            });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}
        >
          <strong style={{ fontSize: 13 }}>Start a run</strong>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
            <span style={{ color: 'var(--text-dim)' }}>Workflow</span>
            <select
              aria-label="Run workflow"
              value={startWorkflowId}
              onChange={event => setStartWorkflowId(event.target.value)}
            >
              <option value="">—</option>
              {runnableWorkflows.map(workflow => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
            <span style={{ color: 'var(--text-dim)' }}>Task</span>
            <input
              aria-label="Run task"
              value={taskTitle}
              onChange={event => setTaskTitle(event.target.value)}
              placeholder="What is this run for?"
            />
          </label>
          <button type="submit" className="primary-button" disabled={!startWorkflowId || !taskTitle.trim()}>
            Start
          </button>
        </form>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {runs.map(run => (
            <li key={run.runId}>
              <button
                type="button"
                aria-pressed={run.runId === selectedRunId}
                aria-label={`${run.workflowName}, ${run.status}`}
                onClick={() => setSelectedRunId(run.runId)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: run.runId === selectedRunId ? 'var(--surface-active, var(--bg-elevated))' : 'var(--bg)',
                  color: 'var(--text)',
                  cursor: 'pointer'
                }}
              >
                <span style={{ fontWeight: 600, display: 'block' }}>{run.workflowName}</span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{run.status}</span>
              </button>
            </li>
          ))}
          {runs.length === 0 && <li style={{ color: 'var(--text-dim)', fontSize: 13 }}>No runs yet.</li>}
        </ul>
      </section>

      <section aria-label="Run detail" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        )}

        {!selected ? (
          <p style={{ color: 'var(--text-dim)' }}>Select a run.</p>
        ) : (
          <>
            <div
              role="status"
              aria-live="polite"
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}
            >
              <strong>{selected.status}</strong>
              <p style={{ margin: '4px 0 0', fontSize: 13 }}>{selected.explanation}</p>
            </div>

            <RunActions summary={selected} onAct={act} />

            <StageTable summary={selected} onAct={act} onOpenSession={onOpenSession} />

            {selected.branchGroups.map(group => (
              <div
                key={group.joinNodeId}
                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13 }}
              >
                <strong>{group.joinName}</strong>{' '}
                <span style={{ color: group.converged ? 'var(--accent)' : 'var(--text-dim)' }}>
                  {group.converged ? 'converged' : 'waiting to converge'}
                </span>
                <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                  {group.branches.map(branch => (
                    <li key={branch.headNodeId}>
                      {branch.headName} — {branch.outcome}
                      {!branch.required && <span style={{ color: 'var(--text-dim)' }}> (advisory)</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {selected.gates.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13 }}>
                <strong>Gates</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                  {selected.gates.map(gate => (
                    <li key={gate.gate}>
                      {gate.gate}: <strong>{gate.state}</strong>
                      {gate.deterministic && <span style={{ color: 'var(--text-dim)' }}> (deterministic check)</span>} — {gate.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function RunActions({
  summary,
  onAct
}: {
  summary: WorkflowRunSummary;
  onAct: (fn: () => Promise<WorkflowRunSummary>) => Promise<void>;
}) {
  const canApprove = summary.actions.some(action => action.kind === 'approve');
  const canCancel = summary.actions.some(action => action.kind === 'cancel-run');

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        className="primary-button"
        disabled={!canApprove}
        onClick={() => void onAct(() => window.praxis.workflows.approveRun(summary.runId, 'desktop-user'))}
      >
        Approve
      </button>
      <button
        type="button"
        className="ghost-button"
        disabled={!canCancel}
        onClick={() => void onAct(() => window.praxis.workflows.cancelRun(summary.runId, 'cancelled from the monitor'))}
      >
        Cancel run
      </button>
    </div>
  );
}

function StageTable({
  summary,
  onAct,
  onOpenSession
}: {
  summary: WorkflowRunSummary;
  onAct: (fn: () => Promise<WorkflowRunSummary>) => Promise<void>;
  onOpenSession?: (sessionKey: string) => void;
}) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--text-dim)' }}>
          <th style={{ padding: '4px 8px' }}>Stage</th>
          <th style={{ padding: '4px 8px' }}>State</th>
          <th style={{ padding: '4px 8px' }}>Evidence</th>
          <th style={{ padding: '4px 8px' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {summary.stages.map(stage => {
          const canRetry = summary.actions.some(
            action => action.kind === 'retry-stage' && action.nodeId === stage.nodeId
          );
          return (
            <tr key={stage.nodeId} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 8px' }}>
                <span aria-hidden style={{ marginRight: 6 }}>
                  {LANE_DOT[stage.lane]}
                </span>
                {stage.name}
                <span style={{ color: 'var(--text-dim)' }}> · {stage.type}</span>
                {stage.gate && <span style={{ color: 'var(--accent)' }}> · {stage.gate} gate</span>}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {stage.outcome}
                {stage.maxAttempts && stage.attempts > 0 && (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {' '}
                    ({stage.attempts}/{stage.maxAttempts})
                  </span>
                )}
                {stage.lastError && (
                  <div style={{ color: 'var(--danger)', fontSize: 12 }}>{stage.lastError}</div>
                )}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {stage.sessionKey && onOpenSession && (
                  <button
                    type="button"
                    className="ghost-button"
                    style={{ fontSize: 12, padding: '1px 6px' }}
                    onClick={() => onOpenSession(stage.sessionKey as string)}
                  >
                    Open session
                  </button>
                )}
                {stage.snapshotRef && <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{stage.snapshotRef}</div>}
                {stage.artifacts.map(artifact => (
                  <div key={artifact.contractId} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    {artifact.kind}: {artifact.contractId}
                  </div>
                ))}
              </td>
              <td style={{ padding: '6px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {stage.lane === 'ready' && stage.type !== 'approval' && (
                  <>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        void onAct(() =>
                          window.praxis.workflows.advanceStage(summary.runId, stage.nodeId, 'succeeded', {
                            snapshotRef: stage.type === 'agent-task' ? `snapshot-${stage.nodeId}` : undefined
                          })
                        )
                      }
                    >
                      Mark done
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        void onAct(() =>
                          window.praxis.workflows.advanceStage(summary.runId, stage.nodeId, 'failed', {
                            error: 'Marked failed from the monitor.'
                          })
                        )
                      }
                    >
                      Mark failed
                    </button>
                  </>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void onAct(() => window.praxis.workflows.retryStage(summary.runId, stage.nodeId))}
                  >
                    Retry
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
