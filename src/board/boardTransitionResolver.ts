import type { WorkflowTransition } from '../types';

function normalizeLoose(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Picks a workflow transition whose `toStatus` matches the board column status name.
 */
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
