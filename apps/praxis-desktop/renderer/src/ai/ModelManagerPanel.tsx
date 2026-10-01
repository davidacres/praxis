import { useEffect, useState } from 'react';
import type { AiProvider, AiProviderConfig, AppSettingsPatch, ModelOptions, ReasoningEffort } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { fetchModelOptions, supportsReasoningEffort } from './modelProviders';
import { ChipSelect } from '../ui/ChipSelect';

const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

type TierName = 'fast' | 'standard' | 'strong';

export interface ModelManagerPanelProps {
  providerId: AiProvider;
  providerLabel: string;
  /** Undefined means "no curation — every fetched model is offered" (the default). */
  enabledModelIds: string[] | undefined;
  providerConfig: AiProviderConfig;
  /** This provider's model tiers (tier → model id). Each row shows, and sets, the tier its model holds. */
  tiers: { fast?: string; standard?: string; strong?: string };
  onTiersChange: (next: { fast?: string; standard?: string; strong?: string }) => void;
  onBack: () => void;
  update: (patch: AppSettingsPatch) => Promise<void>;
}

/**
 * Settings → AI Provider → "Manage models" — browse a provider's full
 * fetched catalog (Vercel AI Gateway can run to 300+ entries) and curate
 * which ones the composer's per-session Model picker offers. Reuses the
 * same `fetchModelOptions`/cache the composer uses (`modelCatalog.ts`), so
 * this reflects exactly what a session would see, unfiltered.
 */
