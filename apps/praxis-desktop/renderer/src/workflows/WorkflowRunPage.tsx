import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AiProvider, WorkflowEvidenceView, WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { PROVIDER_LABELS, providerIconName } from '../ai/modelProviders';
import { isProviderUsable } from '../ai/providerAvailability';
import { useDeleteRun } from './useDeleteRun';
import { WorkflowPipelineVertical } from './WorkflowPipelineVertical';
import { WorkflowRunsBrowser } from './WorkflowRunsBrowser';
import { ChipSelect } from '../ui/ChipSelect';

/**
 * The run workspace (replaces the old run monitor and its Runs list page).
 *
 * A run is opened from its node in the sidebar tree. The centre pane is the
 * session doing the work — whichever stage is running, or the one the viewer
 * picked in the pipeline. The shell's right pane carries the run itself: its
 * status and controls, the pipeline top to bottom, the selected stage's
 * findings and evidence, the gate ledger and the timeline.
 *
 * Stages the orchestrator can drive advance on their own and the view updates
 * live; Mark done / Mark failed remain for stages it declines (no provider, no
 * folder) and are how the E2E suite exercises a run without an agent.
 */

type Stage = WorkflowRunSummary['stages'][number];

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
 * renderer may import only types from `@praxis/core` at runtime).
 */
function deploymentPhaseLabel(stage: Pick<Stage, 'type' | 'outcome' | 'phase'>): string | undefined {
  if (stage.type !== 'deployment' || stage.outcome !== 'running') return undefined;
  return stage.phase === 'verifying' ? 'Verifying' : 'Deploying';
}

/**
 * The stage doing the work right now: the running one, else the last stage that
 * has a session (so a run waiting on a person, or a finished one, still shows
 * the conversation that got it there), else one waiting on a person.
 */
export function activeStageOf(summary: Pick<WorkflowRunSummary, 'stages'>): Stage | undefined {
  return (
    summary.stages.find(stage => stage.lane === 'running') ??
    [...summary.stages].reverse().find(stage => !!stage.sessionKey) ??
    summary.stages.find(stage => stage.lane === 'paused') ??
    summary.stages.find(stage => stage.lane === 'awaiting') ??
    summary.stages.find(stage => stage.lane === 'ready')
  );
}

export interface WorkflowRunPageProps {
  runId?: string;
  runs?: WorkflowRunSummary[];
  onSelectRun?: (runId: string) => void;
  onArchiveRun?: (runId: string, archived: boolean) => Promise<void>;
  onCancelRun?: (runId: string) => Promise<void>;
  onDeleteRun?: (run: WorkflowRunSummary) => void;
  /** The shell's right-pane element the run panel portals into. */
  auxSlot: HTMLElement | null;
  /** Ask the shell to reveal the right pane. */
  onRequireAux?: () => void;
  onOpenSession?: (sessionKey: string) => void;
  /** Opens the project's Policies page, offered when a bypass is blocked for lack of one. */
  onOpenPolicies?: () => void;
  /** Opens the start-run dialog — the empty state's way forward. */
  onStartRun?: () => void;
  /** The run no longer exists (deleted here or elsewhere). */
  onRunGone?: () => void;
  /** Renders the shell's session console for a stage session key. */
  renderSession: (sessionKey: string) => ReactNode;
  /** Renders the session inspector (lifecycle actions, task list, changeset) for a stage session key. */
  renderSessionInspector?: (sessionKey: string) => ReactNode;
}

