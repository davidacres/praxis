import React, { useEffect, useState } from 'react';
import type { WorkflowEvidenceView, WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';

type Stage = WorkflowRunSummary['stages'][number];

export interface WorkflowStageSummaryProps {
  run: WorkflowRunSummary;
  stage: Stage;
  onApprove?: (nodeId: string) => void;
  onRetry?: (nodeId: string) => void;
  onDiagnose?: () => void;
  diagnosing?: boolean;
}

const GATE_CHIP: Record<string, string> = {
  passed: 'chip-success',
  failed: 'chip-danger',
  stale: 'chip-danger',
  pending: 'chip-warn',
  bypassed: 'chip-warn',
  missing: 'chip-danger'
};

const LANE_STATUS_CHIP: Record<Stage['lane'], string> = {
  idle: 'chip-muted',
  ready: 'chip-muted',
  running: 'chip-warn',
  done: 'chip-success',
  failed: 'chip-danger',
  skipped: 'chip-muted',
  awaiting: 'chip-warn',
  paused: 'chip-warn'
};

export function WorkflowStageSummary({
  run,
  stage,
  onApprove,
  onRetry,
  onDiagnose,
  diagnosing
}: WorkflowStageSummaryProps): React.JSX.Element {
  const [evidence, setEvidence] = useState<WorkflowEvidenceView | undefined>();
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [copiedLog, setCopiedLog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (stage.attempts > 0) {
      setLoadingEvidence(true);
      window.praxis.workflows
        .getEvidence(run.runId, stage.nodeId, stage.attempts)
        .then(result => {
          if (!cancelled) {
            setEvidence(result);
            setLoadingEvidence(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setEvidence(undefined);
            setLoadingEvidence(false);
          }
        });
    } else {
      setEvidence(undefined);
      setLoadingEvidence(false);
    }
    return () => {
      cancelled = true;
    };
  }, [run.runId, stage.nodeId, stage.attempts]);

  const copyLog = async () => {
    if (!evidence?.content) return;
    try {
      await navigator.clipboard.writeText(evidence.content);
      setCopiedLog(true);
      setTimeout(() => setCopiedLog(false), 2000);
    } catch {
      /* clipboard write failed */
    }
  };

  const retryAction = run.actions.find(a => a.kind === 'retry-stage' && a.nodeId === stage.nodeId);
  const approveAction = run.actions.find(a => a.kind === 'approve' && a.nodeId === stage.nodeId);

  // Relevant gates for this stage or approval
  const gateRows = (stage.requiredGates ?? (stage.gate ? [stage.gate] : [])).map(gateKind => {
    const gateStatus = run.gates.find(g => g.gate === gateKind);
    return {
      gate: gateKind,
      state: gateStatus?.state ?? 'pending',
      detail: gateStatus?.detail
    };
  });

  return (
    <div className="wf-stage-summary" data-testid="wf-stage-summary">
      {/* Header Banner */}
      <header className="wf-stage-summary-header">
        <div className="wf-stage-summary-header-main">
          <div className="wf-stage-summary-title-line">
            <h2 className="wf-stage-summary-title">{stage.name}</h2>
            <span className={`chip ${LANE_STATUS_CHIP[stage.lane] ?? 'chip-muted'}`}>
              {stage.pause ? 'paused' : stage.lane === 'done' ? 'passed' : stage.lane}
            </span>
            <span className="chip chip-muted">{stage.type}</span>
          </div>
          <div className="wf-stage-summary-meta">
            {stage.durationMs !== undefined && (
              <span>Duration: {(stage.durationMs / 1000).toFixed(1)}s</span>
            )}
            {stage.attempts > 0 && (
              <span>
                Attempt {stage.attempts}
                {stage.maxAttempts ? ` of ${stage.maxAttempts}` : ''}
              </span>
            )}
            {stage.snapshotRef && (
              <span>
                Snapshot: <code>{stage.snapshotRef.slice(0, 8)}</code>
              </span>
            )}
          </div>
          {run.explanation && (
            <p className="wf-stage-summary-explanation rail-sub">{run.explanation}</p>
          )}
        </div>

        <div className="wf-stage-summary-header-actions">
          {retryAction && onRetry && (
            <button
              type="button"
              className="btn btn-compact"
              onClick={() => onRetry(stage.nodeId)}
              title="Retry this step"
            >
              <Icon name="refresh" size={13} />
              <span>Retry step</span>
            </button>
          )}
          {stage.type === 'check' && stage.outcome === 'failed' && onDiagnose && (
            <button
              type="button"
              className="btn btn-compact"
              disabled={diagnosing}
              onClick={onDiagnose}
              title="Diagnose this check failure with an agent"
            >
              <Icon name="sparkles" size={13} />
              <span>{diagnosing ? 'Diagnosing…' : 'Diagnose with AI'}</span>
            </button>
          )}
        </div>
      </header>

      {/* Human Approval or Merge Card */}
      {(stage.type === 'approval' || stage.type === 'merge') && (
        <section className="wf-stage-summary-card wf-stage-summary-approval">
          <div className="wf-stage-summary-card-header">
            <Icon name={stage.type === 'approval' ? 'check' : 'git-branch'} size={18} />
            <h3 className="wf-stage-summary-card-title">
              {stage.type === 'approval' ? 'Human Approval Gate' : 'Delivery Merge Step'}
            </h3>
          </div>
          <p className="wf-stage-summary-prompt">
            {stage.prompt ||
              (stage.type === 'merge'
                ? 'All quality gates and approvals have passed. Merge changes to the base branch?'
                : 'Review, QA, and security checks have completed. Sign off on changes?')}
          </p>

          {gateRows.length > 0 && (
            <div className="wf-stage-summary-gates-checklist">
              <span className="wf-stage-summary-subheading">Quality Gates Checklist:</span>
              <div className="chip-row">
                {gateRows.map(g => (
                  <span key={g.gate} className={`chip ${GATE_CHIP[g.state] ?? 'chip-muted'}`}>
                    <strong>{g.gate}:</strong> {g.state}
                  </span>
                ))}
              </div>
            </div>
          )}

          {approveAction && onApprove && (
            <div className="wf-stage-summary-approval-cta">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onApprove(stage.nodeId)}
              >
                <Icon name="check" size={14} />
                <span>{stage.type === 'merge' ? 'Confirm and Merge' : 'Approve Delivery'}</span>
              </button>
            </div>
          )}
        </section>
      )}

      {/* Command & Status */}
      {stage.command && (
        <section className="wf-stage-summary-card">
          <div className="wf-stage-summary-card-header">
            <Icon name="terminal" size={16} />
            <h3 className="wf-stage-summary-card-title">Executed Command</h3>
            {stage.exitCode !== undefined && (
              <span className={`chip ${stage.exitCode === 0 ? 'chip-success' : 'chip-danger'}`}>
                exit code {stage.exitCode}
              </span>
            )}
          </div>
          <div className="wf-stage-summary-command-line">
            <code>$ {stage.command}</code>
          </div>
        </section>
      )}

      {/* Metrics & Test Results */}
      {stage.findings?.metrics && Object.keys(stage.findings.metrics).length > 0 && (
        <section className="wf-stage-summary-card">
          <div className="wf-stage-summary-card-header">
            <Icon name="graph" size={16} />
            <h3 className="wf-stage-summary-card-title">Test Results &amp; Findings Metrics</h3>
          </div>
          <div className="wf-stage-summary-metrics-grid">
            {Object.entries(stage.findings.metrics).map(([key, value]) => (
              <div key={key} className="wf-stage-summary-metric-box">
                <span className="wf-stage-summary-metric-label">{key}</span>
                <span className="wf-stage-summary-metric-value">{value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error Banner if attempt failed */}
      {stage.lastError && (
        <div className="wf-stage-error-box">
          <Icon name="warning" size={16} />
          <div className="wf-stage-error-text">
            <strong>Error:</strong>
            <p>{stage.lastError}</p>
          </div>
        </div>
      )}

      {/* Execution Log */}
      <section className="wf-stage-summary-log-section">
        <div className="wf-stage-summary-log-header">
          <div className="wf-stage-summary-log-title">
            <Icon name="file" size={14} />
            <span>Execution Log (Attempt {stage.attempts || 1})</span>
            {evidence?.entry?.storedBytes !== undefined && (
              <span className="rail-sub">
                ({(evidence.entry.storedBytes / 1024).toFixed(1)} KB)
              </span>
            )}
          </div>
          <div className="wf-stage-summary-log-actions">
            {evidence?.content && (
              <button
                type="button"
                className="btn btn-compact btn-quiet"
                onClick={() => void copyLog()}
                title="Copy log to clipboard"
              >
                <Icon name={copiedLog ? 'check' : 'copy'} size={12} />
                <span>{copiedLog ? 'Copied' : 'Copy log'}</span>
              </button>
            )}
          </div>
        </div>

        <div className="wf-stage-summary-log-viewport">
          {loadingEvidence ? (
            <div className="wf-stage-summary-log-placeholder">Loading execution output…</div>
          ) : evidence?.content ? (
            <pre className="wf-stage-summary-log-content">{evidence.content}</pre>
          ) : (
            <div className="wf-stage-summary-log-placeholder">
              {stage.attempts === 0
                ? 'This stage has not been executed yet.'
                : 'No retained log for this execution attempt.'}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
