import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentSessionRecord,
  AiProvider,
  AiProviderStatus,
  AppSettings,
  AppSettingsPatch,
  CustomProviderConfig,
  LocalRuntimeDetection,
  ProviderPreset
} from '@praxis/core';
import { ChipSelect } from '../../ui/ChipSelect';
import { Icon } from '../../ui/Icon';
import { ProviderBrandLogo } from '../../ui/ProviderBrandLogo';
import { useDialogs } from '../../ui/dialogs';
import { isProviderUsableForSessions } from '../../ai/providerAvailability';
import { sessionsWithinDays } from '../../ai/sessionNav';
import { AddProviderDialog, type BuiltInCatalogEntry, type EndpointEditTarget } from '../AiProviderCatalog';
import { RemoveProviderDialog } from '../RemoveProviderDialog';
import { ProviderDetail } from './ProviderDetail';
import { ProviderModelsPage } from './ProviderModelsPage';
import { ProviderRail } from './ProviderRail';
import { BehaviourTab, RoutingTab, ToolsTab } from './AiProviderTabs';
import { AI_PROVIDERS, customMeta, providerHealth, shortLabel, type AiProviderMeta, type AiTab } from './providerMeta';
import './aiProviders.css';

const TABS: Array<{ id: AiTab; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'routing', label: 'Routing' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'tools', label: 'Tools' }
];

/**
 * Settings → AI Providers. Providers is a list of the providers in use beside
 * the selected one's details (connection, models, usage); Routing says where
 * work goes; Behaviour and Tools hold the agent-wide settings. API keys are
 * write-only — they go straight to the OS keychain via `ai:setApiKey` and the
 * status snapshot only ever reports where a key came from.
 */
