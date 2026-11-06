import type { ConversationTurn, DurableConversation } from '@praxis/core';

/**
 * Whether an assistant error stays on screen (TASK-484, AC-E: "errors remain visible until
 * resolved").
 *
 * A snapshot that merely no longer carries the error string is *not* a resolution: the panel is
 * fed by `getConversation` reads that can lag, and a lagging read used to blank a failure the user
 * had not yet acted on. An error clears only when the turn or attempt that produced it is settled
 * (`completed`, `cancelled`, or superseded by a newer attempt on the same turn), or when the user
 * dismisses it. An error that cannot be attributed to the snapshot at all — a rejected command, a
 * failed page-context apply, a transport fault — has no turn to settle, so it stays until it is
 * dismissed or replaced by the next thing that happens.
 */

/** Turn states after which nothing further can fail for that turn. */
const SETTLED_TURN_STATES: readonly string[] = ['completed', 'cancelled'];

/** Error strings still actionable in a snapshot: the live turn's latest failure or context block. */
export function unresolvedSnapshotErrors(snapshot: DurableConversation): Set<string> {
  const errors = new Set<string>();
  for (const turn of snapshot.turns) {
    if (SETTLED_TURN_STATES.includes(turn.state)) continue;
    const error = latestAttempt(turn)?.error;
    if (error) errors.add(error);
    if (turn.contextRequiredReason) errors.add(turn.contextRequiredReason);
  }
  return errors;
}

function latestAttempt(turn: ConversationTurn) {
  return turn.attempts.at(-1);
}

/** Every error or context-required reason a snapshot recorded, on any attempt or turn. */
function attributedErrors(snapshot: DurableConversation): Set<string> {
  const errors = new Set<string>();
  for (const turn of snapshot.turns) {
    if (turn.contextRequiredReason) errors.add(turn.contextRequiredReason);
    for (const attempt of turn.attempts) if (attempt.error) errors.add(attempt.error);
  }
  return errors;
}

export interface AssistantErrorInput {
  /** The error currently shown, if any. */
  previous?: string;
  /** The authoritative snapshot the panel is rendering; `undefined` while one is loading. */
  snapshot?: DurableConversation;
  /** The snapshot before this one, so an error that left it can be recognised as resolved. */
  previousSnapshot?: DurableConversation;
  /** An error raised since the last evaluation (a command rejection, a subscription fault). */
  incomingError?: string;
  /** The user clicked the banner's dismiss control. */
  userDismissed?: boolean;
  /** The panel now shows a different conversation, so the error's subject is no longer on screen. */
  conversationChanged?: boolean;
  /** The submission whose acknowledgement was lost has now been accepted — that is its resolution. */
  submissionAcknowledged?: boolean;
}

/** The error to show after this evaluation, or `undefined` for none. */
export function resolveAssistantError({ previous, snapshot, previousSnapshot, incomingError, userDismissed, conversationChanged, submissionAcknowledged }: AssistantErrorInput): string | undefined {
  // Something just failed. It replaces whatever was on screen, resolved or not.
  if (incomingError !== undefined) return incomingError;
  if (userDismissed) return undefined;
  // Not a resolution: the error belongs to a conversation that is no longer the one on screen.
  if (conversationChanged) return undefined;
  if (!previous) return undefined;
  if (snapshot) {
    // Still actionable in the snapshot: a failure nobody has resolved yet stays visible.
    if (unresolvedSnapshotErrors(snapshot).has(previous)) return previous;
    // Attributable to a turn that has since settled, moved on to a newer attempt, or stopped
    // requiring context: the transition away from it *is* the resolution.
    if (attributedErrors(snapshot).has(previous)) return undefined;
    if (previousSnapshot && attributedErrors(previousSnapshot).has(previous)) return undefined;
  } else if (!submissionAcknowledged && !conversationChanged) {
    // No snapshot to judge against: a reload must not silently drop a live failure.
    return previous;
  }
  // Not attributable to any turn — a command, apply or transport error. It stays until dismissed
  // or until the submission it came from is acknowledged; it never clears by itself.
  return submissionAcknowledged ? undefined : previous;
}
