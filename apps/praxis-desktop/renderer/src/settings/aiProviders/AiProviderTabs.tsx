import { useEffect, useState } from 'react';
import type { AiProvider, AiProviderStatus, AppSettings, AppSettingsPatch } from '@praxis/core';
import { ChipSelect } from '../../ui/ChipSelect';
import { Icon } from '../../ui/Icon';
import { ProviderBrandLogo } from '../../ui/ProviderBrandLogo';
import { fetchModelOptions, hasModelCatalog } from '../../ai/modelProviders';
import { isProviderUsableForSessions } from '../../ai/providerAvailability';
import { DebouncedTextArea, DebouncedTextField, Toggle } from '../settingsFields';
import { McpServersPanel } from '../McpServersPanel';
import { ProviderMark } from './ProviderDetail';
import { MODEL_TIER_NAMES } from './ModelTiers';
import { shortLabel, type AiProviderMeta } from './providerMeta';

function TabCard({ title, aside, children, testId }: { title: string; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="aip-card" aria-label={title} data-testid={testId}>
      <h4 className="aip-card-title"><span>{title}</span>{aside && <span className="aip-card-aside">{aside}</span>}</h4>
      {children}
    </section>
  );
}

function SettingLine({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="aip-setting">
      <div className="aip-setting-label">
        <strong>{label}</strong>
        {help && <span className="aip-hint">{help}</span>}
      </div>
      <div className="aip-setting-control">{children}</div>
    </div>
  );
}

