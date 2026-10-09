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
  /**
   * `release` frees the claim. Given `evidence` — host proof the work stopped, such as a
   * process group that no longer exists — it also clears the claim if it had already been
   * sent to recovery (its session ended or went silent while the work ran).
   */
  | { ok: true; release: (evidence?: string) => Promise<void> }
  | { ok: false; reason: string };

/** The longest an agent may wait for a resource in one call: it reports back, then decides. */
export const COORDINATION_MAX_WAIT_MS = 120_000;

export interface CoordinationGate {
  acquire(input: { items: CoordinationRequestItem[]; reason: string; lifetime?: ClaimLifetime; requestId?: string }): Promise<GateDecision>;
  /**
   * Waits — bounded, cancellable — for resources another session holds, in turn order. A
   * grant is a fresh one, held until the turn ends; a timeout or cancellation leaves no
   * waiter behind and says what was still in the way.
   */
  wait?(input: { items: CoordinationRequestItem[]; reason: string; timeoutMs: number; signal?: AbortSignal }): Promise<GateDecision>;
  /** The worktree root paths are claimed under. */
  readonly worktree: string;
}

/** The message a refused tool hands back to the agent: who has it, and what to do. */
export function refusalForAgent(reason: string, waitTool?: string): string {
  const wait = waitTool ? `or call ${waitTool} to wait for it (bounded)` : 'or wait and try again later';
  return `Not done: ${reason} Another session is using it. Work on something else, ${wait}; do not retry in a loop.`;
}