export function WorkflowRunPage({
  runId,
  runs,
  onSelectRun,
  onArchiveRun,
  onCancelRun,
  onDeleteRun,
  auxSlot,
  onRequireAux,
  onOpenSession,
  onOpenPolicies,
  onStartRun,
  onRunGone,
  renderSession,
  renderSessionInspector
}: WorkflowRunPageProps) {
  const deleteRunFlow = useDeleteRun();
  const [run, setRun] = useState<WorkflowRunSummary | undefined>();
  const [loaded, setLoaded] = useState(false);
  /** A stage the viewer picked; absent means "follow whichever stage is live". */
  const [pinnedStageId, setPinnedStageId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [usableAis, setUsableAis] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai
      .listProviderStatuses()
      .then(statuses => {
        if (!cancelled) setUsableAis(statuses.filter(isProviderUsable).map(status => status.provider));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [timelineOpen, setTimelineOpen] = useState(false);
  /** `${runId}:${nodeId}:${attempt}` of the evidence panel currently open, if any. */
  const [evidenceKey, setEvidenceKey] = useState<string>();
  const [evidenceView, setEvidenceView] = useState<WorkflowEvidenceView>();
  const [evidenceError, setEvidenceError] = useState<string>();
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosisMessage, setDiagnosisMessage] = useState<string>();
  const [bypassDraft, setBypassDraft] = useState<{ gate: string; reason: string }>();
  const [bypassBusy, setBypassBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!runId) {
      setRun(undefined);
      setLoaded(true);
      return;
    }
    const found = await window.praxis.workflows.getRun(runId);
    setRun(found);
    setLoaded(true);
  }, [runId]);

  useEffect(() => {
    setLoaded(false);
    setPinnedStageId(undefined);
    setError(undefined);
    void reload();
  }, [reload]);

  // Live updates: the orchestrator advances stages in the background, coalesced
  // into one reload per frame; the selection is kept.
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

  // A run deleted from the tree (or another window) leaves nothing to show.
  useEffect(() => {
    if (loaded && runId && !run) onRunGone?.();
  }, [loaded, runId, run, onRunGone]);

  const activeStage = useMemo(() => (run ? activeStageOf(run) : undefined), [run]);
  const shownStage = run?.stages.find(stage => stage.nodeId === (pinnedStageId ?? activeStage?.nodeId));
  const following = pinnedStageId === undefined;
  const stage = shownStage;

  // A different stage (or run): any open evidence panel no longer describes
  // what's on screen, so close it rather than leave stale content under a new heading.
  useEffect(() => {
    setEvidenceKey(undefined);
    setEvidenceView(undefined);
    setEvidenceError(undefined);
    setDiagnosisMessage(undefined);
  }, [runId, shownStage?.nodeId]);

  const act = useCallback(
    async (fn: () => Promise<WorkflowRunSummary>): Promise<boolean> => {
      setError(undefined);
      try {
        await fn();
        await reload();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [reload]
  );

  /** Opens (or closes, on a second click) the retained log for the stage's current attempt. */
  const toggleEvidence = async (): Promise<void> => {
    if (!run || !stage) return;
    const key = `${run.runId}:${stage.nodeId}:${stage.attempts}`;
    if (evidenceKey === key) {
      setEvidenceKey(undefined);
      return;
    }
    setEvidenceKey(key);
    setEvidenceView(undefined);
    setEvidenceError(undefined);
    try {
      setEvidenceView(await window.praxis.workflows.getEvidence(run.runId, stage.nodeId, stage.attempts));
    } catch (cause) {
      setEvidenceError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Starts a diagnosis session from the stage's retained evidence, or shows why it can't. */
  const startDiagnosis = async (): Promise<void> => {
    if (!run || !stage) return;
    setDiagnosing(true);
    setDiagnosisMessage(undefined);
    try {
      const result = await window.praxis.workflows.startDiagnosis(run.runId, stage.nodeId, stage.attempts);
      if (result.ok) onOpenSession?.(result.sessionId);
      else setDiagnosisMessage(result.message);
    } catch (cause) {
      setDiagnosisMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosing(false);
    }
  };

  /** Only clears the inline reason field once the bypass actually lands — a refusal (bad policy, wrong state) leaves it in place next to the error so the reason isn't lost. */
  const confirmBypass = async (gate: string, approvalNodeId: string | undefined, reason: string) => {
    if (!run) return;
    setBypassBusy(true);
    const ok = await act(() => window.praxis.workflows.bypassGate(run.runId, gate, 'desktop-user', reason, approvalNodeId));
    setBypassBusy(false);
    if (ok) setBypassDraft(undefined);
  };

  const deleteRun = async () => {
    if (!run) return;
    const result = await deleteRunFlow(run);
    if (result.deleted) onRunGone?.();
    else if (result.error) setError(result.error);
  };

  const canCancel = run?.actions.some(a => a.kind === 'cancel-run') ?? false;
  const reworkActions = run?.actions.filter(action => action.kind === 'rework-stage') ?? [];
  const approveActions = run?.actions.filter(action => action.kind === 'approve') ?? [];
  /** Retry actions for the steps stopped by the AI provider's limit. */
  const pausedRetries = (run?.actions ?? []).filter(
    (action): action is Extract<WorkflowRunSummary['actions'][number], { kind: 'retry-stage' }> =>
      action.kind === 'retry-stage' &&
      !!run?.stages.some(candidate => candidate.nodeId === action.nodeId && candidate.pause)
  );

  const centre = (() => {
    if (!runId || (loaded && !run)) {
      if (runs && onSelectRun) {
        return (
          <WorkflowRunsBrowser
            runs={runs}
            selectedRunId={runId}
            onSelectRun={onSelectRun}
            onStartRun={onStartRun}
            onArchiveRun={onArchiveRun}
            onCancelRun={onCancelRun}
            onDeleteRun={onDeleteRun}
          />
        );
      }
      return (
        <div className="empty-state" data-testid="wf-run-empty">
          <Icon name="play" size={26} />
          <span>Select a run in the sidebar{onStartRun ? ', or start one.' : '.'}</span>
          {onStartRun && (
            <button type="button" className="btn btn-primary" onClick={onStartRun}>
              Start a run
            </button>
          )}
        </div>
      );
    }
    if (!run) return <div className="empty-state"><span>Loading run…</span></div>;
    return (
      <>
        <header className="wf-run-bar" data-testid="wf-run-bar">
          {onSelectRun && (
            <button
              type="button"
              className="btn btn-compact btn-quiet wf-run-bar-back"
              onClick={() => onSelectRun('')}
              title="Back to all runs"
              data-testid="wf-run-back"
            >
              <Icon name="arrow-left" size={13} />
              <span>Runs</span>
            </button>
          )}
          <span className={`lane ${run.paused ? 'lane--awaiting' : STATUS_TONE[run.status]}`} aria-hidden>●</span>
          <strong className="wf-run-bar-name" title={run.workflowName}>{run.workflowName}</strong>
          {run.archived && <span className="tree-badge">Archived</span>}
          <span className="wf-run-bar-status">{run.paused ? 'paused' : run.status.replace('-', ' ')}</span>
          {stage && (
            <span className="wf-run-bar-stage" data-testid="wf-run-bar-stage">
              {stage.name}
            </span>
          )}
          {!following && (
            <button
              type="button"
              className="btn btn-compact"
              data-testid="wf-run-follow"
              onClick={() => setPinnedStageId(undefined)}
              title="Go back to whichever step is doing the work"
            >
              Follow live
            </button>
          )}
        </header>
        <div className="wf-run-body">
          {stage?.sessionKey ? (
            <div className="wf-run-session" data-testid="wf-run-session" key={stage.sessionKey}>
              {renderSession(stage.sessionKey)}
            </div>
          ) : (
            <div className="empty-state" data-testid="wf-run-nosession">
              <Icon name={stage?.type === 'check' ? 'terminal' : 'robot'} size={26} />
              <strong>{stage ? stage.name : 'No steps yet'}</strong>
              {stage && (
                <span>
                  {stage.type === 'agent-task'
                    ? 'This step has no session yet. It appears here as soon as the step starts.'
                    : `A ${stage.type} step runs without a conversation — its result and log are in the run panel.`}
                </span>
              )}
              <span className="rail-sub">{run.explanation}</span>
            </div>
          )}
        </div>
      </>
    );
  })();

  return (
    <div className="wf-run-page" data-testid="wf-run-page">
      {centre}

      {auxSlot &&
        createPortal(
          <aside className="inspector aux-panel wf-run-panel" aria-label="Run" data-testid="wf-run-panel">
            {!run ? (
              <div className="empty-state">
                <Icon name="cursor" size={24} />
                <span>A run&rsquo;s pipeline and evidence appear here.</span>
              </div>
            ) : (
              <>
                {error && (
                  <p role="alert" className="error-banner">
                    {error}
                  </p>
                )}
                <div className="wf-board-status" role="status" aria-live="polite">
                  <span className={`lane ${run.paused ? 'lane--awaiting' : STATUS_TONE[run.status]}`}>●</span>
                  <div>
                    <strong>
                      {run.paused ? 'paused' : run.status.replace('-', ' ')}
                      {run.archived && <span className="tree-badge">Archived</span>}
                      {run.issueKey && (
                        <span className="wf-board-issue-key" data-testid="wf-board-issue-key">
                          {' '}
                          · linked to {run.issueKey}
                        </span>
                      )}
                    </strong>
                    <p>{run.explanation}</p>
                  </div>
                </div>

                {run.paused && run.pauseReason === 'environment' && (
                  <div className="wf-run-limit" role="alert" data-testid="wf-run-limit">
                    <strong>A step could not run in this environment</strong>
                    <p>
                      Its tooling failed before it could check anything — not a problem with the work. Fix it (the step&rsquo;s
                      log says what), then resume. Nothing is lost and no attempt was used.
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary btn-compact"
                      data-testid="wf-run-resume"
                      onClick={() =>
                        void (async () => {
                          for (const action of pausedRetries) {
                            if (!(await act(() => window.praxis.workflows.retryStage(run.runId, action.nodeId)))) break;
                          }
                        })()
                      }
                    >
                      Resume paused {pausedRetries.length === 1 ? 'step' : 'steps'}
                    </button>
                  </div>
                )}
                {run.status !== 'cancelled' && run.status !== 'succeeded' &&
                  run.stages
                    .filter(stage => stage.pause === 'provider-limit' && !(run.paused && run.pauseReason === 'environment'))
                    .map(stage => (
                      <ProviderLimitNotice
                        key={stage.nodeId}
                        run={run}
                        stage={stage}
                        usableAis={usableAis}
                        onSwitch={provider => void act(() => window.praxis.workflows.switchStageProvider(run.runId, stage.nodeId, provider as AiProvider))}
                        onRetry={() => void act(() => window.praxis.workflows.retryStage(run.runId, stage.nodeId))}
                        onStop={() => void act(() => window.praxis.workflows.stopForProviderLimit(run.runId, stage.nodeId))}
                      />
                    ))}

                <p
                  className="wf-run-mode rail-sub"
                  data-testid="wf-run-mode"
                  data-mode={run.permissionMode}
                  title={
                    run.permissionMode === 'auto'
                      ? 'Stages allow their own tool requests without stopping. Each stage\u2019s tool access still applies, and the final approval still needs a person.'
                      : 'A stage stops for Allow / Deny before each edit or command.'
                  }
                >
                  <Icon name={run.permissionMode === 'auto' ? 'zap' : 'shield'} size={12} />
                  {run.permissionMode === 'auto' ? 'Auto-approve tool requests' : 'Asks before tool requests'}
                </p>

                {(run.aiProvider || run.aiModel) && (
                  <p
                    className="wf-run-provider rail-sub"
                    data-testid="wf-run-provider"
                    title={
                      run.aiProvider
                        ? `Configured with ${PROVIDER_LABELS[run.aiProvider] ?? run.aiProvider}${run.aiModel ? ` · ${run.aiModel}` : ''}`
                        : `Configured with model ${run.aiModel}`
                    }
                  >
                    <Icon name={run.aiProvider ? providerIconName(run.aiProvider) : 'robot'} size={12} />
                    {run.aiProvider ? (PROVIDER_LABELS[run.aiProvider] ?? run.aiProvider) : 'AI'}
                    {run.aiModel ? ` · ${run.aiModel}` : ''}
                  </p>
                )}

                <div className="wf-board-actions">
                  {run.controllerSessionKey && onOpenSession && (
                    <button
                      type="button"
                      className="btn btn-compact"
                      data-testid="wf-open-controller-session"
                      onClick={() => onOpenSession(run.controllerSessionKey as string)}
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
                      onClick={() => void act(() => window.praxis.workflows.reworkStage(run.runId, action.nodeId))}
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
                          void act(() => window.praxis.workflows.approveRun(run.runId, 'desktop-user', undefined, action.nodeId))
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
                    className="btn btn-compact"
                    data-testid="wf-cancel-run"
                    disabled={!canCancel}
                    onClick={() => void act(() => window.praxis.workflows.cancelRun(run.runId, 'cancelled from the run view'))}
                  >
                    Cancel run
                  </button>
                  {!canCancel && onArchiveRun && (
                    <button
                      type="button"
                      className="btn btn-compact"
                      data-testid={run.archived ? 'wf-restore-run' : 'wf-archive-run'}
                      onClick={async () => {
                        await onArchiveRun(run.runId, !run.archived);
                        setRun(current => (current ? { ...current, archived: !current.archived } : undefined));
                      }}
                    >
                      <Icon name={run.archived ? 'refresh' : 'archive'} size={12} />
                      <span>{run.archived ? 'Restore run' : 'Archive run'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-compact btn-danger"
                    data-testid="wf-delete-run"
                    onClick={() => void deleteRun()}
                  >
                    Delete run
                  </button>
                </div>

                <WorkflowPipelineVertical
                  summary={run}
                  selectedNodeId={shownStage?.nodeId}
                  activeNodeId={activeStage?.nodeId}
                  onSelectNode={nodeId => {
                    setPinnedStageId(nodeId);
                    onRequireAux?.();
                  }}
                  onRetryNode={nodeId => void act(() => window.praxis.workflows.retryStage(run.runId, nodeId))}
                />

                {stage && (
                  <div className="wf-stagecard" data-testid="wf-stagecard">
                    <h2>{stage.name}</h2>
                    <p className="rail-sub">
                      {stage.type}
                      {stage.gate ? ` · ${stage.gate} gate` : ''} · {deploymentPhaseLabel(stage) ?? (stage.pause ? 'paused' : stage.outcome)}
                      {stage.maxAttempts && stage.attempts > 0 ? ` (${stage.attempts}/${stage.maxAttempts})` : ''}
                      {stage.provider || stage.chosenProvider ? (
                        <span data-testid="wf-stage-ai"> · on {aiName(stage.provider ?? stage.chosenProvider!)}</span>
                      ) : null}
                    </p>

                    {stage.lastError && (
                      <p className="wf-stage-error">
                        {stage.pause === 'provider-limit' && /^(?:the stage session failed:\s*)?(?:internal error|internal failure)$/i.test(stage.lastError.trim())
                          ? "The AI provider's credits, budget, or usage limit were reached."
                          : stage.lastError}
                      </p>
                    )}

                    {stage.snapshotRef && (
                      <p>
                        <span className="rail-sub">snapshot</span> <code>{stage.snapshotRef}</code>
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
                                              <code>
                                                {finding.file}
                                                {finding.line ? `:${finding.line}` : ''}
                                              </code>
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
                      {stage.attempts > 0 && (
                        <button
                          type="button"
                          className="btn btn-compact"
                          aria-expanded={evidenceKey === `${run.runId}:${stage.nodeId}:${stage.attempts}`}
                          onClick={() => void toggleEvidence()}
                        >
                          {evidenceKey === `${run.runId}:${stage.nodeId}:${stage.attempts}` ? 'Hide log' : 'View log'}
                        </button>
                      )}
                      {stage.type === 'check' && stage.outcome === 'failed' && onOpenSession && (
                        <button type="button" className="btn btn-compact" disabled={diagnosing} onClick={() => void startDiagnosis()}>
                          {diagnosing ? 'Starting…' : 'Diagnose'}
                        </button>
                      )}
                      {run.actions.some(a => a.kind === 'retry-stage' && a.nodeId === stage.nodeId) && (
                        <button
                          type="button"
                          className="btn btn-compact"
                          onClick={() => void act(() => window.praxis.workflows.retryStage(run.runId, stage.nodeId))}
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
                                window.praxis.workflows.advanceStage(run.runId, stage.nodeId, 'succeeded', {
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
                                window.praxis.workflows.advanceStage(run.runId, stage.nodeId, 'failed', {
                                  error: 'Marked failed from the run view.'
                                })
                              )
                            }
                          >
                            Mark failed
                          </button>
                        </>
                      )}
                    </div>

                    {diagnosisMessage && (
                      <p className="wf-stage-error" data-testid="wf-diagnosis-blocked">
                        {diagnosisMessage}
                      </p>
                    )}

                    {evidenceKey === `${run.runId}:${stage.nodeId}:${stage.attempts}` && (
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

                {run.gates.length > 0 && (
                  <table className="wf-gates">
                    <caption>Gates</caption>
                    <thead>
                      <tr>
                        <th scope="col">Gate</th>
                        <th scope="col">State</th>
                        <th scope="col">Detail</th>
                        {run.gates.some(gate => gate.bypassable || gate.bypassBlockedByPolicy) && <th scope="col">Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {run.gates.map(gate => (
                        <tr key={gate.gate}>
                          <th scope="row">{gate.gate}</th>
                          <td>
                            <span className={`chip ${GATE_CHIP[gate.state] ?? 'chip-muted'}`}>{gate.state}</span>
                            {gate.deterministic && <span className="wf-gates-tag"> deterministic check</span>}
                          </td>
                          <td>{gate.detail}</td>
                          {run.gates.some(g => g.bypassable || g.bypassBlockedByPolicy) && (
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
                  <summary>Timeline ({run.events.length})</summary>
                  <ol>
                    {run.events.map(event => (
                      <li key={event.id}>
                        <span className="rail-sub">{new Date(event.at).toLocaleTimeString()}</span> {event.message}
                      </li>
                    ))}
                  </ol>
                </details>

                {stage?.sessionKey && renderSessionInspector && (
                  <details className="wf-run-inspector" data-testid="wf-run-inspector">
                    <summary>Session details</summary>
                    {renderSessionInspector(stage.sessionKey)}
                  </details>
                )}
              </>
            )}
          </aside>,
          auxSlot
        )}
    </div>
  );
}

function aiName(provider: string): string {
  return (PROVIDER_LABELS[provider as AiProvider] ?? provider).replace(/\s*\(local\)$/, '').replace(/ CLI$/, '');
}

/**
 * A stage whose AI ran out of credits or hit its usage limit: switch it to
 * another AI and carry on, retry on the same AI once it is topped up, or stop
 * the run. After a stop the run can still be picked up the same way.
 */
function ProviderLimitNotice({
  run,
  stage,
  usableAis,
  onSwitch,
  onRetry,
  onStop
}: {
  run: WorkflowRunSummary;
  stage: WorkflowRunSummary['stages'][number];
  usableAis: string[];
  onSwitch: (provider: string) => void;
  onRetry: () => void;
  onStop: () => void;
}) {
  const ranOut = stage.provider ?? stage.chosenProvider ?? run.aiProvider;
  const who = ranOut ? aiName(ranOut) : 'The AI provider';
  const choices = usableAis.filter(id => id !== ranOut && !run.exhaustedProviders.includes(id));
  const [choice, setChoice] = useState<string>('');
  const selected = choices.includes(choice) ? choice : choices[0] ?? '';
  const stopped = run.status === 'failed';
  return (
    <div className="wf-run-limit" role="alert" data-testid="wf-run-limit" data-node-id={stage.nodeId}>
      <strong>{stopped ? 'The run could not be completed' : `${who} ran out of budget`}</strong>
      <p>
        {stage.name} stopped because {who} ran out of credits or hit its usage limit. Nothing is lost and no attempt was used
        {stopped ? ' — you can still carry on with another AI.' : '.'}
      </p>
      <div className="wf-run-limit-actions">
        {choices.length > 0 ? (
          <>
            <label className="wf-run-limit-switch">
              <span>Switch {stage.name} to</span>
              <ChipSelect
                ariaLabel={`Switch ${stage.name} to`}
                data-testid="wf-limit-switch-to"
                value={selected}
                onChange={setChoice}
                options={choices.map(id => ({ value: id, label: aiName(id), icon: providerIconName(id as AiProvider) }))}
              />
            </label>
            <button type="button" className="btn btn-primary btn-compact" data-testid="wf-limit-switch" onClick={() => onSwitch(selected)}>
              Switch and continue
            </button>
          </>
        ) : (
          <span className="rail-sub">No other AI is set up — add one in Settings › AI Provider to carry on with it.</span>
        )}
        <button type="button" className="btn btn-compact" data-testid="wf-run-resume" onClick={onRetry}>
          Retry on {who}
        </button>
        {!stopped && (
          <button type="button" className="btn btn-quiet btn-compact" data-testid="wf-limit-stop" onClick={onStop}>
            Stop the run
          </button>
        )}
      </div>
    </div>
  );
}
