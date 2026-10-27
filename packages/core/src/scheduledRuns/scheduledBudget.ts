/**
 * Which AI provider a scheduled ticket may run on, given how much allowance each
 * has used (FX-BF-047 / FX-BE-148 / TASK-386).
 *
 * Pure: the caller supplies the figures. Two things shape the answer:
 *
 * - A provider that already ran out during this ticket (`exclude`) is never
 *   started on again and never handed over to, whatever its reported figures
 *   say — a hard limit arrives long before the quota adapter shows one.
 * - A provider that reports nothing is *unknown*. Unknown is a last resort: it
 *   is preferred to stopping the ticket, but never to a provider with a known
 *   allowance below the threshold. It may always be the provider the run is
 *   already on, because refusing to start anything on a provider that simply
 *   does not report usage would make the schedule useless for it.
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
  /** Providers that ran out during this ticket: never chosen, whatever their figures say. */
  exclude?: readonly string[];
  /**
   * When nothing else can run, an excluded provider may still be chosen rather
   * than stopping the ticket. Used when starting work: a limit an hour ago may
   * have cleared, and refusing to start anything at all is worse than trying.
   */
  excludedAsLastResort?: boolean;
  threshold?: number;
}

export type ProviderDecision =
  /** Carry on with `provider`. `allowanceKnown` is false when its usage is not reported. */
  | { kind: 'ok'; provider: string; allowanceKnown: boolean; usedFraction?: number; reason: string }
  /** The active provider is at the threshold; move to `provider`. */
  | { kind: 'handover'; provider: string; from?: string; usedFraction?: number; allowanceKnown?: boolean; reason: string }
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
  const exclude = input.exclude ?? [];
  if (input.usable.length === 0) {
    return { kind: 'pause', why: 'no-provider', reason: 'No AI provider is enabled and set up to run the tickets.' };
  }
  // `current` is what the ticket is actually on; `active` is that provider when it is still an option.
  const current = input.active && input.usable.includes(input.active) ? input.active : undefined;
  const spent = current !== undefined && exclude.includes(current);
  // Anything already spent is out — unless there is nothing else to run on and the caller would rather
  // try again than stop the ticket (a limit an hour ago may have cleared).
  const open = input.usable.filter(provider => !exclude.includes(provider));
  const retryingSpent = open.length === 0 && !!input.excludedAsLastResort;
  const candidates = retryingSpent ? [...input.usable] : open;
  if (candidates.length === 0) {
    return { kind: 'pause', why: 'budget', reason: `Every provider that is set up ran out during this ticket (${exclude.join(', ')}).` };
  }
  const active = current !== undefined && candidates.includes(current) ? current : undefined;
  if (active) {
    const used = input.used[active];
    if (!known(used)) {
      return { kind: 'ok', provider: active, allowanceKnown: false, reason: `${active} does not report its allowance, so it could not be checked.` };
    }
    if (used < threshold) {
      return { kind: 'ok', provider: active, allowanceKnown: true, usedFraction: used, reason: `${active} has used ${percent(used)} of its allowance.` };
    }
  }

  const others = candidates.filter(provider => provider !== current);
  // Known and below the threshold first, most room left first; a provider that reports nothing only
  // when nothing better is left, which beats stopping a ticket that could still run.
  const free = others
    .filter(provider => known(input.used[provider]) && (input.used[provider] as number) < threshold)
    .sort((left, right) => (input.used[left] as number) - (input.used[right] as number));
  const unknown = others.filter(provider => !known(input.used[provider]));
  const next = free[0] ?? unknown[0];
  if (next) {
    const described = known(input.used[next]) ? `${percent(input.used[next] as number)} used` : 'allowance not reported';
    const usedCurrent = current ? input.used[current] : undefined;
    return {
      kind: 'handover',
      provider: next,
      ...(current ? { from: current } : {}),
      ...(known(usedCurrent) ? { usedFraction: usedCurrent } : {}),
      ...(!free.length ? { allowanceKnown: false } : {}),
      reason: !current
        ? `Starting on ${next} (${described}).`
        : spent
          ? `${current} ran out; moving to ${next} (${described}).`
          : `${current} has used ${percent(usedCurrent as number)} of its allowance; moving to ${next} (${described}).`
    };
  }
  return {
    kind: 'pause',
    why: 'budget',
    reason: spent
      ? `${current} ran out and no other provider is available to move the ticket to.`
      : current
        ? `${current} has used ${percent(input.used[current] as number)} of its allowance and every other provider is at or past ${percent(threshold)}.`
        : `No provider has an allowance below ${percent(threshold)}.`
  };
}

/**
 * Allowance a ticket is assumed to need while it runs, as a share of a
 * provider's allowance (FX-BE-149). Deliberately generous: it only decides
 * whether an *extra* lane may start, and guessing low is how an overnight run
 * empties a plan.
 */
export const LANE_ALLOWANCE_RESERVE = 0.1;

export interface ExtraLaneInput {
  /** The provider the extra ticket would start on. */
  provider: string;
  /** That provider's allowance used, 0-1; undefined when it does not report. */
  used: number | undefined;
  /** Tickets already running on that provider in this run. */
  alongside: number;
  threshold?: number;
}

/**
 * Whether one more ticket may start while others are running. The first ticket
 * of a run never asks: this is only for a second lane and beyond. Unknown usage
 * refuses, because the run cannot tell whether there is room for two.
 */
export function decideExtraLane(input: ExtraLaneInput): { ok: boolean; reason: string } {
  const threshold = input.threshold ?? DEFAULT_HANDOVER_THRESHOLD;
  const tickets = input.alongside + 1;
  if (!known(input.used)) {
    return { ok: false, reason: `${input.provider} does not report its allowance, so no extra ticket starts alongside the ones running.` };
  }
  const room = threshold - input.used;
  const needed = tickets * LANE_ALLOWANCE_RESERVE;
  const head = `${input.provider} has used ${percent(input.used)}, leaving ${percent(Math.max(0, room))} before the ${percent(threshold)} hand-over point`;
  return room + 1e-9 >= needed
    ? { ok: true, reason: `${head}: room for ${tickets} ticket${tickets === 1 ? '' : 's'} at ${percent(LANE_ALLOWANCE_RESERVE)} each.` }
    : { ok: false, reason: `${head}: not enough for ${tickets} tickets at ${percent(LANE_ALLOWANCE_RESERVE)} each, so the next one waits.` };
}
