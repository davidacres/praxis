/**
 * Gadget lifecycle: expiry, supersession, reconnect and duplicate submission
 * (TASK-284).
 *
 * A gadget's state is *derived*, never stored as the single source of truth.
 * The inputs are the envelope, the clock, what the ledger knows about the
 * submission, and whether the client is currently connected — so a renderer
 * that reconnects recomputes the same answer the host would, rather than
 * trusting a flag that may be from before the disconnect.
 */
import type { AnyGadgetEnvelope, ChatBlock, GadgetActionStatus, GadgetError, GadgetLifecycleState } from './contracts';

export interface GadgetLifecycleContext {
  /** ISO timestamp to evaluate against. */
  now: string;
  /** Gadget IDs a later gadget declared it supersedes. */
  supersededIds?: ReadonlySet<string>;
  /** The ledger's latest status for this gadget, if it has been acted on. */
  submissionStatus?: GadgetActionStatus;
  /** False while the renderer cannot reach the host. */
  connected?: boolean;
}

export function isGadgetExpired(envelope: AnyGadgetEnvelope, now: string): boolean {
  if (!envelope.expiresAt) return false;
  return Date.parse(envelope.expiresAt) <= Date.parse(now);
}

/**
 * Resolve the state to render.
 *
 * Precedence is deliberate and the ordering is the interesting part:
 *
 * 1. `revoked` — the host explicitly withdrew it; nothing else matters.
 * 2. a recorded submission — *the user already acted*. That outranks
 *    supersession and expiry, because relabelling a decision somebody made as
 *    "expired" reads as though their answer was thrown away.
 * 3. `superseded` — a newer gadget replaced this one.
 * 4. `expired` — the window closed before anyone answered.
 * 5. `disconnected` — still live, but we cannot vouch for it right now, so it
 *    must not accept input.
 */
export function resolveGadgetState(envelope: AnyGadgetEnvelope, context: GadgetLifecycleContext): GadgetLifecycleState {
  if (envelope.state === 'revoked') return 'revoked';
  if (envelope.state === 'submitting') return 'submitting';

  switch (context.submissionStatus) {
    case 'completed':
      return 'completed';
    case 'accepted':
      return 'submitted';
    case 'rejected':
    case 'failed':
      // A refused submission leaves the gadget usable — the user fixes the
      // input and tries again. That is why rejection is not terminal.
      break;
    default:
      break;
  }

  if (context.supersededIds?.has(envelope.gadgetId)) return 'superseded';
  if (isGadgetExpired(envelope, context.now)) return 'expired';
  if (context.connected === false) return 'disconnected';
  return 'active';
}

/** Only `active` accepts input; everything else renders visibly inert. */
export function isGadgetActionable(state: GadgetLifecycleState): boolean {
  return state === 'active';
}

/** Why a gadget cannot be acted on, phrased for the user. */
export function describeInertState(state: GadgetLifecycleState): string | undefined {
  switch (state) {
    case 'submitted':
      return 'Your answer was recorded. Waiting for the host to finish.';
    case 'completed':
      return 'This decision has been made.';
    case 'expired':
      return 'This expired before it was answered. Ask again to get a fresh one.';
    case 'superseded':
      return 'A newer version of this replaced it.';
    case 'revoked':
      return 'This was withdrawn and can no longer be answered.';
    case 'disconnected':
      return 'Disconnected from the host, so this cannot be submitted right now.';
    case 'submitting':
      return 'Submitting…';
    default:
      return undefined;
  }
}

/**
 * Collect every gadget ID superseded by a later block.
 *
 * Supersession chains: if C supersedes B and B supersedes A, both A and B are
 * inert. Walking the declarations rather than only the immediate predecessor is
 * what makes a streaming update that revises the same gadget three times leave
 * exactly one live surface.
 */
export function collectSupersededIds(blocks: readonly ChatBlock[]): Set<string> {
  const superseded = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'gadget') continue;
    const replaced = block.gadget.supersedes;
    if (replaced) superseded.add(replaced);
  }
  return superseded;
}

/**
 * Apply a streaming update to an ordered block list.
 *
 * An update either replaces the block with the same `gadgetId` in place — so a
 * progress gadget refreshing does not jump to the bottom of the transcript —
 * or appends when it is genuinely new.
 */
export function applyGadgetUpdate(blocks: readonly ChatBlock[], updated: ChatBlock): ChatBlock[] {
  if (updated.type !== 'gadget') return [...blocks, updated];
  const index = blocks.findIndex(block => block.type === 'gadget' && block.gadget.gadgetId === updated.gadget.gadgetId);
  if (index === -1) return [...blocks, updated];
  const next = [...blocks];
  next[index] = updated;
  return next;
}

/** The error a stale gadget's submission is refused with. */
export function inertStateError(state: GadgetLifecycleState): GadgetError | undefined {
  switch (state) {
    case 'expired':
      return { code: 'gadget-expired', message: 'This expired before it was answered.', retryable: false };
    case 'superseded':
      return { code: 'gadget-superseded', message: 'A newer version of this replaced it.', retryable: false };
    case 'submitted':
    case 'completed':
      return { code: 'already-submitted', message: 'This has already been answered.', retryable: false };
    case 'revoked':
      return { code: 'gadget-not-found', message: 'This was withdrawn and can no longer be answered.', retryable: false };
    case 'disconnected':
      return { code: 'scope-mismatch', message: 'Not connected to the host that issued this.', retryable: true };
    default:
      return undefined;
  }
}
