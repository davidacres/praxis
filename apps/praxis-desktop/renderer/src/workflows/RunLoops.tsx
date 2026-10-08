import type { LoopSummary, WorkflowRunSummary } from '@praxis/core';
import { useDialogs } from '../ui/dialogs';
import { Icon } from '../ui/Icon';

/**
 * A run's loops in the run view (FX-BE-167): the decision a spent loop is waiting
 * for, and what each loop has done so far — every pass, what triggered it, and its
 * score when the loop keeps its best.
 */

/** Mirrors core's `WORKFLOW_MAX_LOOP_ITERATIONS` (the renderer may import only types from core). */
const MAX_LOOP_ITERATIONS = 10;

const STOPPED: Record<NonNullable<LoopSummary['stoppedBecause']>, string> = {
  'condition-met': 'stopped: nothing left to send it round',
  'no-improvement': 'stopped: passes stopped improving',
  accepted: 'stopped: result accepted'
};

/** The loop whose budget ran out, with the three ways forward. Shown above the pipeline. */
export function LoopDecisionNotice({
  run,
  onDecide
}: {
  run: WorkflowRunSummary;
  onDecide: (edgeId: string, decision: 'accept' | 'grant' | 'stop', reason?: string, extraIterations?: number) => Promise<boolean>;
}) {
  const { prompt } = useDialogs();
  const loop = run.loops.find(candidate => candidate.edgeId === run.needsDecision?.edgeId);
  if (!run.needsDecision || !loop) return null;
  const canGrant = loop.budget < MAX_LOOP_ITERATIONS;
  const askReason = (title: string, label: string) =>
    prompt({ title, label, validate: value => (value.trim() ? undefined : 'Say why — it is recorded on the run.') });

  return (
    <div className="wf-run-limit" role="alert" data-testid="wf-loop-decision">
      <strong>
        Needs a decision: {loop.fromName} still reports {loop.condition} after {loop.iterationsTaken} of {loop.budget} pass
        {loop.budget === 1 ? '' : 'es'} back to {loop.toName}
      </strong>
      {loop.openFindings && loop.openFindings.length > 0 && (
        <ul className="wf-loop-findings" aria-label="Open findings">
          {loop.openFindings.map((finding, index) => (
            <li key={index}>
              <span className="chip chip-muted">{finding.severity}</span> {finding.message}
              {finding.file && (
                <code>
                  {' '}
                  {finding.file}
                  {finding.line !== undefined ? `:${finding.line}` : ''}
                </code>
              )}
            </li>
          ))}
        </ul>
      )}
      {loop.keepBest?.bestScore !== undefined && (
        <p>
          Best {loop.keepBest.metric} so far: {loop.keepBest.bestScore} (pass {loop.keepBest.bestIteration}). Accepting ends on the best pass.
        </p>
      )}
      <div className="wf-run-limit-actions">
        <button
          type="button"
          className="btn btn-primary btn-compact"
          data-testid="wf-loop-accept"
          onClick={async () => {
            const reason = await askReason('Accept this result?', 'Why it is good enough as it is');
            if (reason) await onDecide(loop.edgeId, 'accept', reason);
          }}
        >
          Accept as it is
        </button>
        {canGrant && (
          <button
            type="button"
            className="btn btn-compact"
            data-testid="wf-loop-grant"
            onClick={() => void onDecide(loop.edgeId, 'grant', undefined, 1)}
          >
            Allow one more pass
          </button>
        )}
        <button
          type="button"
          className="btn btn-compact btn-danger"
          data-testid="wf-loop-stop"
          onClick={async () => {
            const reason = await askReason('Stop the run?', 'Why the run should stop here');
            if (reason) await onDecide(loop.edgeId, 'stop', reason);
          }}
        >
          Stop the run
        </button>
      </div>
    </div>
  );
}

/** Each loop's passes so far. Hidden for a workflow with no loops. */
export function RunLoopsSection({ run }: { run: WorkflowRunSummary }) {
  if (run.loops.length === 0) return null;
  return (
    <section className="wf-loops" aria-label="Loops" data-testid="wf-loops">
      <h3>Loops</h3>
      {run.loops.map(loop => {
        const status = loop.needsDecision
          ? 'waiting for a decision'
          : loop.firing
            ? 'going round again'
            : loop.iterationsTaken === 0
              ? loop.stoppedBecause === 'condition-met'
                ? 'not needed'
                : 'not needed yet'
              : loop.stoppedBecause
                ? STOPPED[loop.stoppedBecause]
                : 'in progress';
        const scores = [...loop.history.map(row => row.score), loop.keepBest?.currentScore].filter((score): score is number => score !== undefined);
        const top = scores.length ? Math.max(...scores.map(Math.abs), 1) : 1;
        return (
          <div key={loop.edgeId} className="wf-loop" data-testid={`wf-loop-${loop.edgeId}`}>
            <p className="wf-loop-head">
              <Icon name="refresh" size={12} />
              <strong>
                {loop.fromName} → {loop.toName}
              </strong>
              <span className="rail-sub">
                {loop.iterationsTaken}/{loop.budget} · when {loop.condition} · {status}
              </span>
            </p>
            {loop.history.length > 0 && (
              <ol className="wf-loop-history" aria-label={`Passes of ${loop.fromName} back to ${loop.toName}`}>
                {loop.history.map(row => (
                  <li key={row.iteration} data-testid="wf-loop-pass">
                    <span className="wf-loop-pass">#{row.iteration}</span>
                    <span>
                      {row.outcome === 'failed' ? 'failed' : `${row.findingCount} finding${row.findingCount === 1 ? '' : 's'}`}
                      {row.topFindings[0] ? ` — ${row.topFindings[0].message}` : row.error ? ` — ${row.error.split('\n')[0]}` : ''}
                    </span>
                    {row.score !== undefined && (
                      <span className="wf-loop-score" title={`${loop.keepBest?.metric ?? 'score'} ${row.score}`}>
                        <span className="wf-loop-bar" style={{ width: `${Math.max(4, (Math.abs(row.score) / top) * 100)}%` }} />
                        {row.score}
                      </span>
                    )}
                    {row.restoredTo && <span className="chip chip-muted">undone</span>}
                  </li>
                ))}
              </ol>
            )}
            {loop.keepBest?.bestScore !== undefined && (
              <p className="rail-sub" data-testid="wf-loop-best">
                Best {loop.keepBest.metric}: {loop.keepBest.bestScore} (pass {loop.keepBest.bestIteration})
                {loop.keepBest.currentScore !== undefined ? ` · latest ${loop.keepBest.currentScore}` : ''}
              </p>
            )}
            {loop.decisions.map((decision, index) => (
              <p key={index} className="rail-sub">
                {decision.actor} {decision.decision === 'grant' ? `allowed ${decision.extraIterations} more` : decision.decision === 'accept' ? 'accepted the result' : 'stopped the run'}
                {decision.reason ? `: ${decision.reason}` : '.'}
              </p>
            ))}
          </div>
        );
      })}
    </section>
  );
}