export function ModelManagerPanel({
  providerId,
  providerLabel,
  enabledModelIds,
  providerConfig,
  tiers,
  onTiersChange,
  onBack,
  update
}: ModelManagerPanelProps) {
  const [catalog, setCatalog] = useState<ModelOptions | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState('');

  // A tier holds one model, so a model holds at most one tier: giving it a tier takes that tier from
  // whichever model had it, and drops the tier it held before.
  const tierOf = (modelId: string): TierName | '' =>
    (['fast', 'standard', 'strong'] as const).find(tier => tiers[tier] === modelId) ?? '';
  const setTier = (modelId: string, tier: TierName | '') => {
    const next: typeof tiers = { ...tiers };
    for (const held of ['fast', 'standard', 'strong'] as const) if (next[held] === modelId) delete next[held];
    if (tier) next[tier] = modelId;
    onTiersChange(next);
  };

  // Default reasoning/thinking effort per model (Settings → AI Provider →
  // Manage models). Persisted straight through `providerConfig` — unlike
  // tiers, this map lives per-provider, not at the top level, so no separate
  // callback prop is needed.
  const reasoningDefaultOf = (modelId: string): ReasoningEffort | '' =>
    providerConfig.modelReasoningDefaults?.[modelId] ?? 'medium';
  const setReasoningDefault = (modelId: string, level: ReasoningEffort) => {
    const next = { ...(providerConfig.modelReasoningDefaults ?? {}) };
    next[modelId] = level;
    update({ ai: { providers: { [providerId]: { ...providerConfig, modelReasoningDefaults: next } } } }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  // Local optimistic mirror of the persisted `enabledModelIds` — `update()`
  // doesn't apply its patch optimistically (it waits for the settings
  // broadcaster to echo back), and that round trip is slow enough that two
  // quick clicks would otherwise both read the same stale prop and the
  // second click's write would clobber the first. Reading/writing through
  // local state instead (via the functional setState form, so each toggle
  // always sees the previous toggle's result) makes rapid clicks safe.
  const [localEnabledIds, setLocalEnabledIds] = useState<string[] | undefined>(enabledModelIds);

  const load = (forceRefresh: boolean) => {
    setLoading(true);
    setError(undefined);
    fetchModelOptions(providerId, forceRefresh)
      .then(options => {
        if (!options) {
          setError('No models were returned — check the provider is configured with a working API key.');
        }
        setCatalog(options);
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(false);
    setLocalEnabledIds(enabledModelIds);
    // Only resync from the prop on provider switch — `localEnabledIds` is
    // the source of truth while this panel is open for one provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const isEnabled = (id: string): boolean => localEnabledIds === undefined || localEnabledIds.includes(id);

  const persist = (next: string[] | undefined) => {
    update({ ai: { providers: { [providerId]: { ...providerConfig, enabledModelIds: next } } } }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const setEnabledIds = (next: string[] | undefined) => {
    setLocalEnabledIds(next);
    persist(next);
  };

  const toggle = (id: string) => {
    const allIds = catalog?.options.map(o => o.value) ?? [];
    setLocalEnabledIds(current => {
      const currentIds = current ?? allIds;
      const next = currentIds.includes(id) ? currentIds.filter(v => v !== id) : [...currentIds, id];
      // Selecting every fetched model is equivalent to clearing curation —
      // keep the settings value as "no curation" so a later catalog
      // refresh (new models added upstream) shows the new ones
      // automatically instead of silently excluding them.
      const resolved = next.length === allIds.length ? undefined : next;
      persist(resolved);
      return resolved;
    });
  };

  const filteredOptions = (catalog?.options ?? []).filter(option => {
    const query = filter.trim().toLowerCase();
    return !query || option.name.toLowerCase().includes(query) || option.value.toLowerCase().includes(query);
  });

  const totalCount = catalog?.options.length ?? 0;
  const enabledCount = localEnabledIds === undefined ? totalCount : localEnabledIds.length;

  return (
    <div className="conn-form" data-testid="model-manager-panel">
      <header className="view-header">
        <span className="view-title">{providerLabel} — Models</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          data-testid="model-manager-select-all"
          disabled={loading || !catalog}
          onClick={() => setEnabledIds(undefined)}
        >
          Select all
        </button>
        <button
          type="button"
          className="btn"
          data-testid="model-manager-select-none"
          disabled={loading || !catalog}
          onClick={() => setEnabledIds([])}
        >
          Select none
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Refresh catalog"
          data-testid="model-manager-refresh"
          disabled={loading}
          onClick={() => load(true)}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="btn" data-testid="model-manager-back" onClick={onBack}>
          Back
        </button>
      </header>
      <div className="conn-form-body">
        {error && (
          <div className="error-banner" data-testid="model-manager-error">
            {error}
          </div>
        )}
        <p className="placeholder-text">
          Only checked models are offered in the composer's per-session Model picker. Leave everything
          checked (the default) to offer the whole catalog as-is.
          {catalog && (
            <>
              {' '}
              <strong data-testid="model-manager-count">
                {enabledCount} of {totalCount} selected
              </strong>
              .
            </>
          )}
        </p>
        <input
          type="text"
          className="input"
          placeholder="Filter models…"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          data-testid="model-manager-filter"
          style={{ marginBottom: 8 }}
        />
        {loading && <p className="placeholder-text">Loading catalog…</p>}
        {!loading && catalog && (
          <div className="model-manager-list" data-testid="model-manager-list">
            {filteredOptions.length === 0 && <p className="placeholder-text">No matching models.</p>}
            {filteredOptions.map(option => (
              <label className="model-manager-row" key={option.value} data-testid="model-manager-row">
                <input
                  type="checkbox"
                  checked={isEnabled(option.value)}
                  onChange={() => toggle(option.value)}
                  data-testid={`model-manager-checkbox-${option.value}`}
                />
                <span className="model-manager-row-name">{option.name}</span>
                <span className="model-manager-row-id">{option.value}</span>
                <span className="model-manager-tier-wrap" onClick={event => event.stopPropagation()}>
                  <ChipSelect
                    className="model-manager-tier"
                    ariaLabel={`Model tier for ${option.name}`}
                    title="Which workflow tier this model serves on this provider"
                    data-testid={`model-manager-tier-${option.value}`}
                    value={tierOf(option.value)}
                    onChange={value => setTier(option.value, value as TierName | '')}
                    options={[
                      { value: '', label: 'No tier' },
                      { value: 'fast', label: 'Fast' },
                      { value: 'standard', label: 'Standard' },
                      { value: 'strong', label: 'Strong' }
                    ]}
                  />
                </span>
                {supportsReasoningEffort(providerId, option.value) && (
                  <span className="model-manager-tier-wrap" onClick={event => event.stopPropagation()}>
                    <ChipSelect
                      className="model-manager-tier"
                      ariaLabel={`Default reasoning effort for ${option.name}`}
                      title="Default reasoning/thinking effort new sessions on this model start with"
                      data-testid={`model-manager-reasoning-${option.value}`}
                      value={reasoningDefaultOf(option.value)}
                      onChange={value => setReasoningDefault(option.value, value as ReasoningEffort)}
                      options={REASONING_EFFORT_OPTIONS}
                    />
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
