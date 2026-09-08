import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Connection, IssueFilters, ProjectRecord, WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { WorkflowPipeline } from './WorkflowPipeline';

/** "KEY — Summary", the same picker convention IssueDetail's parent-issue field uses. */
const ISSUE_OPTION_SEPARATOR = '—';

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
  /** For resolving the project's own board connection — see `issueOptions` below. */
  connections: Connection[];
  runnableWorkflows: Array<{ id: string; name: string }>;
  /** The shell's right-pane element the stage detail portals into. */
  auxSlot: HTMLElement | null;
  /** Ask the shell to reveal the right pane (a stage was selected). */
  onRequireAux?: () => void;
  onOpenSession?: (sessionKey: string) => void;
}

interface IssueOption {
  key: string;
  summary: string;
  connectionId?: string;
}

interface EvidenceState {
  label: string;
  kind: string;
  state: 'available' | 'empty' | 'missing' | 'expired' | 'unavailable';
  content?: string;
  reason?: string;
}

/** Parses "KEY — Summary" (or a bare key typed past the datalist) back to just the key. */
function extractIssueKey(raw: string): string {
  const value = raw.trim();
  const separator = ` ${ISSUE_OPTION_SEPARATOR} `;
  const separatorIndex = value.indexOf(separator);
  return separatorIndex === -1 ? value : value.slice(0, separatorIndex).trim();
}

