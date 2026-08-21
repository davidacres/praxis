/**
 * Browser-safe copy of the workflow-transition → status-name matcher that lives
 * at `@ticket-manager/core/board/boardTransitionResolver`. The desktop app's
 * frontend bundle cannot `import` from `@ticket-manager/core` directly: core is
 * CommonJS with no `sideEffects: false`, so a single value import drags the
 * whole package — including chokidar, markdown-it, and the backends — into the
 * renderer, which then crashes on `process` not being defined. Re-exporting
 * findTransitionToTargetStatus from core was tried (commit-equivalent), and
 * that path hits the same tree-shake problem.
 *
 * Keeping this tiny, pure matcher in the frontend keeps the bundle rerouted
 * away from Node-only code. If the match rules ever need richer semantics,
 * change both files in lockstep — they are intentionally identical to the
 * core implementation as of 2026-08.
 */
import type { WorkflowTransition } from '@ticket-manager/core';

function normalizeLoose(value: string): string {
  return value.trim().toLowerCase();
}

export function findTransitionToTargetStatus(
  transitions: WorkflowTransition[],
  targetStatus: string
): WorkflowTransition | undefined {
  const target = normalizeLoose(targetStatus);
  if (!target) {
    return undefined;
  }

  const withTo = transitions.filter(
    (t): t is WorkflowTransition & { toStatus: string } =>
      typeof t.toStatus === 'string' && t.toStatus.trim().length > 0
  );

  const exact = withTo.find(t => normalizeLoose(t.toStatus) === target);
  if (exact) {
    return exact;
  }

  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const tc = compact(targetStatus);
  if (tc.length > 0) {
    const loose = withTo.find(t => compact(t.toStatus) === tc);
    if (loose) {
      return loose;
    }
  }

  return undefined;
}
