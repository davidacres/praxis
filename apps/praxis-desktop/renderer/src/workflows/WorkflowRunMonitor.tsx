import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Connection, IssueFilters, ProjectRecord, WorkflowEvidenceView, WorkflowPlanInput, WorkflowRunSummary } from '@praxis/core';
import { isIssueDone } from '../board/boardMeta';
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
  stale: 'chip-danger',
  pending: 'chip-warn',
  bypassed: 'chip-warn',
  missing: 'chip-danger'
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_CHIP: Record<string, string> = {
  critical: 'chip-danger',
  high: 'chip-danger',
  medium: 'chip-warn',
  low: 'chip-muted',
  info: 'chip-muted'
};

/**
 * A deployment stage's own status line, distinguishing "deploying" from
 * "verifying" instead of the generic outcome word every other stage shows —
 * a renderer-local mirror of core's `deploymentNodeDisplayPhase` (the
 * renderer may import only types from `@praxis/core` at runtime). Returns
 * `undefined` for a settled or not-yet-started stage, where the outcome word
 * already says everything there is to say.
 */
function deploymentPhaseLabel(stage: Pick<WorkflowRunSummary['stages'][number], 'type' | 'outcome' | 'phase'>): string | undefined {
  if (stage.type !== 'deployment' || stage.outcome !== 'running') return undefined;
  return stage.phase === 'verifying' ? 'Verifying' : 'Deploying';
}

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
  /** Normal day-to-day workflow work starts from a session, which becomes the run controller. */
  onStartSession?: () => void;
  /** Opens the project's Policies page, offered when a bypass is blocked for lack of one. */
  onOpenPolicies?: () => void;
  /** Select a specific run when the monitor is opened from session context. */
  initialRunId?: string;
  initialPlanInput?: WorkflowPlanInput;
  onPlanInputConsumed?: () => void;
}

