import { useEffect, useState } from 'react';
import type { AiProvider, AiProviderConfig, AppSettingsPatch, ModelOptions } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { fetchModelOptions } from './modelProviders';
import { formatContextLength, formatModelCost, getKnownContextLength, getModelPricing, modelPriceLabel, modelPriceTitle } from './sessionNav';

export interface ModelManagerPanelProps {
  providerId: AiProvider;
  providerLabel: string;
  /** Undefined means "no curation — every fetched model is offered" (the default). */
  enabledModelIds: string[] | undefined;
  providerConfig: AiProviderConfig;
  onBack: () => void;
  update: (patch: AppSettingsPatch) => Promise<void>;
}

/**
 * The composer's "Configure models" dialog — browse a provider's full
 * fetched catalog (Vercel AI Gateway can run to 300+ entries) and curate
 * which ones the composer's per-session Model picker offers. Settings has
 * its own fuller page for the same curation (`settings/aiProviders/ProviderModelsPage.tsx`). Reuses the
 * same `fetchModelOptions`/cache the composer uses (`modelCatalog.ts`), so
 * this reflects exactly what a session would see, unfiltered.
 */
export function ModelManagerPanel({
  providerId,
  providerLabel,
  enabledModelIds,
  providerConfig,
  onBack,
  update
}: ModelManagerPanelProps) {
  const [catalog, setCatalog] = useState<ModelOptions | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState('');

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
    // `knownModelIds` records what curation was made against, so a model added upstream later shows as New.
    const known = next === undefined ? undefined : catalog?.options.map(option => option.value);
    update({ ai: { providers: { [providerId]: { ...providerConfig, enabledModelIds: next, knownModelIds: known } } } }).catch(err => {
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

  // Composer-opened curation renders as a standard dialog: titlebar with icon
  // actions and a close button, a full-width search row, scrolling model rows,
  // and the dialog action (Done) in the footer.
  return (
    <div className="conn-form model-manager-chips" data-testid="model-manager-panel">
      <div className="modal-header">
        <div className="model-manager-heading">
          <h3>{providerLabel} — Models</h3>
          <p className="settings-hint">Choose the models offered in this provider’s model picker. Changes save automatically.</p>
        </div>
        <button
          type="button"
          className="btn-icon"
          title="Enable all models"
          aria-label="Enable all models"
          data-testid="model-manager-select-all"
          disabled={loading || !catalog}
          onClick={() => setEnabledIds(undefined)}
        >
          <Icon name="check-square" size={14} />
        </button>
        <button
          type="button"
          className="btn-icon"
          title="Disable all models"
          aria-label="Disable all models"
          data-testid="model-manager-select-none"
          disabled={loading || !catalog}
          onClick={() => setEnabledIds([])}
        >
          <Icon name="close-square" size={14} />
        </button>
        <button
          type="button"
          className="btn-icon"
          title="Refresh catalog"
          aria-label="Refresh catalog"
          data-testid="model-manager-refresh"
          disabled={loading}
          onClick={() => load(true)}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" className="btn-icon" title="Close" aria-label="Close" data-testid="model-manager-close" onClick={onBack}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="model-manager-search-bar">
        <Icon name="search" size={13} />
        <input
          type="text"
          className="input"
          placeholder="Filter models…"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          data-testid="model-manager-filter"
          autoFocus
        />
      </div>
      <div className="conn-form-body">
        {error && (
          <div className="error-banner" data-testid="model-manager-error">
            {error}
          </div>
        )}
        {loading && <p className="placeholder-text">Loading catalog…</p>}
        {!loading && catalog && (
          <div className="model-manager-list" data-testid="model-manager-list">
            {filteredOptions.length === 0 && <p className="placeholder-text">No matching models.</p>}
            {filteredOptions.map(option => {
              const contextSize = formatContextLength(option.contextLength ?? getKnownContextLength(option.value, providerId)) ?? option.contextLabel;
              const cost = modelPriceLabel(option.pricingLabel ?? formatModelCost(option.pricing ?? getModelPricing(providerId, option.value)));
              return (
                <div className="model-manager-chip-row" key={option.value} data-testid="model-manager-chip-row">
                  <span className="model-manager-chip-name" title={option.value}>{option.name}</span>
                  <span className="model-manager-chip-meta" data-testid="model-badges">
                    {contextSize && <span className="composer-model-badge is-context">{contextSize}</span>}
                    {cost && <span className="composer-model-badge is-cost" title={modelPriceTitle(option.pricingLabel)}>{cost}</span>}
                  </span>
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={isEnabled(option.value)}
                    aria-label={option.name}
                    data-testid={`model-manager-toggle-${option.value}`}
                    onClick={() => toggle(option.value)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <span className="settings-hint" data-testid="model-manager-count">
          {catalog ? `${enabledCount} of ${totalCount} selected` : '—'}
        </span>
        <button type="button" className="btn btn-primary" data-testid="model-manager-done" onClick={onBack}>
          Done
        </button>
      </div>
    </div>
  );
}
