/**
 * Which AI provider a scheduled ticket may run on, given how much allowance each
 * has used (FX-BF-047 / FX-BE-148 / TASK-386).
 *
 * Pure: the caller supplies the figures. A provider that reports nothing is
 * *unknown*, and unknown is never chosen as a place to move work to — an
 * unattended run must not hand a half-finished ticket to a provider that may
 * already be empty. It may still be the provider the run is already on, because
 * refusing to start anything on a provider that simply does not report usage
 * would make the schedule useless for it.
 */

/** The share of a provider's allowance, 0-1, at which work moves elsewhere. */
export const DEFAULT_HANDOVER_THRESHOLD = 0.95;

export interface ProviderBudgetInput {
  /** The provider the ticket is on, or would start on. */
  active?: string;
  /** Providers that are enabled and set up, in preference order. */
  usable: readonly string[];
  /** Allowance used per provider as a 0-1 fraction; absent or undefined means the provider does not say. */
  used: Readonly<Record<string, number | undefined>>;
  threshold?: number;
}

export type ProviderDecision =
  /** Carry on with `provider`. `allowanceKnown` is false when its usage is not reported. */
  | { kind: 'ok'; provider: string; allowanceKnown: boolean; usedFraction?: number; reason: string }
  /** The active provider is at the threshold; move to `provider`. */
  | { kind: 'handover'; provider: string; from?: string; usedFraction?: number; reason: string }
  /** Nothing safe to run on. */
  | { kind: 'pause'; reason: string; why: 'no-provider' | 'budget' };

/** The highest share used across a provider's allowance windows, or `undefined` when none is reported. */
export function providerHeadroom(windows: ReadonlyArray<number | undefined> | undefined): number | undefined {
  const known = (windows ?? []).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length > 0 ? Math.max(...known) : undefined;
}

function known(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function decideProviderForEntry(input: ProviderBudgetInput): ProviderDecision {
  const threshold = input.threshold ?? DEFAULT_HANDOVER_THRESHOLD;
  const usable = input.usable;
  if (usable.length === 0) {
    return { kind: 'pause', why: 'no-provider', reason: 'No AI provider is enabled and set up to run the tickets.' };
  }

  const active = input.active && usable.includes(input.active) ? input.active : undefined;
  if (active) {
    const used = input.used[active];
    if (!known(used)) {
      return { kind: 'ok', provider: active, allowanceKnown: false, reason: `${active} does not report its allowance, so it could not be checked.` };
    }
    if (used < threshold) {
      return { kind: 'ok', provider: active, allowanceKnown: true, usedFraction: used, reason: `${active} has used ${percent(used)} of its allowance.` };
    }
  }

  const alternatives = usable
    .filter(provider => provider !== active)
    .map(provider => ({ provider, used: input.used[provider] }))
    .filter((candidate): candidate is { provider: string; used: number } => known(candidate.used) && candidate.used < threshold)
    .sort((left, right) => left.used - right.used);
  const usedActive = active ? input.used[active] : undefined;
  if (alternatives.length > 0) {
    const next = alternatives[0];
    return {
      kind: 'handover',
      provider: next.provider,
      ...(active ? { from: active } : {}),
      ...(known(usedActive) ? { usedFraction: usedActive } : {}),
      reason: active
        ? `${active} has used ${percent(usedActive as number)} of its allowance; moving to ${next.provider} (${percent(next.used)} used).`
        : `Starting on ${next.provider} (${percent(next.used)} used).`
    };
  }
  return {
    kind: 'pause',
    why: 'budget',
    reason: active
      ? `${active} has used ${percent(usedActive as number)} of its allowance and no other provider has a known allowance below ${percent(threshold)}.`
      : `No provider has a known allowance below ${percent(threshold)}.`
  };
}
