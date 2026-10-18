import { useEffect, useState } from 'react';
import type { AiProviderConfig, AppSettings, AppSettingsPatch, ModelOptions, ReasoningEffort } from '@praxis/core';
import { ChipSelect } from '../../ui/ChipSelect';
import { Icon } from '../../ui/Icon';
import { fetchModelOptions, supportsReasoningEffort } from '../../ai/modelProviders';
import { formatContextLength, formatModelCost, getKnownContextLength, getModelPricing, modelPriceLabel, modelPriceTitle } from '../../ai/sessionNav';
import { MODEL_TIER_NAMES, ProviderModelTiers } from './ModelTiers';
import { ProviderMark } from './ProviderDetail';
import { shortLabel, type AiProviderMeta } from './providerMeta';

const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

type OfferFilter = 'all' | 'offered' | 'not-offered';

/**
 * Settings → AI Providers → a provider → Models. Where new sessions start, what
 * each workflow tier runs on, and which models the composer offers — the
 * provider's full fetched catalog (the gateway can list 300+), curated with an
 * allow-list. Reuses the composer's `fetchModelOptions` cache, so this shows
 * exactly what a session would see.
 */
export function ProviderModelsPage({ meta, settings, update, onBack }: {
  meta: AiProviderMeta;
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  onBack: () => void;
}) {
  const providerId = meta.id;
  const config: AiProviderConfig = settings.ai.providers[providerId] ?? {};
  const tiers = settings.ai.modelTiers?.[providerId] ?? {};
  const isVercel = providerId === 'vercel-gateway';
  const defaultModel = isVercel ? settings.ai.defaultModel : config.defaultModel ?? '';

  const [catalog, setCatalog] = useState<ModelOptions | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [offer, setOffer] = useState<OfferFilter>('all');
  const [fetchedAt, setFetchedAt] = useState<number>();
  // Local optimistic mirror of the persisted `enabledModelIds` — `update()` waits for the settings
  // broadcaster to echo back, and two quick clicks would otherwise both read the same stale prop and
  // the second write would clobber the first. The functional setState form makes rapid clicks safe.
  const [localEnabledIds, setLocalEnabledIds] = useState<string[] | undefined>(config.enabledModelIds);

  const load = (forceRefresh: boolean) => {
    setLoading(true);
    setError(undefined);
    fetchModelOptions(providerId, forceRefresh)
      .then(options => {
        if (!options) setError('No models were returned — check the provider is configured with a working API key.');
        setCatalog(options);
        setFetchedAt(Date.now());
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(false);
    setLocalEnabledIds(config.enabledModelIds);
    // Only resync from settings on a provider switch — local state is the source of truth while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const allIds = catalog?.options.map(option => option.value) ?? [];
  const isEnabled = (id: string): boolean => localEnabledIds === undefined || localEnabledIds.includes(id);
  /** A model the catalog lists now that it did not list when the user curated — it arrives unchecked. */
  const isNew = (id: string): boolean => localEnabledIds !== undefined && config.knownModelIds !== undefined && !config.knownModelIds.includes(id);

  const persist = (next: string[] | undefined) => {
    update({
      ai: { providers: { [providerId]: { ...config, enabledModelIds: next, knownModelIds: next === undefined ? undefined : allIds } } }
    }).catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const setEnabledIds = (next: string[] | undefined) => {
    setLocalEnabledIds(next);
    persist(next);
  };

  const toggle = (id: string) => {
    setLocalEnabledIds(current => {
      const currentIds = current ?? allIds;
      const next = currentIds.includes(id) ? currentIds.filter(value => value !== id) : [...currentIds, id];
      // Offering every fetched model is the same as no curation — keep it unset so a later catalog
      // refresh offers new models automatically instead of silently leaving them out.
      const resolved = next.length === allIds.length ? undefined : next;
      persist(resolved);
      return resolved;
    });
  };

  const reasoningDefaultOf = (modelId: string): ReasoningEffort => config.modelReasoningDefaults?.[modelId] ?? 'medium';
  const setReasoningDefault = (modelId: string, level: ReasoningEffort) => {
    update({ ai: { providers: { [providerId]: { ...config, modelReasoningDefaults: { ...(config.modelReasoningDefaults ?? {}), [modelId]: level } } } } })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const saveTiers = (entry: { fast?: string; standard?: string; strong?: string }) => {
    const next = { ...(settings.ai.modelTiers ?? {}) };
    if (Object.keys(entry).length > 0) next[providerId] = entry;
    else delete next[providerId];
    void update({ ai: { modelTiers: next } });
  };

  const commitDefault = (value: string) =>
    isVercel
      ? update({ ai: { defaultModel: value } })
      : update({ ai: { providers: { [providerId]: { ...config, defaultModel: value || undefined } } } });

  const options = catalog?.options ?? [];
  const offeredCount = localEnabledIds === undefined ? options.length : options.filter(option => localEnabledIds.includes(option.value)).length;
  const needle = filter.trim().toLowerCase();
  const rows = options.filter(option =>
    (!needle || option.name.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle))
    && (offer === 'all' || (offer === 'offered') === isEnabled(option.value))
  );
  const tierOf = (id: string) => MODEL_TIER_NAMES.find(tier => tiers[tier] === id);
  const label = shortLabel(meta);
  const metaFor = (value: string) => {
    const choice = options.find(option => option.value === value);
    if (!choice) return undefined;
    return [
      formatContextLength(choice.contextLength ?? getKnownContextLength(choice.value, providerId)) ?? choice.contextLabel,
      modelPriceLabel(choice.pricingLabel ?? formatModelCost(choice.pricing ?? getModelPricing(providerId, choice.value)))
    ].filter(Boolean).join(' · ') || undefined;
  };

  return (
    <div className="aip-models" data-testid="model-manager-panel">
      <nav className="aip-crumbs" aria-label="Breadcrumb">
        <button type="button" className="aip-link-button" data-testid="model-manager-back" onClick={onBack}>
          <Icon name="arrow-left" size={12} />
          AI Providers
        </button>
        <span aria-hidden>›</span>
        <button type="button" className="aip-link-button" onClick={onBack}>{label}</button>
        <span aria-hidden>›</span>
        <span>Models</span>
      </nav>
      <header className="aip-models-head">
        <ProviderMark id={meta.id} kind={meta.kind} size={34} />
        <div>
          <h3>{label} models</h3>
          <p className="aip-muted">Where sessions start, what each workflow tier runs on, and what the composer offers.</p>
        </div>
        <span className="aip-spacer" />
        {fetchedAt && !loading && <span className="aip-muted aip-nowrap">Catalog fetched {new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        <button type="button" className="btn" aria-label="Refresh catalog" data-testid="model-manager-refresh" disabled={loading} onClick={() => load(true)}>
          <Icon name="refresh" size={12} />
          Refresh
        </button>
      </header>

      <section className="aip-assign" aria-label="Model assignments">
        {meta.kind === 'api' && (
          <label className="aip-assign-default">
            <span className="aip-assign-label"><Icon name="star" size={10} />New sessions start on</span>
            <ChipSelect
              block
              searchable
              allowCustom
              ariaLabel="New sessions start on"
              data-testid="model-manager-default"
              value={defaultModel}
              placeholder="Service default"
              onChange={value => void commitDefault(value)}
              options={[
                { value: '', label: 'Service default' },
                ...options.map(option => ({ value: option.value, label: option.name || option.value, description: option.name && option.name !== option.value ? option.value : undefined, meta: metaFor(option.value) }))
              ]}
            />
          </label>
        )}
        <div className="aip-assign-tiers">
          <ProviderModelTiers key={providerId} provider={providerId} tiers={tiers} onChange={saveTiers} />
        </div>
      </section>

      <div className="aip-models-tools model-manager-search-bar">
        <span className="aip-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="input"
            placeholder="Filter models…"
            aria-label="Filter models"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            data-testid="model-manager-filter"
          />
        </span>
        <div className="aip-segments" role="radiogroup" aria-label="Show">
          {([['all', 'All', options.length], ['offered', 'Offered', offeredCount], ['not-offered', 'Not offered', options.length - offeredCount]] as const).map(([value, text, count]) => (
            <button key={value} type="button" role="radio" aria-checked={offer === value} className={offer === value ? 'is-on' : ''} onClick={() => setOffer(value)}>
              {text} <b>{count}</b>
            </button>
          ))}
        </div>
        <span className="aip-spacer" />
        <span className="aip-muted" data-testid="model-manager-count">{catalog ? `${offeredCount} of ${options.length} offered` : '—'}</span>
        <button type="button" className="btn btn-compact" data-testid="model-manager-select-all" disabled={loading || !catalog} onClick={() => setEnabledIds(undefined)}>Offer all</button>
        <button type="button" className="btn btn-compact" data-testid="model-manager-select-none" disabled={loading || !catalog} onClick={() => setEnabledIds([])}>Offer none</button>
      </div>

      {error && <div className="error-banner" data-testid="model-manager-error">{error}</div>}
      {loading && <p className="aip-muted aip-models-empty">Loading catalog…</p>}
      {!loading && catalog && (
        <div className="aip-table-wrap">
          <table className="aip-table" data-testid="model-manager-list">
            <thead>
              <tr><th className="aip-col-offer">Offer</th><th>Model</th><th className="aip-col-num">Context</th><th className="aip-col-price">Price / 1M tokens</th><th className="aip-col-reason">Reasoning</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="aip-muted aip-models-empty">No matching models.</td></tr>
              )}
              {rows.map(option => {
                const enabled = isEnabled(option.value);
                const tier = tierOf(option.value);
                const context = formatContextLength(option.contextLength ?? getKnownContextLength(option.value, providerId)) ?? option.contextLabel;
                const cost = modelPriceLabel(option.pricingLabel ?? formatModelCost(option.pricing ?? getModelPricing(providerId, option.value)));
                const fresh = isNew(option.value);
                return (
                  <tr key={option.value} className={`${enabled ? '' : 'is-off'}${fresh ? ' is-new' : ''}`} data-testid="model-manager-row">
                    <td className="aip-col-offer">
                      <input
                        type="checkbox"
                        checked={enabled}
                        aria-label={`Offer ${option.name}`}
                        onChange={() => toggle(option.value)}
                        data-testid={`model-manager-checkbox-${option.value}`}
                      />
                    </td>
                    <td>
                      <div className="aip-model-name">
                        <strong className="aip-ellipsis" title={option.value}>{option.name}</strong>
                        {defaultModel === option.value && <span className="chip aip-default-chip"><Icon name="star" size={9} />Default</span>}
                        {tier && <span className="chip aip-outline-chip" data-testid={`model-manager-tier-${option.value}`} data-value={tier}>{tier}</span>}
                        {fresh && <span className="chip aip-info-chip" data-testid={`model-manager-new-${option.value}`}>New</span>}
                      </div>
                      {option.name !== option.value && <div className="aip-mono aip-muted aip-model-id">{option.value}</div>}
                    </td>
                    <td className="aip-col-num">{context ? <span className="composer-model-badge is-context">{context}</span> : <span className="aip-muted">—</span>}</td>
                    <td className="aip-col-price">{cost ? <span className="composer-model-badge is-cost" title={modelPriceTitle(option.pricingLabel)}>{cost}</span> : <span className="aip-muted">—</span>}</td>
                    <td className="aip-col-reason">
                      {supportsReasoningEffort(providerId, option.value) ? (
                        <ChipSelect
                          className="model-manager-tier"
                          ariaLabel={`Default reasoning effort for ${option.name}`}
                          title="Default reasoning/thinking effort new sessions on this model start with"
                          data-testid={`model-manager-reasoning-${option.value}`}
                          value={reasoningDefaultOf(option.value)}
                          onChange={value => setReasoningDefault(option.value, value as ReasoningEffort)}
                          options={REASONING_EFFORT_OPTIONS}
                        />
                      ) : <span className="aip-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="aip-hint aip-models-foot">
        {localEnabledIds === undefined
          ? 'Every model is offered, so new ones appear automatically. Uncheck any to curate the list.'
          : 'Because this list is curated, new models arrive unchecked and tagged New.'}
        {' '}An empty tier uses the run’s model; retrying a stage moves it up a tier.
      </p>
    </div>
  );
}
