/**
 * The renderer's local view of the gadget contract.
 *
 * Types come from core, but **values must not** — a value import from
 * `@praxis/core` anywhere under `renderer/src` compiles clean under `tsc` and
 * only dies in `vite build`, with an error about a native binding three layers
 * down (see AGENTS.md, and `scripts/checkCoreImports.cjs`, which enforces it).
 * So the handful of constants and pure predicates the renderer needs are
 * duplicated here, exactly as `settingsDefaults.ts` duplicates `parseHexRgb`.
 *
 * Keep this file in step with `packages/core/src/ai/gadgets/`. It is small on
 * purpose: anything bigger belongs host-side, behind IPC.
 */
import type {
  AnyGadgetEnvelope,
  GadgetActionResult,
  GadgetActionValue,
  GadgetKind,
  GadgetLifecycleState,
  GadgetPayloadMap
} from '@praxis/core';

/** Mirrors `GADGET_CONTRACT_VERSION` in core. */
export const GADGET_CONTRACT_VERSION = 1;

/** Mirrors `isGadgetActionable` — only a live gadget takes input. */
export function isGadgetActionable(state: GadgetLifecycleState | undefined): boolean {
  return state === 'active';
}

/** Mirrors `describeInertState` — why a gadget cannot be answered right now. */
export function describeInertState(state: GadgetLifecycleState | undefined): string | undefined {
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
 * Narrow an envelope's payload to the kind the renderer was registered for.
 *
 * The registry guarantees the correlation — a renderer registered under
 * `'table'` is only ever handed a table envelope — but the union cannot express
 * that at the call site, so it is asserted once here instead of in every file.
 */
export function payloadOf<K extends GadgetKind>(gadget: AnyGadgetEnvelope): GadgetPayloadMap[K] {
  return gadget.payload as GadgetPayloadMap[K];
}

export interface GadgetRendererProps {
  gadget: AnyGadgetEnvelope;
  /** False when the gadget is expired, superseded, already answered or offline. */
  actionable: boolean;
  /** A submission is in flight; controls stay visible but refuse further input. */
  busy: boolean;
  /** The host's answer to the last submission, if there was one. */
  result?: GadgetActionResult;
  onSubmit: (actionId: string, value: GadgetActionValue) => void;
}

export type GadgetRenderer = (props: GadgetRendererProps) => JSX.Element;
