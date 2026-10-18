import type { AiProvider, AiProviderStatus, AppSettings, CustomProviderConfig } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { endpointDisplayUrl } from '../AiProviderCatalog';
import { HealthDot, ProviderMark } from './ProviderDetail';
import { providerHealth, railGroupOf, shortLabel, type AiProviderMeta, type RailGroup } from './providerMeta';

const GROUP_TITLES: Record<RailGroup, string> = {
  cloud: 'Cloud APIs',
  local: 'Local agents',
  endpoints: 'Endpoints'
};

/** One line under a provider's name: what it will run on, or what it still needs. */
function railSubline(meta: AiProviderMeta, status: AiProviderStatus | undefined, settings: AppSettings, custom?: CustomProviderConfig): string {
  if (!status) return 'Checking…';
  const enabled = settings.ai.providers[meta.id]?.enabled !== false;
  if (custom) return endpointDisplayUrl(custom);
  if (!status.configured) return meta.kind === 'cli-agent' ? 'Not installed' : 'Needs an API key';
  if (!enabled) return 'Turned off';
  if (meta.kind === 'cli-agent') {
    const version = status.preflight?.providerVersion;
    return `${version ? `v${version} · ` : ''}uses its own sign-in`;
  }
  const model = meta.id === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[meta.id]?.defaultModel;
  if (model) return model;
  return status.keySource === 'env' ? 'Key from the environment' : 'Service default model';
}

export function ProviderRail({ metas, statuses, settings, customProviders, selectedId, onSelect }: {
  metas: readonly AiProviderMeta[];
  statuses: readonly AiProviderStatus[];
  settings: AppSettings;
  customProviders: readonly CustomProviderConfig[];
  selectedId: AiProvider;
  onSelect: (id: AiProvider) => void;
}) {
  const groups = (['cloud', 'local', 'endpoints'] as const).map(group => ({
    group,
    // The default leads its group; the rest keep catalog order.
    items: metas
      .filter(meta => railGroupOf(meta, customProviders.some(config => config.id === meta.id)) === group)
      .sort((a, b) => Number(b.id === settings.ai.activeProvider) - Number(a.id === settings.ai.activeProvider))
  })).filter(entry => entry.items.length > 0);

  return (
    <nav className="aip-rail" aria-label="AI providers" data-testid="ai-provider-list">
      {groups.map(({ group, items }) => (
        <div key={group} className="aip-rail-group" role="group" aria-label={GROUP_TITLES[group]}>
          <div className="aip-rail-heading"><span>{GROUP_TITLES[group]}</span><span>{items.length}</span></div>
          {items.map(meta => {
            const status = statuses.find(candidate => candidate.provider === meta.id);
            const custom = customProviders.find(config => config.id === meta.id);
            const enabled = settings.ai.providers[meta.id]?.enabled !== false;
            const health = providerHealth(status, enabled);
            const isDefault = settings.ai.activeProvider === meta.id;
            const selected = selectedId === meta.id;
            return (
              <div
                key={meta.id}
                className={`aip-rail-row${selected ? ' is-selected' : ''}${health === 'off' ? ' is-off' : ''}`}
                data-testid={`ai-provider-row-${meta.id}`}
              >
                <button
                  type="button"
                  className="ai-provider-head aip-rail-button"
                  aria-current={selected ? 'true' : undefined}
                  aria-expanded={selected}
                  onClick={() => onSelect(meta.id)}
                >
                  <ProviderMark id={meta.id} kind={meta.kind} size={26} />
                  <span className="aip-rail-text">
                    <span className="aip-rail-name">
                      <span className="aip-ellipsis">{shortLabel(meta)}</span>
                      {isDefault && (
                        <span className="aip-star" data-testid={`ai-provider-default-${meta.id}`} title="Default for new sessions">
                          <Icon name="star" size={11} />
                        </span>
                      )}
                      {health === 'chat-only' && <span className="chip aip-mini-chip">Chat only</span>}
                    </span>
                    <span className={`aip-rail-sub${health === 'setup' ? ' is-warn' : ''}`}>{railSubline(meta, status, settings, custom)}</span>
                  </span>
                  <HealthDot health={health} />
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
