/**
 * The port a tool executor asks before a side effect (FX-BF-048 / TASK-393).
 *
 * Praxis's own executors — the gateway agent's `write_file` and `run_shell`, the ACP
 * host's `fs/write_text_file`, the in-app browser tools — call `acquire` before they act
 * and `release` after. A refusal means the side effect does not happen: the tool returns
 * the owner and reason to the agent instead. The host decides what the gate talks to.
 */

import type { ClaimLifetime, CoordinationRequestItem } from './coordinationTypes';

export type GateDecision =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: string };

export interface CoordinationGate {
  acquire(input: { items: CoordinationRequestItem[]; reason: string; lifetime?: ClaimLifetime; requestId?: string }): Promise<GateDecision>;
  /** The worktree root paths are claimed under. */
  readonly worktree: string;
}

/** The message a refused tool hands back to the agent: who has it, and what to do. */
export function refusalForAgent(reason: string): string {
  return `Not done: ${reason} Another session is using it. Work on something else, or wait and try again later; do not retry in a loop.`;
}
