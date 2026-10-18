import { useEffect, useState } from 'react';
import type { AiProvider, ModelChoice } from '@praxis/core';
import { ChipSelect } from '../../ui/ChipSelect';
import { fetchModelOptions } from '../../ai/modelProviders';
import { formatContextLength, formatModelCost, getKnownContextLength, modelPriceLabel } from '../../ai/sessionNav';
import { DebouncedTextField } from '../settingsFields';

export const MODEL_TIER_NAMES = ['fast', 'standard', 'strong'] as const;

export type ModelTierName = (typeof MODEL_TIER_NAMES)[number];

const CUSTOM_MODEL = '__custom__';

/**
 * One provider's model tiers: what fast, standard and strong mean *for this provider*. Each tier is a
 * pick from the provider's real model list (so an id cannot be mistyped into one that does not exist);
 * a provider with no list, or a model outside it, falls back to typing an id. A tier left unset makes
 * a stage use the run's model.
 */
export function ProviderModelTiers({
  provider,
  tiers,
  onChange
}: {
  provider: AiProvider;
  tiers: { fast?: string; standard?: string; strong?: string };
  onChange: (next: { fast?: string; standard?: string; strong?: string }) => void;
}) {
  const [catalog, setCatalog] = useState<ModelChoice[] | undefined>();
  const [loading, setLoading] = useState(true);
  const [customTiers, setCustomTiers] = useState<Partial<Record<ModelTierName, boolean>>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchModelOptions(provider, false)
      .then(options => {
        if (!cancelled) setCatalog(options?.options);
      })
      .catch(() => {
        if (!cancelled) setCatalog(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const commit = (tier: ModelTierName, value: string) => {
    const next = { ...tiers, [tier]: value.trim() || undefined };
    onChange(Object.fromEntries(Object.entries(next).filter(([, model]) => model)) as typeof tiers);
  };

  return (
    <div className="model-tiers-field" data-testid={`ai-model-tiers-${provider}`}>
      {MODEL_TIER_NAMES.map(tier => {
        const current = tiers[tier] ?? '';
        const listed = !!catalog?.some(choice => choice.value === current);
        const typing = !catalog || customTiers[tier] || (!!current && !listed);
        return (
          <label key={tier} className="model-tiers-row">
            <span>{tier}</span>
            {typing ? (
              <span className="model-tiers-typed">
                <DebouncedTextField
                  ariaLabel={`${tier} tier model`}
                  value={current}
                  onCommit={value => commit(tier, value)}
                  placeholder="model id (blank = the run's model)"
                />
                {catalog && (
                  <button
                    type="button"
                    className="btn btn-compact"
                    onClick={() => {
                      setCustomTiers(state => ({ ...state, [tier]: false }));
                      if (current && !listed) commit(tier, '');
                    }}
                  >
                    Pick from list
                  </button>
                )}
              </span>
            ) : (
              <ChipSelect
                block
                ariaLabel={`${tier} tier model`}
                data-testid={`ai-model-tier-${provider}-${tier}`}
                value={current}
                searchable
                onChange={value => {
                  if (value === CUSTOM_MODEL) setCustomTiers(state => ({ ...state, [tier]: true }));
                  else commit(tier, value);
                }}
                options={[
                  { value: '', label: "The run's model" },
                  ...catalog!.map(choice => ({
                    value: choice.value,
                    label: choice.name || choice.value,
                    description: choice.name && choice.name !== choice.value ? choice.value : undefined,
                    meta: [
                      formatContextLength(choice.contextLength ?? getKnownContextLength(choice.value, provider))
                        ?? choice.contextLabel,
                      modelPriceLabel(choice.pricingLabel ?? formatModelCost(choice.pricing))
                    ].filter(Boolean).join(' · ') || undefined
                  })),
                  { value: CUSTOM_MODEL, label: 'Other model id…', icon: 'pencil' as const }
                ]}
              />
            )}
          </label>
        );
      })}
      {!loading && !catalog && (
        <p className="settings-hint">This provider has no model list to pick from, so type the model ids.</p>
      )}
    </div>
  );
}