/** Routing: where new sessions and quick recommendations go, and what each workflow tier runs on per provider. */
export function RoutingTab({ settings, update, metas, statuses, allMetas, onMakeDefault, onOpenModels }: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  metas: readonly AiProviderMeta[];
  statuses: readonly AiProviderStatus[];
  allMetas: readonly AiProviderMeta[];
  onMakeDefault: (id: AiProvider) => void;
  onOpenModels: (id: AiProvider) => void;
}) {
  const statusOf = (id: AiProvider) => statuses.find(status => status.provider === id);
  const sessionReady = metas.filter(meta => {
    const status = statusOf(meta.id);
    return status ? isProviderUsableForSessions(status) : false;
  });
  const defaultChoices = metas.filter(meta => meta.id === settings.ai.activeProvider || sessionReady.includes(meta));
  // Same list as new sessions; a stored choice that no longer qualifies stays listed (marked) so the
  // picker never shows a blank for a value that is really stored.
  const storedRecommendation = settings.ai.recommendationProvider
    ? allMetas.find(meta => meta.id === settings.ai.recommendationProvider && !defaultChoices.includes(meta))
    : undefined;
  const recommendationChoices = storedRecommendation ? [...defaultChoices, storedRecommendation] : defaultChoices;
  const chatOnly = metas.filter(meta => {
    const status = statusOf(meta.id);
    return status?.configured && status.capabilities && !status.capabilities.tools;
  });

  const promptProvider = settings.ai.promptAnalysisProvider;
  const promptChoices = metas.filter(meta => {
    const status = statusOf(meta.id);
    return status?.configured && status.enabled !== false;
  });
  const storedPrompt = allMetas.find(meta => meta.id === promptProvider && !promptChoices.some(choice => choice.id === meta.id));
  if (storedPrompt) promptChoices.push(storedPrompt);
  const [promptModels, setPromptModels] = useState<{ provider: string; options: Array<{ value: string; label: string }> }>();
  useEffect(() => {
    let current = true;
    if (promptProvider) void fetchModelOptions(promptProvider, false).then(result => {
      if (current) setPromptModels({ provider: promptProvider, options: result?.options.map(option => ({ value: option.value, label: option.name })) ?? [] });
    }).catch(() => { if (current) setPromptModels({ provider: promptProvider, options: [] }); });
    return () => { current = false; };
  }, [promptProvider]);
  const promptModelChoices = promptModels && promptModels.provider === promptProvider ? [...promptModels.options] : [];
  for (const value of [settings.ai.promptAnalysisModel, promptProvider && settings.ai.providers[promptProvider]?.defaultModel]) {
    if (value && !promptModelChoices.some(option => option.value === value)) promptModelChoices.push({ value, label: value });
  }

  // Model display names for the tier table: the composer's cached catalog, fetched once per provider.
  const [names, setNames] = useState<Record<string, Record<string, string>>>({});
  const readyKey = sessionReady.map(meta => meta.id).join(',');
  useEffect(() => {
    let cancelled = false;
    for (const meta of sessionReady) {
      if (!hasModelCatalog(meta.id)) continue;
      void fetchModelOptions(meta.id, false).then(options => {
        if (cancelled || !options) return;
        setNames(current => ({ ...current, [meta.id]: Object.fromEntries(options.options.map(option => [option.value, option.name])) }));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey]);

  return (
    <div className="aip-stack">
      <TabCard title="Where work goes">
        <SettingLine label="New sessions" help="Composer, ticket sessions and delivery runs. Any session can switch provider in the composer.">
          <ChipSelect
            block
            ariaLabel="Default provider for new sessions"
            data-testid="ai-routing-default-select"
            value={settings.ai.activeProvider}
            onChange={value => onMakeDefault(value as AiProvider)}
            options={defaultChoices.map(meta => ({ value: meta.id, label: shortLabel(meta), icon: <ProviderBrandLogo provider={meta.id} size={14} decorative /> }))}
          />
        </SettingLine>
        <SettingLine
          label="Quick recommendations"
          help="Workflow template pick and agent-for-stage pick. Offers the same providers as new sessions. Auto uses the default when it is ready, else the first ready API provider or local agent."
        >
          <ChipSelect
            block
            ariaLabel="Recommendations provider"
            data-testid="ai-recommendation-provider-select"
            value={settings.ai.recommendationProvider ?? ''}
            onChange={value => void update({ ai: { recommendationProvider: value ? (value as AiProvider) : undefined } })}
            options={[
              { value: '', label: 'Auto (first configured provider)' },
              ...recommendationChoices.map(meta => ({
                value: meta.id,
                label: shortLabel(meta),
                icon: <ProviderBrandLogo provider={meta.id} size={14} decorative />,
                meta: settings.ai.providers[meta.id]?.enabled === false ? 'turned off'
                  : defaultChoices.includes(meta) ? undefined : 'not ready'
              }))
            ]}
          />
        </SettingLine>
      </TabCard>

      <TabCard title="Prompt analysis" testId="ai-routing-prompt-analysis">
        <SettingLine label="Provider" help="Checks prompt clarity before you send. Auto keeps the existing recommendation routing; this selection does not change sessions or recommendations.">
          <ChipSelect block ariaLabel="Prompt analysis provider" data-testid="ai-prompt-analysis-provider"
            value={promptProvider ?? ''}
            options={[{ value: '', label: 'Auto (recommendation routing)' }, ...promptChoices.map(meta => ({
              value: meta.id, label: shortLabel(meta), icon: <ProviderBrandLogo provider={meta.id} size={14} decorative />,
              meta: statusOf(meta.id)?.configured && statusOf(meta.id)?.enabled !== false ? undefined : 'unavailable'
            }))]}
            onChange={value => void update({ ai: { promptAnalysisProvider: value ? value as AiProvider : undefined, promptAnalysisModel: undefined } })}
          />
        </SettingLine>
        <SettingLine label="Model" help="Choose a model or enter its ID. Provider default uses that provider's configured model. Prompt checks have a 20-second timeout.">
          <ChipSelect block allowCustom ariaLabel="Prompt analysis model" data-testid="ai-prompt-analysis-model"
            disabled={!promptProvider} value={settings.ai.promptAnalysisModel ?? ''}
            options={[{ value: '', label: 'Provider default' }, ...promptModelChoices]}
            onChange={value => void update({ ai: { promptAnalysisModel: value || undefined } })}
          />
        </SettingLine>
      </TabCard>

      <TabCard title="Workflow tiers by provider" aside={<span className="aip-muted">A stage asks for a tier; the provider running it answers with these models</span>} testId="ai-routing-tiers">
        {sessionReady.length === 0 ? (
          <p className="aip-hint">No provider can run workflow stages yet — set one up on the Providers tab.</p>
        ) : (
          <table className="aip-table aip-tier-table">
            <thead>
              <tr><th>Provider</th>{MODEL_TIER_NAMES.map(tier => <th key={tier}>{tier}</th>)}<th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {sessionReady.map(meta => {
                const tiers = settings.ai.modelTiers?.[meta.id] ?? {};
                return (
                  <tr key={meta.id} data-testid={`ai-routing-tier-row-${meta.id}`}>
                    <td>
                      <span className="aip-tier-provider">
                        <ProviderMark id={meta.id} kind={meta.kind} size={18} />
                        <strong>{shortLabel(meta)}</strong>
                        {settings.ai.activeProvider === meta.id && <span className="chip aip-default-chip"><Icon name="star" size={9} />Default</span>}
                      </span>
                    </td>
                    {MODEL_TIER_NAMES.map(tier => {
                      const id = tiers[tier];
                      return (
                        <td key={tier} title={id}>
                          {id ? <span className="aip-ellipsis">{names[meta.id]?.[id] ?? id}</span> : <span className="aip-muted">run’s model</span>}
                        </td>
                      );
                    })}
                    <td className="aip-tier-action">
                      {hasModelCatalog(meta.id) && (
                        <button type="button" className="btn btn-compact" onClick={() => onOpenModels(meta.id)}>
                          Models <Icon name="arrow-right" size={11} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="aip-hint aip-card-note">
          Retrying a failed stage moves it up one tier. Not listed: providers that are off or not set up
          {chatOnly.length > 0 ? `, and chat-only endpoints (${chatOnly.map(meta => meta.label).join(', ')}), which can’t run stages` : ''}.
        </p>
      </TabCard>
    </div>
  );
}

/** Behaviour: how the agent signs its work, where it works, and issue analysis. */
export function BehaviourTab({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const name = settings.ai.agentName.trim() || 'Praxis Agent';
  const analysisOn = settings.ai.analysisPrompt.trim().length > 0;
  return (
    <div className="aip-stack">
      <TabCard title="Desktop notifications">
        <p className="aip-hint">Alerts for AI sessions and workflow runs. Allow notifications for Praxis in your system settings.</p>
        {([
          ['completed', 'Task completed', 'Notify when an AI turn or workflow finishes.'],
          ['failed', 'Task failed', 'Notify when an AI task or workflow fails.'],
          ['needsAttention', 'Needs attention', 'Notify when approval, input, or recovery is needed.'],
          ['sound', 'Notification sound', 'Use the system notification sound.'],
          ['suppressWhenViewing', 'Quiet while viewing', 'Suppress alerts for the session or run you are actively viewing.']
        ] as const).map(([key, label, description]) => <Toggle key={key} label={label} description={description}
          checked={settings.notifications[key]} onChange={value => update({ notifications: { [key]: value } })} />)}
      </TabCard>
      <TabCard title="Identity">
        <SettingLine label="Display name" help="On the agent’s comments and commits.">
          <DebouncedTextField ariaLabel="AI agent display name" value={settings.ai.agentName} onCommit={value => update({ ai: { agentName: value } })} placeholder="e.g. Ticket Agent" />
          <span className="aip-preview" aria-hidden>
            <span className="aip-avatar">{name.charAt(0).toUpperCase()}</span>
            <strong>{name}</strong>
            <span className="aip-muted">commented · just now</span>
          </span>
        </SettingLine>
      </TabCard>
      <TabCard title="Workspace">
        <SettingLine label="Working directory" help="Default for sessions and delivery runs; workflow packs are found under its .github/skills folder. Empty uses the app’s own folder.">
          <div className="ai-key-controls">
            <DebouncedTextField ariaLabel="AI working directory" value={settings.ai.workingDirectory} onCommit={value => update({ ai: { workingDirectory: value } })} placeholder="e.g. ~/dev/my-repo" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.praxis.dialog.pickFolder('Choose the default working directory').then(folder => {
                  if (folder) void update({ ai: { workingDirectory: folder } });
                });
              }}
            >
              Browse…
            </button>
          </div>
        </SettingLine>
      </TabCard>
      <TabCard title="Issue analysis">
        <SettingLine label="Analysis prompt" help="System prompt for the issue analysis chat.">
          <DebouncedTextArea
            ariaLabel="AI analysis system prompt"
            value={settings.ai.analysisPrompt}
            onCommit={value => update({ ai: { analysisPrompt: value } })}
            placeholder="e.g. You are a senior engineer assessing implementation readiness…"
          />
          <div className="aip-inline-status">
            <span className={`aip-dot ${analysisOn ? 'is-ok' : 'is-off'}`} aria-hidden />
            <span className="aip-muted" data-testid="ai-analysis-state">{analysisOn ? 'Analysis is on' : 'Analysis is off — add a prompt to turn it on'}</span>
            <span className="aip-spacer" />
            {analysisOn && (
              <button type="button" className="btn btn-compact" onClick={() => void update({ ai: { analysisPrompt: '' } })}>
                Clear — turns analysis off
              </button>
            )}
          </div>
        </SettingLine>
        <SettingLine label="Require confirmed analysis" help="Before an issue can be delegated or delivered.">
          <div className="aip-inline-status">
            <button
              type="button"
              role="switch"
              aria-checked={settings.ai.analysisGateEnabled}
              aria-label="Require confirmed analysis"
              className="switch"
              data-testid="ai-analysis-gate-toggle"
              onClick={() => void update({ ai: { analysisGateEnabled: !settings.ai.analysisGateEnabled } })}
            />
            <span className="aip-muted">{settings.ai.analysisGateEnabled ? 'On — issues need a confirmed analysis first' : 'Off — issues can be delegated straight away'}</span>
          </div>
        </SettingLine>
      </TabCard>
    </div>
  );
}

/** Exact hostnames or `*.example.com` wildcards — the same forms the browser tool matches against. */
const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$|^[a-z0-9-]+$/;

/** Tools: the in-app browser the AI can drive, and the MCP servers it is given. */
export function ToolsTab({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const [hostDraft, setHostDraft] = useState('');
  const [hostError, setHostError] = useState<string>();
  const hosts = settings.ai.browserTools.allowedHosts;
  const addHost = () => {
    const host = hostDraft.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!HOST_PATTERN.test(host)) {
      setHostError('Use a hostname such as docs.github.com, or *.example.com for every subdomain.');
      return;
    }
    setHostError(undefined);
    setHostDraft('');
    if (!hosts.includes(host)) void update({ ai: { browserTools: { allowedHosts: [...hosts, host] } } });
  };
  return (
    <div className="aip-stack">
      <TabCard title="In-app browser">
        <div className="aip-toggle-line">
          <div>
            <strong>Let the AI use the in-app browser</strong>
            <p className="aip-hint">Full-tools sessions can open, read, click and type in a browser docked beside the session. A new host asks first; localhost and private networks are always blocked.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.ai.browserTools.enabled}
            aria-label="Let the AI use the in-app browser"
            className="switch"
            data-testid="ai-browser-tools-toggle"
            onClick={() => void update({ ai: { browserTools: { enabled: !settings.ai.browserTools.enabled } } })}
          />
        </div>
        <div className="aip-hosts" data-testid="ai-browser-allowed-hosts">
          <span className="aip-muted">Allowed without asking</span>
          {hosts.length === 0 && <span className="aip-muted">— none yet. “Always allow” on a prompt adds one.</span>}
          {hosts.map(host => (
            <span key={host} className="aip-host">
              <span>{host}</span>
              <button
                type="button"
                className="aip-host-remove"
                aria-label={`Stop allowing ${host}`}
                onClick={() => void update({ ai: { browserTools: { allowedHosts: hosts.filter(entry => entry !== host) } } })}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <span className="aip-host-add">
            <input
              className="input aip-mono"
              aria-label="Allow a host"
              placeholder="Add a host…"
              value={hostDraft}
              onChange={event => { setHostDraft(event.target.value); setHostError(undefined); }}
              onKeyDown={event => { if (event.key === 'Enter' && hostDraft.trim()) addHost(); }}
            />
            <button type="button" className="btn btn-compact" disabled={!hostDraft.trim()} onClick={addHost}>
              <Icon name="plus" size={11} />
              Add host
            </button>
          </span>
        </div>
        {hostError && <p className="aip-hint aip-error-text" role="alert">{hostError}</p>}
      </TabCard>
      <McpServersPanel servers={settings.ai.mcpServers ?? []} onChange={next => update({ ai: { mcpServers: next } })} />
    </div>
  );
}