export function AiProvidersSection({ settings, update, category, onOpenUsage }: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  category: { label: string; description: string };
  onOpenUsage?: () => void;
}) {
  const { confirm } = useDialogs();
  const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [detected, setDetected] = useState<LocalRuntimeDetection[]>();
  const [tab, setTab] = useState<AiTab>('providers');
  const [selectedId, setSelectedId] = useState<AiProvider>(settings.ai.activeProvider);
  const [modelsFor, setModelsFor] = useState<AiProvider>();
  const [setupFocus, setSetupFocus] = useState<AiProvider>();
  const [adding, setAdding] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointEditTarget>();
  const [removingProvider, setRemovingProvider] = useState<AiProviderMeta>();
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState<string>();
  const [error, setError] = useState<string>();
  const [resettingKeys, setResettingKeys] = useState(false);
  const customProviders = settings.ai.customProviders ?? [];

  const reloadStatuses = useCallback(() => {
    window.praxis.ai
      .listProviderStatuses()
      .then(setStatuses)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(reloadStatuses, [reloadStatuses]);
  useEffect(() => {
    window.praxis.ai.listProviderPresets().then(setPresets).catch(() => setPresets([]));
    window.praxis.ai.listSessions()
      .then(list => setSessions(sessionsWithinDays(list.map(({ events: _events, ...rest }) => ({ ...rest, events: [] })), 30)))
      .catch(() => setSessions([]));
  }, []);

  // Detection asks local ports, so only when the catalog is opened — never just for visiting Settings.
  useEffect(() => {
    if (!adding || detected) return;
    window.praxis.ai.detectLocalRuntimes().then(setDetected).catch(() => setDetected([]));
  }, [adding, detected]);

  /**
   * The Providers tab lists the providers in use: configured (key saved / CLI found), the default,
   * `added`, or a custom endpoint. Everything else waits in Add provider.
   */
  const isListed = (id: AiProvider): boolean => {
    if (settings.ai.activeProvider === id) return true;
    if (settings.ai.providers[id]?.added === false) return false;
    if (settings.ai.providers[id]?.added) return true;
    if (id.startsWith('custom:')) return true;
    return statuses.find(status => status.provider === id)?.configured === true;
  };
  const listedMetas: AiProviderMeta[] = [...AI_PROVIDERS.filter(meta => isListed(meta.id)), ...customProviders.map(customMeta)];
  const listedIds = new Set<string>(listedMetas.map(meta => meta.id));
  const unlistedBuiltIns = AI_PROVIDERS.filter(meta => !listedIds.has(meta.id)).length;
  const catalogBuiltIns: BuiltInCatalogEntry[] = AI_PROVIDERS.map(meta => ({ id: meta.id, kind: meta.kind, label: meta.label }));

  const selectedMeta = listedMetas.find(meta => meta.id === selectedId) ?? listedMetas[0];
  useEffect(() => {
    if (selectedMeta && selectedMeta.id !== selectedId) setSelectedId(selectedMeta.id);
  }, [selectedMeta, selectedId]);

  const recentByProvider = useMemo(() => {
    const map = new Map<string, AgentSessionRecord[]>();
    for (const session of sessions) {
      if (!session.provider) continue;
      map.set(session.provider, [...(map.get(session.provider) ?? []), session]);
    }
    return map;
  }, [sessions]);

  const select = (id: AiProvider) => {
    setSelectedId(id);
    setModelsFor(undefined);
  };

  const toggleEnabled = (meta: AiProviderMeta) => {
    const status = statuses.find(candidate => candidate.provider === meta.id);
    if (!status?.configured) {
      select(meta.id);
      setSetupFocus(meta.id);
      return;
    }
    const on = settings.ai.providers[meta.id]?.enabled !== false;
    void update({ ai: { providers: { [meta.id]: { ...(settings.ai.providers[meta.id] ?? {}), enabled: !on } } } }).then(reloadStatuses);
  };

  const makeDefault = (id: AiProvider) =>
    update({ ai: { activeProvider: id, providers: { [id]: { ...(settings.ai.providers[id] ?? {}), enabled: true } } } }).then(reloadStatuses);

  const addBuiltIn = async (id: AiProvider) => {
    setAdding(false);
    await update({ ai: { providers: { [id]: { ...(settings.ai.providers[id] ?? {}), added: true, enabled: true } } } });
    reloadStatuses();
    select(id);
    setTab('providers');
    if (statuses.find(status => status.provider === id)?.configured !== true) setSetupFocus(id);
  };

  const removeProvider = async (replacement?: AiProvider) => {
    if (!removingProvider || removing || listedMetas.length <= 1) return;
    const id = removingProvider.id;
    const isDefault = settings.ai.activeProvider === id;
    if (isDefault && (!replacement || !listedMetas.some(meta => meta.id === replacement && meta.id !== id))) return;
    setRemoving(true);
    setRemovalError(undefined);
    try {
      await update({ ai: {
        ...(isDefault ? { activeProvider: replacement } : {}),
        ...(settings.ai.recommendationProvider === id ? { recommendationProvider: undefined } : {}),
        providers: {
          [id]: { ...(settings.ai.providers[id] ?? {}), added: false, enabled: false },
          ...(isDefault && replacement ? { [replacement]: { ...(settings.ai.providers[replacement] ?? {}), enabled: true } } : {})
        }
      } });
      if (id.startsWith('custom:')) await window.praxis.ai.removeCustomProvider(id);
      select(replacement ?? settings.ai.activeProvider);
      setRemovingProvider(undefined);
      reloadStatuses();
    } catch (err) {
      setRemovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  const resetProviderKeys = async () => {
    if (!(await confirm({ title: 'Reset saved AI provider keys?', message: 'You will need to enter them again.', confirmLabel: 'Reset keys', danger: true }))) return;
    setResettingKeys(true);
    setError(undefined);
    try {
      await window.praxis.ai.resetProviderApiKeys();
      setStatuses([]);
      reloadStatuses();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResettingKeys(false);
    }
  };

  const statusOf = (id: AiProvider) => statuses.find(status => status.provider === id);
  const readyCount = listedMetas.filter(meta => {
    const health = providerHealth(statusOf(meta.id), settings.ai.providers[meta.id]?.enabled !== false);
    return health === 'ready' || health === 'chat-only';
  }).length;
  /** Who can take new sessions: set up, on, and able to run tools — plus the current default, so the picker never blanks. */
  const defaultChoices = listedMetas.filter(meta => {
    const status = statusOf(meta.id);
    const enabled = settings.ai.providers[meta.id]?.enabled !== false;
    return meta.id === settings.ai.activeProvider || (status && isProviderUsableForSessions({ ...status, enabled }));
  });
  const activeMeta = listedMetas.find(meta => meta.id === settings.ai.activeProvider);

  const openModels = (id: AiProvider) => {
    setTab('providers');
    setSelectedId(id);
    setModelsFor(id);
  };

  const modelsMeta = modelsFor ? listedMetas.find(meta => meta.id === modelsFor) : undefined;

  return (
    <section className="aip" data-testid="settings-ai-providers">
      {removingProvider && (
        <RemoveProviderDialog
          provider={removingProvider}
          isDefault={settings.ai.activeProvider === removingProvider.id}
          remaining={listedMetas
            .filter(meta => meta.id !== removingProvider.id)
            .map(meta => {
              const status = statusOf(meta.id);
              const enabled = settings.ai.providers[meta.id]?.enabled !== false;
              const usable = status ? isProviderUsableForSessions({ ...status, enabled }) : false;
              return {
                id: meta.id,
                label: shortLabel(meta),
                kind: meta.kind,
                detail: usable
                  ? (meta.id === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[meta.id]?.defaultModel) || (meta.kind === 'cli-agent' ? 'Agent’s own default model' : 'Service default model')
                  : !status?.configured ? 'Not set up yet' : status.capabilities && !status.capabilities.tools ? 'Chat only — can’t run sessions' : 'Turned off',
                usable
              };
            })}
          busy={removing}
          error={removalError}
          onClose={() => setRemovingProvider(undefined)}
          onRemove={replacement => void removeProvider(replacement)}
        />
      )}

      <div className="settings-category-header aip-page-head">
        <div>
          <h3 className="settings-section-title">{category.label}</h3>
          <p className="settings-section-description">{category.description}</p>
        </div>
        <div className="settings-category-actions">
          <button type="button" className="btn btn-primary" data-testid="ai-add-provider" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Add provider
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          {error.includes('safeStorage.decryptString') && (
            <button type="button" className="btn" data-testid="ai-reset-provider-keys" disabled={resettingKeys} onClick={() => void resetProviderKeys()}>
              {resettingKeys ? 'Resetting…' : 'Reset encrypted provider keys'}
            </button>
          )}
        </div>
      )}

      <div className="settings-tabs" role="tablist" aria-label="AI provider settings" data-testid="ai-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`ai-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`ai-tabpanel-${entry.id}`}
            className={tab === entry.id ? 'active' : ''}
            data-testid={`ai-tab-${entry.id}`}
            onClick={() => { setTab(entry.id); setModelsFor(undefined); }}
          >
            {entry.label}
            {entry.id === 'providers' && <span className="aip-tab-count">{listedMetas.length}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`ai-tabpanel-${tab}`} aria-labelledby={`ai-tab-${tab}`} data-testid={`ai-tabpanel-${tab}`} className="aip-panel">
        {tab === 'providers' && modelsMeta && (
          <ProviderModelsPage meta={modelsMeta} settings={settings} update={update} onBack={() => setModelsFor(undefined)} />
        )}
        {tab === 'providers' && !modelsMeta && (
          <>
            <div className="aip-route" data-testid="ai-default-strip">
              <span className="aip-route-label">New sessions use</span>
              <ChipSelect
                ariaLabel="Default provider for new sessions"
                data-testid="ai-default-provider-select"
                icon={activeMeta ? <ProviderBrandLogo provider={activeMeta.id} size={14} decorative /> : undefined}
                value={settings.ai.activeProvider}
                onChange={value => void makeDefault(value as AiProvider)}
                options={defaultChoices.map(meta => ({
                  value: meta.id,
                  label: shortLabel(meta),
                  icon: <ProviderBrandLogo provider={meta.id} size={14} decorative />
                }))}
              />
              <span className="aip-muted aip-route-hint">
                Any ready provider. Recommendations and workflow tiers live in{' '}
                <button type="button" className="aip-link-button" onClick={() => setTab('routing')}>Routing</button>.
              </span>
              <span className="aip-route-ready" data-testid="ai-ready-count">
                <span className={`aip-dot ${readyCount > 0 ? 'is-ok' : 'is-warn'}`} aria-hidden />
                <strong>{readyCount} of {listedMetas.length}</strong> ready
              </span>
            </div>

            <div className="aip-md">
              <div className="aip-rail-col">
                <ProviderRail
                  metas={listedMetas}
                  statuses={statuses}
                  settings={settings}
                  customProviders={customProviders}
                  selectedId={selectedMeta?.id ?? settings.ai.activeProvider}
                  onSelect={select}
                />
                <p className="aip-hint aip-rail-foot" data-testid="ai-providers-footnote">
                  {unlistedBuiltIns > 0 ? `${unlistedBuiltIns} more built-in provider${unlistedBuiltIns === 1 ? '' : 's'} and ` : ''}
                  {presets.filter(preset => preset.group !== 'custom').length} OpenAI-compatible presets are in{' '}
                  <button type="button" className="aip-link-button" onClick={() => setAdding(true)}>Add provider</button>.
                  {listedMetas.length === 1 && ' Keep at least one AI provider.'}
                </p>
              </div>
              {selectedMeta && (
                <ProviderDetail
                  key={selectedMeta.id}
                  meta={selectedMeta}
                  status={statusOf(selectedMeta.id)}
                  settings={settings}
                  update={update}
                  custom={customProviders.find(config => config.id === selectedMeta.id)}
                  presets={presets}
                  isDefault={settings.ai.activeProvider === selectedMeta.id}
                  canRemove={listedMetas.length > 1 && !removing}
                  recentSessions={recentByProvider.get(selectedMeta.id) ?? []}
                  focusSetup={setupFocus === selectedMeta.id}
                  onSetupFocused={() => setSetupFocus(undefined)}
                  reloadStatuses={reloadStatuses}
                  onToggleEnabled={() => toggleEnabled(selectedMeta)}
                  onMakeDefault={() => void makeDefault(selectedMeta.id)}
                  onRemove={() => { setRemovalError(undefined); setRemovingProvider(selectedMeta); }}
                  onManageModels={() => openModels(selectedMeta.id)}
                  onEditEndpoint={() => {
                    const config = customProviders.find(entry => entry.id === selectedMeta.id);
                    if (config) setEditingEndpoint({
                      config,
                      defaultModel: settings.ai.providers[config.id]?.defaultModel ?? '',
                      keySaved: statusOf(config.id)?.keySource === 'secret'
                    });
                  }}
                  onOpenUsage={onOpenUsage}
                />
              )}
            </div>
          </>
        )}
        {tab === 'routing' && (
          <RoutingTab
            settings={settings}
            update={update}
            metas={listedMetas}
            statuses={statuses}
            allMetas={[...AI_PROVIDERS, ...customProviders.map(customMeta)]}
            onMakeDefault={id => void makeDefault(id)}
            onOpenModels={openModels}
          />
        )}
        {tab === 'behaviour' && <BehaviourTab settings={settings} update={update} />}
        {tab === 'tools' && <ToolsTab settings={settings} update={update} />}
      </div>

      {(adding || editingEndpoint) && (
        <AddProviderDialog
          builtIns={catalogBuiltIns}
          listed={listedIds}
          statuses={statuses}
          presets={presets}
          customProviders={customProviders}
          detected={detected}
          editing={editingEndpoint}
          onClose={() => { setAdding(false); setEditingEndpoint(undefined); }}
          onPickBuiltIn={id => void addBuiltIn(id)}
          onEndpointSaved={(config: CustomProviderConfig) => {
            setAdding(false);
            setEditingEndpoint(undefined);
            reloadStatuses();
            setTab('providers');
            select(config.id);
          }}
        />
      )}
    </section>
  );
}