export function WorkflowRunMonitor({
  project,
  connections,
  runnableWorkflows,
  auxSlot,
  onRequireAux,
  onOpenSession
}: WorkflowRunMonitorProps) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [taskTitle, setTaskTitle] = useState('');
  const [startWorkflowId, setStartWorkflowId] = useState('');
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [issueOptions, setIssueOptions] = useState<IssueOption[]>([]);
  const [issueKeyDraft, setIssueKeyDraft] = useState('');
  const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});

  // Preselect the only workflow, so a project with one goes straight to "Task".
  useEffect(() => {
    if (runnableWorkflows.length === 1) setStartWorkflowId(runnableWorkflows[0].id);
  }, [runnableWorkflows]);

  // Tickets this run's Start form can link — the project's own board plus any
  // boards linked to it, mirroring exactly what its sidebar shows under this
  // project. Own-board ownership is read from the connection record (never
  // inferred from its id — see App.tsx's projectIdForConnection), so this
  // holds even for a project whose own connection predates a storage change.
  // The own board's *id* is likewise never assumed to be `project.defaultBoardId`
  // — a folder-mode project's board id follows the folder backend's own
  // convention instead, so it's resolved from `board.list` the same way the
  // sidebar and the command palette's issue search do.
  useEffect(() => {
    let cancelled = false;
    const ownConnectionId = connections.find(connection => connection.settings.projectId === project.id)?.id;
    (async () => {
      const ownBoard = ownConnectionId
        ? (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' })).find(
            candidate => candidate.connectionId === ownConnectionId
          )
        : undefined;
      const boards: Array<{ connectionId?: string; boardId: string }> = [
        ...(ownBoard ? [{ connectionId: ownConnectionId, boardId: ownBoard.id }] : []),
        ...project.linkedBoards.map(link => ({ connectionId: link.connectionId, boardId: link.boardId }))
      ];
      const results = await Promise.allSettled(
        boards.map(board => {
          const filters: IssueFilters = {
            projectKeys: [],
            statuses: [],
            issueTypes: [],
            searchText: '',
            assigneeMode: 'all',
            boardId: board.boardId,
            grouping: 'none'
          };
          return window.praxis.issue
            .list(filters, 0, 50, board.connectionId)
            .then(page => page.issues.map(issue => ({ key: issue.key, summary: issue.summary, connectionId: board.connectionId })));
        })
      );
      if (cancelled) return;
      setIssueOptions(results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])));
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, project.linkedBoards, connections]);

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

  useEffect(() => {
    if (!selected || !selectedStageId) {
      setEvidence({});
      return;
    }
    const row = selected.stages.find(candidate => candidate.nodeId === selectedStageId);
    if (!row || row.attempts <= 0) {
      setEvidence({});
      return;
    }

    let cancelled = false;
    void (async () => {
      const bundle = await window.praxis.workflows.getEvidence(project.id, selected.runId, row.nodeId, row.attempts);
      if (!bundle || cancelled) return;

      const next = await Promise.all(
        bundle.entries.map(async entry => {
          const read = await window.praxis.workflows.readEvidenceEntry(
            project.id,
            selected.runId,
            row.nodeId,
            row.attempts,
            entry.label
          );
          if (!read) return undefined;
          return {
            label: read.entry.label,
            kind: read.entry.kind,
            state: read.state,
            content: read.content,
            reason: read.reason
          } satisfies EvidenceState;
        })
      );

      if (cancelled) return;
      setEvidence(Object.fromEntries(next.filter((entry): entry is EvidenceState => !!entry).map(entry => [entry.label, entry])));
    })();

    return () => {
      cancelled = true;
    };
  }, [project.id, selected, selectedStageId]);

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
            const issueKey = extractIssueKey(issueKeyDraft);
            const matchedIssue = issueKey ? issueOptions.find(option => option.key === issueKey) : undefined;
            // A key that doesn't match any fetched option (typo, or a ticket outside
            // this project's boards) starts an ordinary run rather than guessing at
            // a connection to write back to — same "no invented attribution"
            // discipline as the AI settings spend report.
            void act(() =>
              window.praxis.workflows.startRun(
                project.id,
                startWorkflowId,
                taskTitle.trim(),
                matchedIssue ? { issueKey: matchedIssue.key, connectionId: matchedIssue.connectionId } : undefined
              )
            ).then(() => {
              setTaskTitle('');
              setIssueKeyDraft('');
            });
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
          {issueOptions.length > 0 && (
            <label>
              <span>Ticket (optional)</span>
              <input
                aria-label="Run ticket"
                list="wf-runstart-issue-options"
                value={issueKeyDraft}
                onChange={e => setIssueKeyDraft(e.target.value)}
                placeholder="Write the outcome back as a comment"
                data-testid="wf-runstart-issue"
              />
              <datalist id="wf-runstart-issue-options">
                {issueOptions.map(option => (
                  <option key={option.key} value={`${option.key} ${ISSUE_OPTION_SEPARATOR} ${option.summary}`} />
                ))}
              </datalist>
            </label>
          )}
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
                <strong>
                  {selected.status}
                  {selected.issueKey && (
                    <span className="wf-board-issue-key" data-testid="wf-board-issue-key">
                      {' '}
                      · linked to {selected.issueKey}
                    </span>
                  )}
                </strong>
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
            <span>A stage&rsquo;s checks and evidence appear here.</span>
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

            <div className="wf-stage-evidence">
              <div className="wf-stage-evidence-header">Evidence</div>
              {Object.keys(evidence).length === 0 ? (
                <p className="rail-sub">No retained evidence for this attempt yet.</p>
              ) : (
                Object.values(evidence).map(entry => (
                  <div key={entry.label} className={`wf-stage-evidence-item is-${entry.state}`}>
                    <div className="wf-stage-evidence-head">
                      <strong>{entry.label}</strong>
                      <span className={`chip ${entry.state === 'available' ? 'chip-success' : entry.state === 'missing' ? 'chip-danger' : entry.state === 'expired' ? 'chip-warn' : entry.state === 'empty' ? 'chip-muted' : 'chip-warn'}`}>
                        {entry.state}
                      </span>
                    </div>
                    {entry.reason && <p className="rail-sub">{entry.reason}</p>}
                    {entry.state === 'empty' ? (
                      <p className="rail-sub">This command produced no output.</p>
                    ) : entry.content !== undefined ? (
                      <pre>{entry.content}</pre>
                    ) : null}
                  </div>
                ))
              )}
            </div>

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

