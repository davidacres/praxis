/**
 * Dedicated status rendering for a deployment node (FX-BE-058 / TASK-155).
 *
 * A deployment stage settles through the same generic `node-started` /
 * `node-succeeded` / `node-failed` commands every other node uses — the run
 * engine does not know a deployment has two halves. What it *does* know is
 * `WorkflowNodeState.phase`, a free-form label a caller may report mid-attempt
 * via the `node-progress` command (`workflowRun.ts`). This module is the other
 * half: it turns `(outcome, phase)` into a small closed set of display phases
 * so the designer and monitor can show "Deploying" and "Verifying" as visibly
 * different states rather than collapsing both into one undifferentiated
 * "running" dot — exactly the story's "show deploy/verify separately".
 *
 * The two phase labels below deliberately match `DeploymentRun`'s own
 * `'deploying'` / `'verifying'` statuses (`projects/deploymentRunState.ts`),
 * so a future executor (FX-BE-059) that drives a workflow deployment stage
 * from a real `DeploymentRun` can report its phase with the run's own status
 * string verbatim rather than translating between two vocabularies.
 */

import type { WorkflowNodeOutcome } from './workflowTypes';

/** The phase a deployment stage reports while it is running — see the module doc. */
export const DEPLOYMENT_NODE_PHASE_DEPLOYING = 'deploying';
export const DEPLOYMENT_NODE_PHASE_VERIFYING = 'verifying';

export type WorkflowDeploymentDisplayPhase =
  | 'not-started'
  | 'deploying'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * Maps a deployment node's engine-level outcome plus its own reported phase to
 * one label for display.
 *
 * A running stage that has not yet reported a phase reads as `'deploying'` —
 * the earliest sub-phase, and the honest default before any progress signal
 * has arrived, rather than a bare "running" that hides which half is underway.
 * An unrecognized phase string falls back the same way, so a stray or
 * forward-incompatible value degrades to the same safe default instead of
 * surfacing as `undefined`.
 */
export function deploymentNodeDisplayPhase(
  outcome: WorkflowNodeOutcome,
  phase: string | undefined
): WorkflowDeploymentDisplayPhase {
  switch (outcome) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return phase === DEPLOYMENT_NODE_PHASE_VERIFYING ? 'verifying' : 'deploying';
    case 'pending':
    case 'ready':
    default:
      return 'not-started';
  }
}

/** A short label for the display phase, for a status line or chip. */
export function deploymentNodeDisplayPhaseLabel(phase: WorkflowDeploymentDisplayPhase): string {
  switch (phase) {
    case 'not-started':
      return 'Not started';
    case 'deploying':
      return 'Deploying';
    case 'verifying':
      return 'Verifying';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}
