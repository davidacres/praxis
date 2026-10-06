import type { AiProvider, AiSettings, ProviderUsageSnapshot, ProviderUsageSnapshotsResult } from '@praxis/core';

/**
 * Batching for the Overview dashboard's provider budgets (FX-BF-050).
 *
 * Split out of `aiUsageIpc.ts` because that module imports `electron`, which
 * cannot be loaded by `node --test`. The functions here are the parts worth
 * pinning down: which providers get reported on, and what happens when one of
 * them fails.
 */

/**
 * The providers a dashboard should report on: everything the user has not turned
 * off. `enabled` defaults to true when unset, so a provider only drops out when
 * someone explicitly disables it (see `AiProviderConfig`).
 *
 * Custom endpoints are usually absent from `providers` entirely — they are
 * listed in `customProviders` — so they are added rather than filtered out of
 * that map. Deduplicated, because a custom endpoint that also has an entry in
 * `providers` must not produce two cards.
 */
export function enabledUsageProviders(
  ai: Pick<AiSettings, 'providers' | 'customProviders'> & { activeProvider?: AiProvider },
  configuredProviders?: readonly AiProvider[]
): AiProvider[] {
  const custom = (ai.customProviders ?? [])
    .filter(endpoint => ai.providers[endpoint.id]?.enabled !== false)
    .map(endpoint => endpoint.id);
  const explicitKeys = Object.keys(ai.providers) as AiProvider[];
  const candidates = configuredProviders && configuredProviders.length > 0
    ? [...new Set([...explicitKeys, ...configuredProviders, ...(ai.activeProvider ? [ai.activeProvider] : [])])]
    : explicitKeys;
  const builtIn = candidates.filter(id => ai.providers[id]?.enabled !== false);
  const seen = new Set<AiProvider>();
  return [...builtIn, ...custom].filter(id => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * A snapshot has account usage to show when its read succeeded and it reported
 * at least one window. Everything else — `not-configured`, `not-supported`,
 * `fetch-failed`, or a windowless success — is a "No data" card.
 */
export function snapshotHasUsage(snapshot: ProviderUsageSnapshot): boolean {
  return !snapshot.unavailableReason && snapshot.windows.length > 0;
}

/**
 * Providers with account usage first, "No data" cards after, and the input
 * order preserved within each group. Array.prototype.sort is stable (ES2019),
 * so a copy with `comparator 0` keeps the settings order for ties.
 */
export function sortByUsageAvailability(
  snapshots: readonly ProviderUsageSnapshot[]
): ProviderUsageSnapshot[] {
  return [...snapshots].sort((a, b) => Number(snapshotHasUsage(b)) - Number(snapshotHasUsage(a)));
}

/**
 * Fans out one read per provider and keeps every result.
 *
 * `allSettled` is the point of this function: the Codex adapter spawns a CLI
 * process with a multi-second timeout and a MiniMax endpoint can reject its
 * key. Neither failure may blank the other providers' budgets, so a rejection
 * becomes a snapshot carrying its own `unavailableReason` and the panel renders
 * it as "no data" rather than an error.
 */
export async function readProviderSnapshots(
  providers: readonly AiProvider[],
  read: (provider: AiProvider) => Promise<ProviderUsageSnapshot>
): Promise<ProviderUsageSnapshotsResult> {
  const checkedAt = new Date().toISOString();
  const settled = await Promise.allSettled(providers.map(provider => read(provider)));
  const snapshots: ProviderUsageSnapshot[] = settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      // An adapter that predates the code still has to reach the UI with one:
      // a reason with no code is exactly the case the renderer used to label
      // "Offline" for no stated reason.
      const value = outcome.value;
      if (value.unavailableReason && !value.unavailableReasonCode) {
        return { ...value, unavailableReasonCode: 'fetch-failed' };
      }
      return value;
    }
    const reason = outcome.reason;
    return {
      provider: providers[index],
      fetchedAt: checkedAt,
      windows: [],
      unavailableReason: reason instanceof Error ? reason.message : 'This provider did not respond.',
      unavailableReasonCode: 'fetch-failed'
    };
  });
  // The Overview dashboard leads with the providers that actually have account
  // usage to show, so a screen full of "No data" cards does not bury them.
  return { checkedAt, snapshots: sortByUsageAvailability(snapshots) };
}
