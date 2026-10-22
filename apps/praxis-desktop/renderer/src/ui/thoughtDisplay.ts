/**
 * Display logic for the shared reasoning widget, kept out of `ThoughtBlock.tsx`
 * so it can be tested: the renderer's test runner type-strips `.ts` files but
 * cannot load `.tsx`, and this mapping is exactly the kind of branch worth
 * pinning down.
 */

/**
 * Why a thought block has nothing to show. Reasoning being absent is a normal,
 * expected outcome for several models — not an error — so an empty block says
 * which case applies instead of rendering a blank.
 *
 * This cannot be inferred from the model name: the same `gpt-6-*` id returns
 * reasoning over `codex-cli` and none over `openai`, because OpenAI's HTTP API
 * keeps reasoning items opaque. The host, which knows the route, supplies it as
 * `AgentSessionRecord.reasoningAvailability`.
 */
export type ThoughtEmptyReason =
  /** The model reasons, but this route never returns the text. */
  | 'unsupported'
  /** The session asked for no reasoning (`reasoningEffort: 'off'`). */
  | 'not-requested'
  /** Nothing is known either way; fall back to a neutral wording. */
  | 'unknown';

/** Mirrors core's `ReasoningAvailability`, which the renderer may only import as a type. */
export type ReasoningAvailability = 'text' | 'opaque' | 'not-requested';

export const EMPTY_REASON_COPY: Record<ThoughtEmptyReason, string> = {
  'unsupported': 'This model doesn’t return reasoning text.',
  'not-requested': 'Reasoning wasn’t requested for this turn.',
  'unknown': 'No reasoning was returned for this turn.'
};

/**
 * Map the host's availability onto what an empty block should say, or
 * `undefined` for "don't show an empty block at all".
 *
 * `undefined` covers two cases that must not be conflated with a reason:
 * `'text'`, where reasoning is still streaming and simply hasn't arrived yet,
 * and `undefined`, where an older record predates the stamp. Announcing "no
 * reasoning was returned" at the start of a turn that will return some would
 * flash on every single turn.
 */
export function thoughtEmptyReasonFor(
  availability: ReasoningAvailability | undefined
): ThoughtEmptyReason | undefined {
  if (!availability || availability === 'text') return undefined;
  return availability === 'opaque' ? 'unsupported' : 'not-requested';
}