interface IssueOption {
  key: string;
  summary: string;
  connectionId?: string;
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
  onOpenSession,
  onStartSession,
  onOpenPolicies,
  initialRunId,
  initialPlanInput,
  onPlanInputConsumed
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
  /** `${runId}:${nodeId}:${attempt}` of the evidence panel currently open, if any. */
  const [evidenceKey, setEvidenceKey] = useState<string>();
  const [evidenceView, setEvidenceView] = useState<WorkflowEvidenceView>();
  const [evidenceError, setEvidenceError] = useState<string>();
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosisMessage, setDiagnosisMessage] = useState<string>();
  const [bypassDraft, setBypassDraft] = useState<{ gate: string; reason: string }>();
  const [bypassBusy, setBypassBusy] = useState(false);
  const [planInput, setPlanInput] = useState<WorkflowPlanInput | undefined>(initialPlanInput);
  useEffect(() => setPlanInput(initialPlanInput), [initialPlanInput]);

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
            .then(page =>
              page.issues
                // Only open tickets are worth starting a run against — a done/closed
                // one has nothing left to deliver.
                .filter(issue => !isIssueDone(issue))
                .map(issue => ({ key: issue.key, summary: issue.summary, connectionId: board.connectionId }))
            );
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
      setSelectedRunId(current => keepId ?? initialRunId ?? current ?? list[0]?.runId);
    },
    [project.id, initialRunId]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // A different stage (or no stage) selected: any open evidence panel no
  // longer describes what's on screen, so close it rather than leave stale
  // content under a new heading.
  useEffect(() => {
    setEvidenceKey(undefined);
    setEvidenceView(undefined);
    setEvidenceError(undefined);
    setDiagnosisMessage(undefined);
  }, [selectedRunId, selectedStageId]);

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

  /** Opens (or closes, on a second click) the retained log for the stage's current attempt. */
  const toggleEvidence = async (): Promise<void> => {
    if (!selected || !stage) return;
    const key = `${selected.runId}:${stage.nodeId}:${stage.attempts}`;
    if (evidenceKey === key) {
      setEvidenceKey(undefined);
      return;
    }
    setEvidenceKey(key);
    setEvidenceView(undefined);
    setEvidenceError(undefined);
    try {
      setEvidenceView(await window.praxis.workflows.getEvidence(selected.runId, stage.nodeId, stage.attempts));
    } catch (cause) {
      setEvidenceError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Starts a diagnosis session from the stage's retained evidence, or shows why it can't. */
  const startDiagnosis = async (): Promise<void> => {
    if (!selected || !stage) return;
    setDiagnosing(true);
    setDiagnosisMessage(undefined);
    try {
      const result = await window.praxis.workflows.startDiagnosis(selected.runId, stage.nodeId, stage.attempts);
      if (result.ok) onOpenSession?.(result.sessionId);
      else setDiagnosisMessage(result.message);
    } catch (cause) {
      setDiagnosisMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosing(false);
    }
  };

  const act = useCallback(
    async (fn: () => Promise<WorkflowRunSummary>): Promise<boolean> => {
      setError(undefined);
      try {
        const updated = await fn();
        await reload(updated.runId);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [reload]
  );

  /** Only clears the inline reason field once the bypass actually lands — a refusal (bad policy, wrong state) leaves it in place next to the error so the reason isn't lost. */
  const confirmBypass = async (gate: string, approvalNodeId: string | undefined, reason: string) => {
    if (!selected) return;
    setBypassBusy(true);
    const ok = await act(() =>
      window.praxis.workflows.bypassGate(selected.runId, gate, 'desktop-user', reason, approvalNodeId)
    );
    setBypassBusy(false);
    if (ok) setBypassDraft(undefined);
  };

  const canCancel = selected?.actions.some(a => a.kind === 'cancel-run') ?? false;
  const reworkActions = selected?.actions.filter(action => action.kind === 'rework-stage') ?? [];
  const approveActions = selected?.actions.filter(action => action.kind === 'approve') ?? [];

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
                matchedIssue ? { issueKey: matchedIssue.key, connectionId: matchedIssue.connectionId } : undefined,
                undefined,
                planInput
              )
            ).then(() => {
              setTaskTitle('');
              setIssueKeyDraft('');
              setPlanInput(undefined);
              onPlanInputConsumed?.();
            });
          }}
        >
          <strong>Start a standalone run</strong>
          {onStartSession && (
            <p className="hint wf-runstart-session-hint">
              For day-to-day work, <button type="button" className="btn-link" onClick={onStartSession}>open a new session</button> and choose a workflow so the session becomes its controller.
            </p>
          )}
          {planInput && (
            <p className="hint" data-testid="workflow-plan-input">
              Plan input attached: master plan ({planInput.generatedFeatureCount} feature(s), {planInput.generatedStoryCount} stor{planInput.generatedStoryCount === 1 ? 'y' : 'ies'}).
            </p>
          )}
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
                {selected.controllerSessionKey && onOpenSession && (
                  <button
                    type="button"
                    className="btn btn-compact"
                    data-testid="wf-open-controller-session"
                    onClick={() => onOpenSession(selected.controllerSessionKey as string)}
                  >
                    Open controller session
                  </button>
                )}
                {reworkActions.map(action => (
                  <button
                    key={action.nodeId}
                    type="button"
                    className="btn btn-compact"
                    title="Creates a new delivery revision and reruns its downstream review, security, and QA stages."
                    onClick={() => void act(() => window.praxis.workflows.reworkStage(selected.runId, action.nodeId))}
                  >
                    {action.label}
                  </button>
                ))}
                {approveActions.length === 0 ? (
                  <button type="button" className="btn btn-primary" disabled title="Every required gate must pass first">
                    Approve
                  </button>
                ) : (
                  approveActions.map(action => (
                    <button
                      key={action.nodeId}
                      type="button"
                      className="btn btn-primary"
                      onClick={() =>
                        void act(() => window.praxis.workflows.approveRun(selected.runId, 'desktop-user', undefined, action.nodeId))
                      }
                    >
                      {/* Only one approval node is the overwhelmingly common case;
                          keep its button reading plain "Approve" and reserve the
                          per-stage label for when there's more than one to tell apart. */}
                      {approveActions.length > 1 ? action.label : 'Approve'}
                    </button>
                  ))
                )}
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
                    {selected.gates.some(gate => gate.bypassable || gate.bypassBlockedByPolicy) && (
                      <th scope="col">Action</th>
                    )}
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
                      {selected.gates.some(g => g.bypassable || g.bypassBlockedByPolicy) && (
                        <td>
                          {gate.bypassable && bypassDraft?.gate !== gate.gate && (
                            <button
                              type="button"
                              className="btn btn-compact"
                              data-testid={`wf-bypass-${gate.gate}`}
                              onClick={() => setBypassDraft({ gate: gate.gate, reason: '' })}
                            >
                              Bypass
                            </button>
                          )}
                          {gate.bypassable && bypassDraft?.gate === gate.gate && (
                            <div className="wf-gate-bypass-form">
                              <input
                                className="input"
                                aria-label={`Reason to bypass the ${gate.gate} gate`}
                                placeholder="Reason (required)"
                                value={bypassDraft.reason}
                                disabled={bypassBusy}
                                autoFocus
                                onChange={e => setBypassDraft({ gate: gate.gate, reason: e.target.value })}
                                onKeyDown={e => {
                                  if (e.key === 'Escape') setBypassDraft(undefined);
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn-compact btn-primary"
                                data-testid={`wf-bypass-confirm-${gate.gate}`}
                                disabled={bypassBusy || !bypassDraft.reason.trim()}
                                onClick={() => void confirmBypass(gate.gate, gate.approvalNodeId, bypassDraft.reason.trim())}
                              >
                                {bypassBusy ? 'Bypassing…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-compact"
                                disabled={bypassBusy}
                                onClick={() => setBypassDraft(undefined)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          {!gate.bypassable && gate.bypassBlockedByPolicy && (
                            <span className="wf-gates-tag" data-testid={`wf-bypass-blocked-${gate.gate}`}>
                              This workflow allows a bypass, but no project or global policy currently permits one.
                              {onOpenPolicies && (
                                <>
                                  {' '}
                                  <button type="button" className="btn-link" onClick={onOpenPolicies}>
                                    Open policies
                                  </button>
                                </>
                              )}
                            </span>
                          )}
                        </td>
                      )}
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
              {stage.gate ? ` · ${stage.gate} gate` : ''} · {deploymentPhaseLabel(stage) ?? stage.outcome}
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

            {stage.findings && (
              <div className="wf-findings-section" data-testid="wf-findings-section">
                <h3>Findings &amp; Metrics</h3>

                {Object.keys(stage.findings.metrics).length > 0 && (
                  <div className="wf-findings-metrics" data-testid="wf-findings-metrics">
                    <div className="chip-row">
                      {Object.entries(stage.findings.metrics).map(([key, value]) => (
                        <span key={key} className="chip chip-muted">
                          <strong>{key}:</strong> {value}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {stage.findings.findings.length === 0 ? (
                  <div className="wf-findings-empty" data-testid="wf-findings-empty">
                    <p className="placeholder-text">0 findings reported.</p>
                  </div>
                ) : (
                  <div className="wf-findings-groups">
                    {SEVERITY_ORDER.map(sev => {
                      const group = (stage.findings?.findings ?? []).filter(f => f.severity === sev);
                      if (group.length === 0) return null;
                      return (
                        <div key={sev} className="wf-findings-group" data-testid={`wf-findings-group-${sev}`}>
                          <h4>
                            <span className={`chip ${SEVERITY_CHIP[sev] ?? 'chip-muted'}`}>{sev}</span> ({group.length})
                          </h4>
                          <ul className="wf-findings-list">
                            {group.map(finding => (
                              <li key={finding.fingerprint} className="wf-finding-row" data-testid="wf-finding-row">
                                <div className="wf-finding-header">
                                  {finding.file && (
                                    <span className="wf-finding-location">
                                      <code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code>
                                    </span>
                                  )}
                                  <span className="rail-sub">{finding.category}</span>
                                </div>
                                <p className="wf-finding-message">{finding.message}</p>
                                {finding.suggestion && (
                                  <details className="wf-finding-suggestion">
                                    <summary>Suggestion</summary>
                                    <p>{finding.suggestion}</p>
                                  </details>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!stage.findings && stage.artifacts.some(a => a.kind === 'findings') && (
              <div className="wf-findings-section" data-testid="wf-findings-section">
                <h3>Findings</h3>
                <div className="wf-findings-empty" data-testid="wf-findings-empty">
                  <p className="placeholder-text">No findings reported.</p>
                </div>
              </div>
            )}

            <div className="inspector-actions">
              {stage.sessionKey && onOpenSession && (
                <button type="button" className="btn btn-compact" onClick={() => onOpenSession(stage.sessionKey as string)}>
                  Open session
                </button>
              )}
              {stage.attempts > 0 && (
                <button
                  type="button"
                  className="btn btn-compact"
                  aria-expanded={evidenceKey === `${selected.runId}:${stage.nodeId}:${stage.attempts}`}
                  onClick={() => void toggleEvidence()}
                >
                  {evidenceKey === `${selected.runId}:${stage.nodeId}:${stage.attempts}` ? 'Hide log' : 'View log'}
                </button>
              )}
              {stage.type === 'check' && stage.outcome === 'failed' && onOpenSession && (
                <button type="button" className="btn btn-compact" disabled={diagnosing} onClick={() => void startDiagnosis()}>
                  {diagnosing ? 'Starting…' : 'Diagnose'}
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

            {diagnosisMessage && <p className="wf-stage-error" data-testid="wf-diagnosis-blocked">{diagnosisMessage}</p>}

            {evidenceKey === `${selected.runId}:${stage.nodeId}:${stage.attempts}` && (
              <div className="wf-evidence" data-testid="wf-evidence-panel">
                {evidenceError ? (
                  <p className="wf-stage-error">{evidenceError}</p>
                ) : !evidenceView ? (
                  <span className="placeholder-text">Loading log…</span>
                ) : !evidenceView.entry ? (
                  <span className="placeholder-text">No retained evidence for this attempt.</span>
                ) : evidenceView.expired ? (
                  <span className="placeholder-text">
                    This log&rsquo;s retention window has passed; it is no longer available.
                  </span>
                ) : evidenceView.entry.presence === 'missing' ? (
                  <span className="placeholder-text">
                    {evidenceView.entry.missingReason || 'Nothing was captured for this attempt.'}
                  </span>
                ) : evidenceView.entry.presence === 'empty' ? (
                  <span className="placeholder-text">The command ran and produced no output.</span>
                ) : (
                  <>
                    <div className="wf-evidence-head">
                      <span>{evidenceView.entry.kind}</span>
                      {evidenceView.entry.truncated && (
                        <span className="session-changes-file-truncated">
                          showing the last {((evidenceView.entry.storedBytes ?? 0) / 1024).toFixed(0)} KB of{' '}
                          {((evidenceView.entry.originalBytes ?? 0) / 1024).toFixed(0)} KB
                        </span>
                      )}
                    </div>
                    <pre className="wf-evidence-body">{evidenceView.content}</pre>
                  </>
                )}
              </div>
            )}
              </div>
            )}
          </aside>,
          auxSlot
        )}
    </div>
  );
}
