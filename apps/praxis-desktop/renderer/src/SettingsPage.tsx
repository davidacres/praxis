import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import type {
  AiProvider,
  AiProviderStatus,
  AgentRuntimeSnapshot,
  AppSettings,
  AppSettingsPatch,
  SurfaceMotifSettings,
  BoardsSidebarMode,
  Connection
} from '@praxis/core';
import {
  DEFAULT_APP_SETTINGS,
  normalizePriorityColor,
  PRIORITY_NAMES
} from './settingsDefaults';
import { Icon, type IconName } from './Icon';
import { ModelManagerPanel } from './ModelManagerPanel';
import { MODEL_PROVIDERS } from './modelProviders';
import { useSettings } from './useSettings';
import { allThemes, applySurfacePack, applyThemePreference, getInitialThemeId, registerCustomThemes, resolvePatternInk, THEMES, type ThemeDefinition, type ThemeModePreference } from './themes';
import { allSurfacePacks, registerCustomSurfacePacks, SURFACE_PACKS, SURFACE_TOKEN_KEYS, type SurfaceMode, type SurfacePackDefinition } from './surfacePacks';
import {
  DEFAULT_MOTIF_FADE, DEFAULT_MOTIF_SPREAD, findSurfacePattern, perceptualOpacityScale,
  resolveSurfacePattern, SURFACE_PATTERNS,
  type SurfacePatternAnchor, type SurfacePatternInk, type SurfacePatternPlacement, type SurfacePatternSpec
} from './surfacePatterns';

export type SettingsCategory =
  | 'overview'
  | 'connections'
  | 'jira'
  | 'ai'
  | 'agent-runtime'
  | 'performance'
  | 'delivery'
  | 'mcp'
  | 'preview'
  | 'themes'
  | 'appearance'
  | 'terminal';

interface CategoryDef {
  id: SettingsCategory;
  label: string;
  icon: IconName;
  description: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'home',
    description: 'Quick summary of where settings live and what is currently configured.'
  },
  {
    id: 'themes',
    label: 'Themes',
    icon: 'theme',
    description: 'Choose a complete color palette for the Praxis interface.'
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'terminal',
    description: 'Profiles, appearance, and behaviour for interactive terminal sessions.'
  },
  {
    id: 'connections',
    label: 'Connections',
    icon: 'plug',
    description: 'Connection profiles the app reads tickets and issues from.'
  },
  {
    id: 'jira',
    label: 'Jira',
    icon: 'ticket',
    description: 'Jira MCP site URL, default project, and the optional epic/JQL boards.'
  },
  {
    id: 'ai',
    label: 'AI Provider',
    icon: 'robot',
    description: 'AI provider connections used to delegate issues to an AI agent.'
  },
  {
    id: 'agent-runtime',
    label: 'Agent Runtime',
    icon: 'robot',
    description: 'Discovered agent hosts, capabilities, and progressively indexed skills.'
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'zap',
    description: 'Timeouts and paging defaults applied to backend requests.'
  },
  {
    id: 'delivery',
    label: 'Delivery',
    icon: 'rocket',
    description: 'Default base branch and how sub-task branches are merged.'
  },
  {
    id: 'mcp',
    label: 'MCP Server',
    icon: 'server',
    description: 'Workspace- and user-level MCP server references for Jira via MCP mode.'
  },
  {
    id: 'preview',
    label: 'Preview',
    icon: 'lightbulb',
    description: 'In-progress capabilities gated behind these toggles.'
  },
  {
    id: 'appearance',
    label: 'Board Settings',
    icon: 'columns',
    description: 'Board presentation, brand artwork, and colors used by ticket cards.'
  }
];

interface SettingsPageProps {
  connections: Connection[];
  onOpenConnections: () => void;
  initialCategory?: SettingsCategory;
}

export function SettingsPage({ connections, onOpenConnections, initialCategory = 'overview' }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsCategory>(initialCategory);
  const { settings, update, error } = useSettings();

  if (!settings) {
    return (
      <div className="settings-page loading">
        <div className="placeholder-text">Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Settings categories">
        {CATEGORIES.map(category => (
          <button
            key={category.id}
            className={`settings-nav-item${active === category.id ? ' active' : ''}`}
            onClick={() => setActive(category.id)}
            data-testid={`settings-nav-${category.id}`}
            type="button"
          >
            <span className="tree-icon">
              <Icon name={category.icon} size={15} />
            </span>
            <span className="settings-nav-label">{category.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {error && <div className="error-banner">{error}</div>}
        {active === 'overview' && (
          <OverviewSection settings={settings} onReset={() => void update({ ...DEFAULT_APP_SETTINGS })} />
        )}
        {active === 'connections' && (
          <ConnectionsSection connections={connections} onOpenConnections={onOpenConnections} />
        )}
        {active === 'jira' && <JiraSection settings={settings} update={update} />}
        {active === 'ai' && <AiSection settings={settings} update={update} />}
        {active === 'agent-runtime' && <AgentRuntimeSection />}
        {active === 'performance' && <PerformanceSection settings={settings} update={update} />}
        {active === 'delivery' && <DeliverySection settings={settings} update={update} />}
        {active === 'mcp' && <McpSection settings={settings} update={update} />}
        {active === 'preview' && <PreviewSection settings={settings} update={update} />}
        {active === 'themes' && <ThemesSection settings={settings} update={update} />}
        {active === 'appearance' && <AppearanceSection settings={settings} update={update} />}
        {active === 'terminal' && <TerminalSection settings={settings} update={update} />}
      </div>
    </div>
  );
}

function AgentRuntimeSection() {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot>();
  const [error, setError] = useState<string>();
  const [activated, setActivated] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      setSnapshot(await window.ticketManager.agentRuntime.refresh());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void window.ticketManager.agentRuntime.list().then(setSnapshot).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  return (
    <section data-testid="settings-agent-runtime">
      <CategoryHeader category={CATEGORIES.find(category => category.id === 'agent-runtime')!} />
      <div className="settings-list">
        <div className="settings-field-row">
          <div className="settings-field-label">
            <strong>Registry</strong>
            <div className="settings-field-help">Discovery is read-only until you explicitly start a trusted host.</div>
          </div>
          <div className="settings-field-control">
            <button className="btn" type="button" onClick={() => void refresh()} disabled={busy} data-testid="agent-runtime-refresh">
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {!snapshot && !error && <div className="placeholder-text">Loading agent runtime…</div>}
        {snapshot && (
          <>
            <div className="settings-section-description">Last refreshed: {snapshot.refreshedAt || 'not yet'} · {snapshot.agents.length} agents · {snapshot.skills.length} skills</div>
            {snapshot.agents.map(agent => (
              <div className="settings-field-row" key={agent.manifest.id} data-testid={`agent-runtime-agent-${agent.manifest.id}`}>
                <div className="settings-field-label">
                  <strong>{agent.manifest.name}</strong>
                  <div className="settings-field-help">{agent.manifest.type} · {agent.trusted ? 'trusted' : 'approval required'}{agent.errors.length ? ` · ${agent.errors.map(item => item.message).join('; ')}` : ''}</div>
                </div>
                <div className="settings-field-control">
                  <button className="btn" type="button" disabled={!agent.trusted || agent.errors.length > 0 || busy} onClick={() => void window.ticketManager.agentRuntime.start(agent.manifest.id).then(setSnapshot).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>
                    Start
                  </button>
                </div>
              </div>
            ))}
            {snapshot.skills.map(skill => (
              <div className="settings-field-row" key={skill.metadata.name} data-testid={`agent-runtime-skill-${skill.metadata.name}`}>
                <div className="settings-field-label"><strong>{skill.metadata.name}</strong><div className="settings-field-help">{skill.metadata.description}</div></div>
                <div className="settings-field-control">
                  {skill.error ? <span className="settings-field-help">Invalid: {skill.error}</span> : (
                    <>
                      <span className="settings-field-help">{activated === skill.metadata.name ? 'Activated' : skill.trusted ? 'Indexed' : 'Approval required'}</span>
                      {snapshot.agents.find(agent => agent.trusted && agent.errors.length === 0) && <button className="btn" type="button" disabled={!skill.trusted || busy} onClick={() => {
                        const agent = snapshot.agents.find(candidate => candidate.trusted && candidate.errors.length === 0);
                        if (!agent) return;
                        void window.ticketManager.agentRuntime.activateSkill(agent.manifest.id, skill.metadata.name).then(() => setActivated(skill.metadata.name)).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}>Activate</button>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function CategoryHeader({ category, children }: { category: CategoryDef; children?: React.ReactNode }) {
  return (
    <div>
      <h3 className="settings-section-title">{category.label}</h3>
      <p className="settings-section-description">
        {category.description}
        {children}
      </p>
    </div>
  );
}

function FieldRow({
  label,
  description,
  children
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field-row">
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  testId
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className={`settings-toggle-row${disabled ? ' disabled' : ''}`}>
      <div className="settings-toggle-text">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        disabled={disabled}
        data-testid={testId}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function OverviewSection({
  settings,
  onReset
}: {
  settings: AppSettings;
  onReset: () => void;
}) {
  const category = CATEGORIES.find(c => c.id === 'overview')!;
  return (
    <>
      <CategoryHeader category={category} />
      <div className="settings-list">
        <div className="list-row">
          <div>
            <div className="list-row-title">Settings file</div>
            <div className="list-row-meta">
              A single JSON document shared with the VS Code extension so changes in either place sync.
            </div>
          </div>
        </div>
        <div className="list-row">
          <div>
            <div className="list-row-title">Jira site</div>
            <div className="list-row-meta">
              {settings.jira.siteUrl.trim() ? settings.jira.siteUrl : 'not configured'}
            </div>
          </div>
        </div>
        <div className="list-row">
          <div>
            <div className="list-row-title">Default page size</div>
            <div className="list-row-meta">{settings.performance.defaultPageSize} issues per page</div>
          </div>
        </div>
        <div className="list-row">
          <div>
            <div className="list-row-title">Boards sidebar mode</div>
            <div className="list-row-meta">{settings.preview.boardsSidebarMode}</div>
          </div>
        </div>
      </div>
      <div className="section-divider">
        <strong>Reset to defaults</strong>
        <div className="settings-field-help">
          Replaces every category below with the shipped defaults. Connections are unaffected.
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={onReset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

function ConnectionsSection({
  connections,
  onOpenConnections
}: {
  connections: Connection[];
  onOpenConnections: () => void;
}) {
  const category = CATEGORIES.find(c => c.id === 'connections')!;
  return (
    <>
      <CategoryHeader category={category} />
      <div className="settings-list">
        {connections.length === 0 && (
          <div className="list-row">
            <div>
              <div className="list-row-title">No connections yet</div>
              <div className="list-row-meta">Use Manage connections to add one.</div>
            </div>
          </div>
        )}
        {connections.map(connection => (
          <div key={connection.id} className="list-row">
            <div>
              <div className="list-row-title">{connection.name}</div>
              <div className="list-row-meta">{connection.mode}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="section-divider">
        <button className="btn btn-primary" onClick={onOpenConnections}>
          Manage connections
        </button>
      </div>
    </>
  );
}

function JiraSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'jira')!;
  return (
    <>
      <CategoryHeader category={category} />
      <FieldRow
        label="Site URL"
        description="Base URL of the Jira instance that MCP tools connect to."
      >
        <DebouncedTextField
          ariaLabel="Jira site URL"
          value={settings.jira.siteUrl}
          onCommit={value => update({ jira: { siteUrl: value } })}
          placeholder="https://example.atlassian.net"
        />
      </FieldRow>
      <FieldRow label="Default project key" description="Used when creating a new issue and the form does not specify one.">
        <DebouncedTextField
          ariaLabel="Jira default project key"
          value={settings.jira.defaultProjectKey}
          onCommit={value => update({ jira: { defaultProjectKey: value } })}
          placeholder="e.g. ENG"
        />
      </FieldRow>
      <FieldRow label="Epic key" description="Boards follow this epic and Jira issue creation uses it as the default parent.">
        <DebouncedTextField
          ariaLabel="Jira epic key"
          value={settings.jira.epicKey}
          onCommit={value => update({ jira: { epicKey: value } })}
          placeholder="e.g. EPIC-123"
        />
      </FieldRow>
      <FieldRow label="Epic board name">
        <DebouncedTextField
          ariaLabel="Jira epic board display name"
          value={settings.jira.epicBoardName}
          onCommit={value => update({ jira: { epicBoardName: value } })}
          placeholder="Optional display name"
        />
      </FieldRow>
      <FieldRow label="Board JQL">
        <DebouncedTextField
          ariaLabel="Jira board JQL query"
          value={settings.jira.boardJql}
          onCommit={value => update({ jira: { boardJql: value } })}
          placeholder="Optional Jira JQL query"
        />
      </FieldRow>
      <FieldRow label="Board name">
        <DebouncedTextField
          ariaLabel="Jira board display name"
          value={settings.jira.boardName}
          onCommit={value => update({ jira: { boardName: value } })}
          placeholder="Optional display name"
        />
      </FieldRow>
    </>
  );
}

/**
 * AI Provider section: Vercel AI Gateway setup. The API key is write-only —
 * it goes straight to the OS-keychain secrets store via `ai:setApiKey` and is
 * never read back over IPC; the status snapshot only reports the key source.
 */
interface AiProviderMeta {
  id: AiProvider;
  kind: 'api' | 'cli-agent';
  label: string;
  keyLabel: string;
  urlPlaceholder: string;
  modelPlaceholder: string;
  /** `kind: 'cli-agent'` only — default PATH-resolved executable name. Absent for the Copilot SDK's own bundled runtime. */
  defaultCommand?: string;
  /** `kind: 'cli-agent'` only — overrides the generic "CLI path" field's description. */
  cliPathDescription?: string;
  /** `kind: 'cli-agent'` only — shown when the real, free PATH-resolution check finds nothing to spawn. */
  notInstalledHint?: string;
}

/** Display metadata for the settings UI — mirrors core's `PROVIDER_DESCRIPTORS`
 *  (kept as a local literal, not imported: core drags in Node built-ins that
 *  can't bundle into the renderer, same reason `settingsDefaults.ts` exists). */
const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'vercel-gateway',
    kind: 'api',
    label: 'Vercel AI Gateway',
    keyLabel: 'Vercel AI Gateway API key',
    urlPlaceholder: 'https://ai-gateway.vercel.sh',
    modelPlaceholder: 'e.g. anthropic/claude-sonnet-4.6'
  },
  {
    id: 'openai',
    kind: 'api',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    urlPlaceholder: 'https://api.openai.com',
    modelPlaceholder: 'e.g. gpt-4o-mini'
  },
  {
    id: 'anthropic',
    kind: 'api',
    label: 'Anthropic',
    keyLabel: 'Anthropic API key',
    urlPlaceholder: 'https://api.anthropic.com',
    modelPlaceholder: 'e.g. claude-sonnet-4-6'
  },
  {
    id: 'claude-code-cli',
    kind: 'cli-agent',
    label: 'Claude Code (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'claude-agent-acp',
    notInstalledHint: 'Not found on PATH — run "npm install -g @agentclientprotocol/claude-agent-acp".'
  },
  {
    id: 'codex-cli',
    kind: 'cli-agent',
    label: 'Codex CLI (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'codex-acp',
    notInstalledHint: 'Not found on PATH — run "npm install -g @agentclientprotocol/codex-acp".'
  },
  {
    id: 'copilot-cli',
    kind: 'cli-agent',
    label: 'GitHub Copilot (local)',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    cliPathDescription:
      'Runs the bundled @github/copilot runtime automatically — auth comes from GITHUB_TOKEN/gh CLI login, not a stored key. Override with an absolute path only if you need a different runtime executable.',
    notInstalledHint: 'The custom runtime path above was not found.'
  }
];

function AiSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'ai')!;
  const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<AiProvider>(settings.ai.activeProvider);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [resettingKeys, setResettingKeys] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [managingModels, setManagingModels] = useState(false);

  const reloadStatuses = () => {
    window.ticketManager.ai
      .listProviderStatuses()
      .then(setStatuses)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reloadStatuses, []);
  useEffect(() => {
    setKeyDraft('');
    setManagingModels(false);
  }, [selectedProviderId]);

  const selectedMeta = AI_PROVIDERS.find(p => p.id === selectedProviderId)!;
  const selectedStatus = statuses.find(s => s.provider === selectedProviderId);
  const selectedConfig = settings.ai.providers[selectedProviderId] ?? {};
  const isVercel = selectedProviderId === 'vercel-gateway';
  const isApi = selectedMeta.kind === 'api';

  const applyKey = async (value: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await window.ticketManager.ai.setProviderApiKey(selectedProviderId, value);
      reloadStatuses();
      setKeyDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resetProviderKeys = async () => {
    if (!window.confirm('Reset all saved AI provider keys? You will need to enter them again.')) return;
    setResettingKeys(true);
    setError(undefined);
    try {
      await window.ticketManager.ai.resetProviderApiKeys();
      setStatuses([]);
      reloadStatuses();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResettingKeys(false);
    }
  };

  const statusText = (status: AiProviderStatus | undefined, meta: AiProviderMeta): string => {
    if (!status) {
      return 'Checking…';
    }
    if (meta.kind === 'cli-agent') {
      // No API key concept — `configured` here is a real, free check that
      // the command actually resolves to a spawnable executable (no ACP
      // handshake, no LLM call).
      return status.configured
        ? `Runs "${status.gatewayUrl}" — sign in with the CLI's own auth if it asks.`
        : (meta.notInstalledHint ?? `Not found: "${status.gatewayUrl}".`);
    }
    return status.configured
      ? status.keySource === 'secret'
        ? 'Configured — API key stored in the OS keychain.'
        : 'Configured — API key resolved from the environment.'
      : 'Not configured — add an API key to enable AI sessions.';
  };

  const urlValue = isVercel ? settings.ai.gatewayUrl : selectedConfig.baseUrl ?? '';
  const modelValue = isVercel ? settings.ai.defaultModel : selectedConfig.defaultModel ?? '';

  const commitUrl = (value: string) =>
    isVercel
      ? update({ ai: { gatewayUrl: value } })
      : update({
          ai: {
            providers: { [selectedProviderId]: { ...selectedConfig, baseUrl: value || undefined } }
          }
        });

  const commitModel = (value: string) =>
    isVercel
      ? update({ ai: { defaultModel: value } })
      : update({
          ai: {
            providers: {
              [selectedProviderId]: { ...selectedConfig, defaultModel: value || undefined }
            }
          }
        });

  if (managingModels) {
    return (
      <ModelManagerPanel
        providerId={selectedProviderId}
        providerLabel={selectedMeta.label}
        enabledModelIds={selectedConfig.enabledModelIds}
        providerConfig={selectedConfig}
        onBack={() => setManagingModels(false)}
        update={update}
      />
    );
  }

  return (
    <>
      <CategoryHeader category={category} />
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          {error.includes('safeStorage.decryptString') && (
            <button
              type="button"
              className="btn"
              data-testid="ai-reset-provider-keys"
              disabled={resettingKeys}
              onClick={() => void resetProviderKeys()}
            >
              {resettingKeys ? 'Resetting…' : 'Reset encrypted provider keys'}
            </button>
          )}
        </div>
      )}

      <div className="settings-list" data-testid="ai-provider-list">
        {AI_PROVIDERS.map(meta => {
          const rowStatus = statuses.find(s => s.provider === meta.id);
          const isActive = settings.ai.activeProvider === meta.id;
          const isSelected = selectedProviderId === meta.id;
          return (
            <div
              key={meta.id}
              className={`list-row${isSelected ? ' active' : ''}`}
              role="button"
              tabIndex={0}
              data-testid={`ai-provider-row-${meta.id}`}
              onClick={() => setSelectedProviderId(meta.id)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  setSelectedProviderId(meta.id);
                }
              }}
            >
              <div>
                <div className="list-row-title">
                  {meta.label}
                  {isActive ? ' · Active' : ''}
                </div>
                <div
                  className="list-row-meta"
                  data-testid={isSelected ? 'ai-provider-status' : undefined}
                >
                  {statusText(rowStatus, meta)}
                </div>
              </div>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-icon"
                data-testid={`ai-provider-set-active-${meta.id}`}
                aria-label={`Use ${meta.label} for new sessions`}
                disabled={isActive}
                onClick={event => {
                  event.stopPropagation();
                  void update({ ai: { activeProvider: meta.id } });
                }}
              >
                <Icon name={isActive ? 'check' : 'dot'} size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {isApi && (
        <>
          <FieldRow
            label="API key"
            description={`${selectedMeta.keyLabel}. Stored encrypted in the OS keychain; it is never shown again after saving.`}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                className="input"
                data-testid="ai-api-key-input"
                aria-label={selectedMeta.keyLabel}
                placeholder={selectedStatus?.configured ? '••••••••  (saved)' : 'Paste API key'}
                value={keyDraft}
                onChange={event => setKeyDraft(event.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-primary"
                data-testid="ai-api-key-save"
                disabled={busy || !keyDraft.trim()}
                onClick={() => void applyKey(keyDraft)}
              >
                Save key
              </button>
              <button
                type="button"
                className="btn"
                data-testid="ai-api-key-clear"
                disabled={busy || !selectedStatus || selectedStatus.keySource !== 'secret'}
                onClick={() => void applyKey('')}
              >
                Clear
              </button>
            </div>
          </FieldRow>
          <FieldRow
            label={isVercel ? 'Gateway URL' : `${selectedMeta.label} base URL`}
            description="Leave empty to use the default endpoint."
          >
            <DebouncedTextField
              ariaLabel={isVercel ? 'AI gateway URL' : `${selectedMeta.label} base URL`}
              value={urlValue}
              onCommit={commitUrl}
              placeholder={selectedStatus?.gatewayUrl ?? selectedMeta.urlPlaceholder}
            />
          </FieldRow>
          <FieldRow
            label={isVercel ? 'Default model' : `${selectedMeta.label} default model`}
            description="Model id used for new agent sessions on this provider. Empty means the service default."
          >
            <DebouncedTextField
              ariaLabel={isVercel ? 'AI default model' : `${selectedMeta.label} default model`}
              value={modelValue}
              onCommit={commitModel}
              placeholder={selectedMeta.modelPlaceholder}
            />
          </FieldRow>
        </>
      )}
      {!isApi && (
        <FieldRow
          label="CLI path"
          description={
            selectedMeta.cliPathDescription ??
            `Executable to spawn — defaults to "${selectedMeta.defaultCommand}" on PATH. Override with an absolute path if it isn't on PATH.`
          }
        >
          <DebouncedTextField
            ariaLabel={`${selectedMeta.label} CLI path`}
            value={selectedConfig.cliPath ?? ''}
            onCommit={value =>
              update({
                ai: { providers: { [selectedProviderId]: { ...selectedConfig, cliPath: value || undefined } } }
              })
            }
            placeholder={selectedMeta.defaultCommand}
          />
        </FieldRow>
      )}
      {MODEL_PROVIDERS.has(selectedProviderId) && (
        <FieldRow
          label="Models"
          description={
            selectedConfig.enabledModelIds
              ? `${selectedConfig.enabledModelIds.length} of the fetched catalog selected for the composer's Model picker.`
              : "Every fetched model is offered in the composer's Model picker (no curation set)."
          }
        >
          <button
            type="button"
            className="btn"
            data-testid="ai-manage-models-btn"
            onClick={() => setManagingModels(true)}
          >
            Manage models…
          </button>
        </FieldRow>
      )}
      <FieldRow
        label="Agent display name"
        description="Used for agent attribution in comments and commits."
      >
        <DebouncedTextField
          ariaLabel="AI agent display name"
          value={settings.ai.agentName}
          onCommit={value => update({ ai: { agentName: value } })}
          placeholder="e.g. Ticket Agent"
        />
      </FieldRow>
      <FieldRow
        label="Working directory"
        description="Default working directory for agent sessions and delivery runs; workflow packs are discovered under its .github/skills folder. Empty means the app's own directory."
      >
        <DebouncedTextField
          ariaLabel="AI working directory"
          value={settings.ai.workingDirectory}
          onCommit={value => update({ ai: { workingDirectory: value } })}
          placeholder="e.g. C:\\dev\\my-repo"
        />
      </FieldRow>
      <FieldRow
        label="Analysis system prompt"
        description="System prompt used by the issue analysis chat. Empty disables the analysis action."
      >
        <DebouncedTextArea
          ariaLabel="AI analysis system prompt"
          value={settings.ai.analysisPrompt}
          onCommit={value => update({ ai: { analysisPrompt: value } })}
          placeholder="e.g. You are a senior engineer assessing implementation readiness…"
        />
      </FieldRow>
      <Toggle
        label="Require confirmed analysis"
        description="When on, an issue must have a confirmed analysis before it can be delegated or delivered."
        checked={settings.ai.analysisGateEnabled}
        testId="ai-analysis-gate-toggle"
        onChange={next => void update({ ai: { analysisGateEnabled: next } })}
      />
    </>
  );
}

function PerformanceSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'performance')!;
  return (
    <>
      <CategoryHeader category={category} />
      <FieldRow label="Request timeout (ms)" description="Min 1000. Applies to MCP requests.">
        <DebouncedNumberField
          ariaLabel="Request timeout in milliseconds"
          value={settings.performance.requestTimeoutMs}
          min={1000}
          onCommit={value => update({ performance: { requestTimeoutMs: value } })}
        />
      </FieldRow>
      <FieldRow label="Default page size" description="Between 5 and 100 issues per page.">
        <DebouncedNumberField
          ariaLabel="Default page size"
          value={settings.performance.defaultPageSize}
          min={5}
          max={100}
          onCommit={value => update({ performance: { defaultPageSize: value } })}
        />
      </FieldRow>
    </>
  );
}

function DeliverySection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'delivery')!;
  return (
    <>
      <CategoryHeader category={category} />

      <Toggle
        label="Enable delivery workflow"
        description="Master switch for the AI delivery run action. Requires the publish command and artifact pattern below."
        checked={settings.delivery.enabled}
        testId="delivery-enabled-toggle"
        onChange={next => void update({ delivery: { enabled: next } })}
      />
      <FieldRow
        label="Publish command"
        description="Repo-specific publish command the delivery agent must run (e.g. the MSI publish script). Wrapped to run against the working directory."
      >
        <DebouncedTextField
          ariaLabel="Delivery publish command"
          value={settings.delivery.publishCommand}
          onCommit={value => update({ delivery: { publishCommand: value } })}
          placeholder="e.g. .\\scripts\\publish-msi.ps1"
        />
      </FieldRow>
      <FieldRow
        label="Artifact pattern"
        description="Artifact path or glob the delivery agent must identify after publishing."
      >
        <DebouncedTextField
          ariaLabel="Delivery artifact pattern"
          value={settings.delivery.artifactPattern}
          onCommit={value => update({ delivery: { artifactPattern: value } })}
          placeholder="e.g. dist\\*.msi"
        />
      </FieldRow>
      <FieldRow
        label="Default base branch"
        description="Used when a ticket does not specify one. Empty means the agent will ask."
      >
        <DebouncedTextField
          ariaLabel="Default base branch"
          value={settings.delivery.defaultBaseBranch}
          onCommit={value => update({ delivery: { defaultBaseBranch: value } })}
          placeholder="e.g. main"
        />
      </FieldRow>
      <Toggle
        label="Auto-merge sub tasks"
        description="When on (default), completed sub-task branches merge into the feature branch automatically."
        checked={settings.delivery.autoMergeSubTasks}
        onChange={next => void update({ delivery: { autoMergeSubTasks: next } })}
      />
    </>
  );
}

function McpSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'mcp')!;
  return (
    <>
      <CategoryHeader category={category} />
      <FieldRow label="Workspace MCP server name" description="Used from .vscode/mcp.json when Jira via MCP mode isn't manually configured.">
        <DebouncedTextField
          ariaLabel="Workspace MCP server name"
          value={settings.mcpServer.workspaceServerName}
          onCommit={value => update({ mcpServer: { workspaceServerName: value } })}
          placeholder="Optional"
        />
      </FieldRow>
      <FieldRow label="User MCP server reference" description="Used when no workspace MCP server is selected.">
        <DebouncedTextField
          ariaLabel="User MCP server reference"
          value={settings.mcpServer.userServerRef}
          onCommit={value => update({ mcpServer: { userServerRef: value } })}
          placeholder="Optional"
        />
      </FieldRow>
    </>
  );
}

function PreviewSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'preview')!;
  return (
    <>
      <CategoryHeader category={category} />
      <Toggle
        label="Enable Create Idea"
        description="Show the Create Idea command and button."
        checked={settings.preview.enableCreateIdea}
        onChange={next => void update({ preview: { enableCreateIdea: next } })}
      />
      <Toggle
        label="Enable New Project"
        description="Show the New Project wizard."
        checked={settings.preview.enableNewProject}
        onChange={next => void update({ preview: { enableNewProject: next } })}
      />
      <SidebarModeToggle
        mode={settings.preview.boardsSidebarMode}
        onChange={next => void update({ preview: { boardsSidebarMode: next } })}
      />
    </>
  );
}

function SidebarModeToggle({
  mode,
  onChange
}: {
  mode: BoardsSidebarMode;
  onChange: (next: BoardsSidebarMode) => void;
}) {
  const isWork = mode === 'work';
  return (
    <Toggle
      label="Boards sidebar — Work Mode"
      description="Off is Classic (separate views); on is Work Mode (board-centric cards with nested sessions)."
      checked={isWork}
      onChange={next => onChange(next ? 'work' : 'classic')}
    />
  );
}

function ThemePreviewCard({
  theme,
  active,
  onSelect,
  installed = true,
  onInstall,
  onEdit
}: {
  theme: ThemeDefinition;
  active: boolean;
  onSelect: () => void;
  installed?: boolean;
  onInstall?: () => void;
  onEdit?: () => void;
}) {
  const colors = theme.preview;
  const previewStyle = {
    '--preview-canvas': colors.canvas,
    '--preview-panel': colors.panel,
    '--preview-raised': colors.raised,
    '--preview-border': colors.border,
    '--preview-text': colors.text,
    '--preview-muted': colors.muted,
    '--preview-accent': colors.accent,
    '--preview-success': colors.success,
    '--preview-warning': colors.warning,
    '--preview-danger': colors.danger
  } as CSSProperties;

  return (
    <button
      type="button"
      className={`theme-gallery-card${active ? ' active' : ''}${!installed ? ' marketplace' : ''}`}
      style={previewStyle}
      aria-pressed={active}
      aria-label={`${theme.name}, ${theme.mode} theme${active ? ', active' : installed ? '' : ', available in marketplace'}`}
      data-testid={`theme-card-${theme.id}`}
      onClick={installed ? onSelect : onInstall}
      onDoubleClick={onEdit}
      title={onEdit ? 'Double-click to edit custom theme' : undefined}
    >
      <span className="theme-card-preview" aria-hidden="true">
        {installed && <span className="theme-card-installed">Installed</span>}
        <span className="theme-preview-titlebar"><i /><i /><i /><b /></span>
        <span className="theme-preview-layout">
          <span className="theme-preview-sidebar"><i className="wide" /><i /><i /><i className="short" /></span>
          <span className="theme-preview-content">
            <span className="theme-preview-heading"><i /><b /><b /></span>
            <i className="line wide" /><i className="line" />
            <span className="theme-preview-status"><i /><i /><i /></span>
            <i className="line wide" /><i className="line short" />
          </span>
        </span>
        <span className="theme-preview-spectrum"><i /><i /><i /><i /></span>
      </span>
      <span className="theme-card-meta">
        <span><strong>{theme.name}</strong><small>{theme.mode}</small></span>
        {active && <span className="theme-card-active">Active</span>}
        {!installed && <span className="theme-card-install">Install</span>}
      </span>
      <span className="theme-card-description">{theme.description}</span>
    </button>
  );
}

/**
 * A surface-pack card. The swatch renders the pack's material *over the live
 * theme tokens*, so the preview is the real pack × theme combination rather
 * than a generic mock.
 */
function SurfacePackCard({
  pack,
  active,
  onSelect
}: {
  pack: SurfacePackDefinition;
  active: boolean;
  onSelect: () => void;
}) {
  // The swatch is rendered from the pack's *own* pattern data rather than a
  // hand-written preview string, so the gallery can never drift from what the
  // pack actually does. The tile is shrunk and its opacity lifted, because a
  // strength tuned for a full window is invisible in a 58px thumbnail — but the
  // lift runs through the same perceptual scale the app uses, otherwise a
  // high-contrast ink (Graphite's, against its panel) previews far harsher in
  // the gallery than it ever looks in the app.
  const previewInk = pack.pattern ? resolvePatternInk(pack.pattern.ink, pack.pattern.inkColor) : '';
  const preview = pack.pattern
    ? resolveSurfacePattern(
        {
          ...pack.pattern,
          // Always tile the swatch: a corner motif's fade is meaningless at
          // thumbnail size, and the card is showing what the material *is*.
          placement: 'tile',
          scale: Math.max(16, pack.pattern.scale * 0.42),
          opacity: Math.min(
            0.7,
            pack.pattern.opacity
              * 4
              * perceptualOpacityScale(previewInk, getComputedStyle(document.documentElement).getPropertyValue('--bg-elevated').trim())
          )
        },
        previewInk
      )
    : undefined;
  return (
    <button
      type="button"
      className={`surface-pack-card${active ? ' active' : ''}`}
      aria-pressed={active}
      aria-label={`${pack.name} surface${active ? ', active' : ''}`}
      data-testid={`surface-card-${pack.id}`}
      onClick={onSelect}
    >
      <span className="surface-pack-swatch" aria-hidden="true">
        <span className="surface-pack-swatch-canvas" style={{ background: pack.swatch.canvas ?? 'var(--bg)' }} />
        <span
          className="surface-pack-swatch-panel"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            backgroundImage: pack.swatch.panel ?? 'none',
            mixBlendMode: (pack.swatch.blend as CSSProperties['mixBlendMode']) ?? 'normal'
          }}
        />
        {preview && (
          <span
            className="surface-pack-swatch-pattern"
            data-testid={`surface-swatch-pattern-${pack.id}`}
            style={{ backgroundImage: preview.image, backgroundSize: preview.size, opacity: Number(preview.opacity) }}
          />
        )}
      </span>
      <span className="surface-pack-meta">
        <strong>{pack.name}</strong>
        {active && <span className="surface-pack-active">Active</span>}
      </span>
      <span className="surface-pack-description">{pack.description}</span>
    </button>
  );
}

const CUSTOM_COLOR_FIELDS = [
  ['canvas', 'Canvas'], ['panel', 'Panel'], ['raised', 'Raised'], ['border', 'Border'], ['text', 'Text'],
  ['muted', 'Muted text'], ['accent', 'Accent'], ['success', 'Success'], ['warning', 'Warning'], ['danger', 'Danger']
] as const;

function CustomThemeEditor({
  theme, onChange, onSave, onDelete, onCancel, onDuplicate, onExport
}: {
  theme: ThemeDefinition & { source: 'custom' };
  onChange: (theme: ThemeDefinition & { source: 'custom' }) => void;
  onSave: () => void;
  onDelete?: () => void;
  onCancel: () => void;
  onDuplicate?: () => void;
  onExport?: () => void;
}) {
  const update = (patch: Partial<ThemeDefinition>) => onChange({ ...theme, ...patch, source: 'custom' });
  const updateColor = (key: string, value: string) => onChange({ ...theme, source: 'custom', preview: { ...theme.preview, [key]: value } });
  return <div className="custom-theme-editor" role="region" aria-label="Custom theme editor">
    <div className="custom-theme-editor-heading"><div><strong>{theme.id.startsWith('custom-') ? 'Custom theme' : 'Edit custom theme'}</strong><span>Changes preview live after saving.</span></div><button type="button" className="icon-btn icon-btn-sm" aria-label="Close custom theme editor" onClick={onCancel}>×</button></div>
    <div className="custom-theme-editor-grid">
      <label>Name<input value={theme.name} onChange={event => update({ name: event.target.value })} maxLength={80} /></label>
      <label>Mode<select value={theme.mode} onChange={event => update({ mode: event.target.value as 'light' | 'dark' })}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label className="wide">Description<input value={theme.description} onChange={event => update({ description: event.target.value })} maxLength={240} /></label>
    </div>
    <div className="custom-theme-color-grid">{CUSTOM_COLOR_FIELDS.map(([key, label]) => <label key={key}>{label}<span><input type="color" value={/^#[0-9a-f]{6}$/i.test(theme.preview[key]) ? theme.preview[key] : '#7c5cff'} onChange={event => updateColor(key, event.target.value)} /><input value={theme.preview[key]} onChange={event => updateColor(key, event.target.value)} /></span></label>)}</div>
    <div className="custom-theme-editor-actions"><button type="button" onClick={onCancel}>Cancel</button>{onExport && <button type="button" onClick={onExport}>Export</button>}{onDuplicate && <button type="button" onClick={onDuplicate}>Duplicate</button>}{onDelete && <button type="button" className="danger" onClick={onDelete}>Delete</button>}<button type="button" className="primary" onClick={onSave} disabled={!theme.name.trim()}>Save theme</button></div>
  </div>;
}

type CustomSurfacePack = AppSettings['appearance']['customSurfacePacks'][number];

const SURFACE_BLEND_MODES = ['soft-light', 'overlay', 'normal', 'multiply', 'screen'] as const;

/** The editor works in friendly dial units; these map 1:1 to a `--surface-*` token map. */
interface SurfaceDials {
  panelOpacity: number; // 40..100  → --surface-panel-opacity
  blur: number;         // 0..40 px → --surface-panel-blur (+ derived backdrop)
  glow: number;         // 0..40 px → --surface-accent-glow
  texture: number;      // 0..30    → --surface-texture-opacity (÷100)
  radius: number;       // 0..8 px  → --surface-radius-boost
  blend: string;        //          → --surface-texture-blend
  grain: boolean;       //          → --surface-texture-image on/off
}

const DEFAULT_SURFACE_DIALS: SurfaceDials = {
  panelOpacity: 100, blur: 0, glow: 0, texture: 12, radius: 1, blend: 'soft-light', grain: true
};

function dialsToTokens(d: SurfaceDials): Record<string, string> {
  const tokens: Record<string, string> = {
    '--surface-panel-opacity': (d.panelOpacity / 100).toFixed(2),
    '--surface-radius-boost': `${Math.round(d.radius)}px`,
    '--surface-texture-blend': SURFACE_BLEND_MODES.includes(d.blend as never) ? d.blend : 'soft-light'
  };
  if (d.blur > 0) {
    tokens['--surface-panel-blur'] = `${Math.round(d.blur)}px`;
    tokens['--surface-panel-saturate'] = '1.4';
  }
  if (d.grain) {
    tokens['--surface-texture-image'] = 'var(--surface-swatch-grain)';
    tokens['--surface-texture-size'] = '160px 160px';
    tokens['--surface-texture-opacity'] = (Math.max(0, Math.min(30, d.texture)) / 100).toFixed(3);
  } else {
    tokens['--surface-texture-opacity'] = '0';
  }
  if (d.glow > 0) {
    tokens['--surface-accent-glow'] =
      `0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 0 ${Math.round(d.glow)}px color-mix(in srgb, var(--accent) 24%, transparent)`;
  }
  return tokens;
}

function tokensToDials(tokens: Record<string, string>): SurfaceDials {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const grainOn = (tokens['--surface-texture-image'] ?? 'none') !== 'none'
    && num(tokens['--surface-texture-opacity'], 0) > 0;
  return {
    panelOpacity: Math.round(num(tokens['--surface-panel-opacity'], 1) * 100),
    blur: num(tokens['--surface-panel-blur'], 0),
    glow: tokens['--surface-accent-glow']
      ? num((/0 0 (\d+(?:\.\d+)?)px/.exec(tokens['--surface-accent-glow']) ?? [])[1], 16)
      : 0,
    texture: Math.round(num(tokens['--surface-texture-opacity'], 0.12) * 100),
    radius: num(tokens['--surface-radius-boost'], 0),
    blend: tokens['--surface-texture-blend'] ?? 'soft-light',
    grain: grainOn
  };
}

/** Keep only whitelisted `--surface-*` string keys — mirrors core's validator for imports. */
function sanitizeSurfaceTokens(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([key, value]) => SURFACE_TOKEN_KEYS.includes(key) && typeof value === 'string')
  ) as Record<string, string>;
}

/**
 * Custom surface editor — the material-layer parallel of `CustomThemeEditor`.
 * Dials write straight to a validated `--surface-*` token map; Export / Import
 * round-trips that map as JSON.
 */
function CustomSurfaceEditor({
  pack, onChange, onSave, onDelete, onCancel, onExport
}: {
  pack: CustomSurfacePack;
  onChange: (pack: CustomSurfacePack) => void;
  onSave: () => void;
  onDelete?: () => void;
  onCancel: () => void;
  onExport: () => void;
}) {
  const dials = tokensToDials(pack.tokens);
  const setDials = (patch: Partial<SurfaceDials>) =>
    onChange({ ...pack, tokens: dialsToTokens({ ...dials, ...patch }) });
  const importRef = useRef<HTMLInputElement>(null);

  // The pattern is picked from the shared library, never authored — this is what
  // lets a user build a new material (honeycomb, drafting grid, weave) without
  // any code. See surfacePatterns.ts.
  const pattern: SurfacePatternSpec = pack.pattern ?? { id: 'none', scale: 120, opacity: 0.08, ink: 'accent' };
  const setPattern = (patch: Partial<SurfacePatternSpec>) =>
    onChange({ ...pack, pattern: { ...pattern, ...patch } });

  const runImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<CustomSurfacePack>;
        onChange({
          ...pack,
          name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 80) : pack.name,
          description: typeof parsed.description === 'string' ? parsed.description.slice(0, 240) : pack.description,
          basePackId: typeof parsed.basePackId === 'string' ? parsed.basePackId : pack.basePackId,
          pattern: findSurfacePattern((parsed.pattern as SurfacePatternSpec | undefined)?.id)
            ? (parsed.pattern as SurfacePatternSpec)
            : pack.pattern,
          tokens: { ...dialsToTokens(DEFAULT_SURFACE_DIALS), ...sanitizeSurfaceTokens(parsed.tokens) }
        });
      } catch {
        // A malformed file leaves the editor untouched.
      }
    };
    reader.readAsText(file);
  };

  return <div className="custom-theme-editor" role="region" aria-label="Custom surface editor">
    <div className="custom-theme-editor-heading"><div><strong>{pack.name || 'Custom surface'}</strong><span>Changes preview live.</span></div><button type="button" className="icon-btn icon-btn-sm" aria-label="Close custom surface editor" onClick={onCancel}>×</button></div>
    <div className="custom-theme-editor-grid">
      <label>Name<input value={pack.name} onChange={event => onChange({ ...pack, name: event.target.value })} maxLength={80} data-testid="custom-surface-name" /></label>
      <label>Base
        <select value={pack.basePackId ?? ''} onChange={event => onChange({ ...pack, basePackId: event.target.value || undefined })}>
          <option value="">None</option>
          {SURFACE_PACKS.filter(base => base.id !== 'flat').map(base => <option key={base.id} value={base.id}>{base.name}</option>)}
        </select>
      </label>
      <label className="wide">Description<input value={pack.description} onChange={event => onChange({ ...pack, description: event.target.value })} maxLength={240} /></label>
    </div>
    <div className="surface-dials">
      <label className="surface-dial"><span className="surface-dial-label">Panel opacity <em>{dials.panelOpacity}%</em></span>
        <input type="range" min={40} max={100} step={2} value={dials.panelOpacity} data-testid="custom-surface-opacity" onChange={event => setDials({ panelOpacity: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Backdrop blur <em>{Math.round(dials.blur)}px</em></span>
        <input type="range" min={0} max={40} step={1} value={dials.blur} onChange={event => setDials({ blur: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Accent glow <em>{Math.round(dials.glow)}px</em></span>
        <input type="range" min={0} max={40} step={1} value={dials.glow} onChange={event => setDials({ glow: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Texture <em>{dials.texture}%</em></span>
        <input type="range" min={0} max={30} step={1} value={dials.texture} disabled={!dials.grain} onChange={event => setDials({ texture: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Corner boost <em>{Math.round(dials.radius)}px</em></span>
        <input type="range" min={0} max={8} step={1} value={dials.radius} onChange={event => setDials({ radius: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Blend</span>
        <select value={dials.blend} onChange={event => setDials({ blend: event.target.value })}>{SURFACE_BLEND_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>
    </div>
    <div className="surface-dials surface-pattern-dials">
      <label className="surface-dial"><span className="surface-dial-label">Pattern</span>
        <select
          value={pattern.id}
          data-testid="custom-surface-pattern"
          onChange={event => setPattern({ id: event.target.value })}
        >{SURFACE_PATTERNS.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label className="surface-dial"><span className="surface-dial-label">Pattern scale <em>{Math.round(pattern.scale)}px</em></span>
        <input type="range" min={16} max={260} step={4} value={Math.round(pattern.scale)} disabled={pattern.id === 'none'}
          data-testid="custom-surface-pattern-scale"
          onChange={event => setPattern({ scale: Number(event.target.value) })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Pattern strength <em>{Math.round(pattern.opacity * 100)}%</em></span>
        <input type="range" min={0} max={40} step={1} value={Math.round(pattern.opacity * 100)} disabled={pattern.id === 'none'}
          onChange={event => setPattern({ opacity: Number(event.target.value) / 100 })} /></label>
      <label className="surface-dial"><span className="surface-dial-label">Pattern ink</span>
        <select value={pattern.ink ?? 'accent'} disabled={pattern.id === 'none'}
          onChange={event => setPattern({ ink: event.target.value as SurfacePatternInk })}>
          <option value="accent">Accent</option>
          <option value="text">Text</option>
        </select></label>
    </div>
    <Toggle label="Grain texture" checked={dials.grain} onChange={next => setDials({ grain: next })} testId="custom-surface-grain" />
    <input ref={importRef} type="file" accept="application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) runImport(file); event.target.value = ''; }} />
    <div className="custom-theme-editor-actions">
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" onClick={() => importRef.current?.click()}>Import</button>
      <button type="button" onClick={onExport}>Export</button>
      {onDelete && <button type="button" className="danger" onClick={onDelete}>Delete</button>}
      <button type="button" className="primary" onClick={onSave} disabled={!pack.name.trim()}>Save surface</button>
    </div>
  </div>;
}

const MOTIF_ANCHORS: Array<[SurfacePatternAnchor, string]> = [
  ['top-left', 'Top left'], ['top-right', 'Top right'],
  ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']
];

/**
 * The Motif panel — the material's figurative layer, promoted out of the custom
 * editor so it applies over *any* pack and *any* theme. Every control writes a
 * partial override; unset fields keep whatever the active pack chose, and Reset
 * clears the override entirely.
 */
function MotifPanel({
  pack, motif, disabled, onChange
}: {
  pack?: SurfacePackDefinition;
  motif?: SurfaceMotifSettings;
  disabled?: boolean;
  onChange: (motif: SurfaceMotifSettings | undefined) => void;
}) {
  const base = pack?.pattern;
  const effective: SurfacePatternSpec = {
    id: 'none', scale: 62, opacity: 0.3, ink: 'accent',
    placement: 'tile', anchor: 'top-right', spread: DEFAULT_MOTIF_SPREAD, fade: DEFAULT_MOTIF_FADE,
    fill: 0, outline: 0,
    ...(base ?? {}),
    ...(motif ?? {})
  };
  const set = (patch: Partial<SurfacePatternSpec>) =>
    onChange({ ...effective, ...patch } as SurfaceMotifSettings);
  const isCorner = effective.placement === 'corner';
  const overridden = motif !== undefined;

  return (
    <section className={`surface-motif${disabled ? ' disabled' : ''}`} data-testid="motif-panel">
      <div className="surface-motif-head">
        <div>
          <strong>Motif</strong>
          <span>The mark laid on the material. Independent of the pack, so it rides over any theme.</span>
        </div>
        {overridden && (
          <button type="button" className="surface-motif-reset" data-testid="motif-reset" onClick={() => onChange(undefined)}>
            Reset to pack
          </button>
        )}
      </div>
      <div className="surface-dials surface-motif-dials">
        <label className="surface-dial"><span className="surface-dial-label">Pattern</span>
          <select value={effective.id} disabled={disabled} data-testid="motif-pattern"
            onChange={e => set({ id: e.target.value })}>
            {SURFACE_PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>

        <label className="surface-dial"><span className="surface-dial-label">Placement</span>
          <select value={effective.placement} disabled={disabled || effective.id === 'none'} data-testid="motif-placement"
            onChange={e => set({ placement: e.target.value as SurfacePatternPlacement })}>
            <option value="tile">Tile — repeats everywhere</option>
            <option value="corner">Corner — one fading mark</option>
          </select></label>

        {isCorner && (
          <label className="surface-dial"><span className="surface-dial-label">Anchor</span>
            <select value={effective.anchor} disabled={disabled} data-testid="motif-anchor"
              onChange={e => set({ anchor: e.target.value as SurfacePatternAnchor })}>
              {MOTIF_ANCHORS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
        )}

        <label className="surface-dial"><span className="surface-dial-label">Cell size <em>{Math.round(effective.scale)}px</em></span>
          <input type="range" min={16} max={220} step={2} value={Math.round(effective.scale)}
            disabled={disabled || effective.id === 'none'} data-testid="motif-scale"
            onChange={e => set({ scale: Number(e.target.value) })} /></label>

        {isCorner && (
          <>
            <label className="surface-dial"><span className="surface-dial-label">Spread <em>{Math.round(effective.spread ?? 0)}px</em></span>
              <input type="range" min={200} max={1600} step={20} value={Math.round(effective.spread ?? DEFAULT_MOTIF_SPREAD)}
                disabled={disabled} data-testid="motif-spread"
                onChange={e => set({ spread: Number(e.target.value) })} /></label>
            <label className="surface-dial"><span className="surface-dial-label">Fade <em>{Math.round((effective.fade ?? 0) * 100)}%</em></span>
              <input type="range" min={10} max={100} step={2} value={Math.round((effective.fade ?? DEFAULT_MOTIF_FADE) * 100)}
                disabled={disabled} data-testid="motif-fade"
                onChange={e => set({ fade: Number(e.target.value) / 100 })} /></label>
          </>
        )}

        <label className="surface-dial"><span className="surface-dial-label">Solid cells <em>{Math.round((effective.fill ?? 0) * 100)}%</em></span>
          <input type="range" min={0} max={100} step={17} value={Math.round((effective.fill ?? 0) * 100)}
            disabled={disabled || effective.id !== 'hexagon'} data-testid="motif-fill"
            onChange={e => set({ fill: Number(e.target.value) / 100 })} /></label>

        <label className="surface-dial">
          <span className="surface-dial-label">Outline <em>{effective.outline ? `${Math.round(effective.outline * 100)}%` : 'off'}</em></span>
          <input type="range" min={0} max={100} step={5} value={Math.round((effective.outline ?? 0) * 100)}
            disabled={disabled || effective.id === 'none'} data-testid="motif-outline"
            onChange={e => set({ outline: Number(e.target.value) / 100 })} /></label>

        <label className="surface-dial"><span className="surface-dial-label">Strength <em>{Math.round(effective.opacity * 100)}%</em></span>
          <input type="range" min={0} max={60} step={1} value={Math.round(effective.opacity * 100)}
            disabled={disabled || effective.id === 'none'} data-testid="motif-strength"
            onChange={e => set({ opacity: Number(e.target.value) / 100 })} /></label>

        <label className="surface-dial"><span className="surface-dial-label">Line weight <em>{(effective.weight ?? 0.055).toFixed(3)}</em></span>
          <input type="range" min={5} max={200} step={5} value={Math.round((effective.weight ?? 0.055) * 1000)}
            disabled={disabled || effective.id === 'none'} data-testid="motif-weight"
            onChange={e => set({ weight: Number(e.target.value) / 1000 })} /></label>

        <label className="surface-dial"><span className="surface-dial-label">Colour</span>
          <select value={effective.ink ?? 'accent'} disabled={disabled || effective.id === 'none'} data-testid="motif-ink"
            onChange={e => set({ ink: e.target.value as SurfacePatternInk })}>
            <option value="accent">Theme accent</option>
            <option value="text">Theme text</option>
            <option value="custom">Custom…</option>
          </select></label>

        {effective.ink === 'custom' && (
          <label className="surface-dial"><span className="surface-dial-label">Custom colour</span>
            <span className="surface-motif-colour">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(effective.inkColor ?? '') ? effective.inkColor! : '#c6431f'}
                disabled={disabled} data-testid="motif-ink-color"
                onChange={e => set({ inkColor: e.target.value })} />
              <input value={effective.inkColor ?? ''} placeholder="#c6431f" disabled={disabled} maxLength={9}
                onChange={e => set({ inkColor: e.target.value })} />
            </span></label>
        )}
      </div>
    </section>
  );
}

function ThemesSection({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const category = CATEGORIES.find(c => c.id === 'themes')!;
  const [selectedTheme, setSelectedTheme] = useState(() => settings.appearance.themeId || getInitialThemeId());
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ThemeDefinition & { source: 'custom' }>();
  const [, refreshCustomThemes] = useState(0);
  const installedIds = settings.appearance.installedThemeIds ?? [];
  const custom = settings.appearance.customThemes ?? [];

  const surfaceId = settings.appearance.surfacePackId;
  const surfaceOpts = settings.appearance.surface;
  const customSurfacePacks = settings.appearance.customSurfacePacks ?? [];
  const applySurface = (id: string, opts: typeof surfaceOpts) =>
    applySurfacePack(id, {
      intensity: opts.intensity,
      texture: opts.texture,
      translucency: opts.translucency,
      windowVibrancy: opts.windowVibrancy,
      motif: opts.motif
    });
  const currentMode = ((document.documentElement.getAttribute('data-mode') as SurfaceMode | null) ?? 'dark');
  const visibleSurfacePacks = allSurfacePacks().filter(pack => pack.supports.includes(currentMode));
  const activeSurfacePack = allSurfacePacks().find(pack => pack.id === surfaceId);
  const [editingSurface, setEditingSurface] = useState<CustomSurfacePack>();
  const [vibrancySupported, setVibrancySupported] = useState(false);
  useEffect(() => {
    void window.ticketManager.window.supportsVibrancy?.().then(setVibrancySupported).catch(() => setVibrancySupported(false));
  }, []);

  const persistSurfacePacks = (packs: CustomSurfacePack[], nextActiveId?: string) => {
    registerCustomSurfacePacks(packs);
    if (nextActiveId) {
      applySurface(nextActiveId, surfaceOpts);
    }
    return update({ appearance: { customSurfacePacks: packs, ...(nextActiveId ? { surfacePackId: nextActiveId } : {}) } });
  };
  const newCustomSurface = (): CustomSurfacePack => ({
    id: `custom-${Date.now().toString(36)}`,
    name: 'My surface',
    description: '',
    basePackId: 'parchment',
    pattern: { id: 'hexagon', scale: 124, opacity: 0.08, ink: 'accent', weight: 0.8 },
    tokens: dialsToTokens(DEFAULT_SURFACE_DIALS)
  });
  const exportSurface = (pack: CustomSurfacePack) => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${pack.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'surface'}.surface.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    registerCustomThemes(custom);
    refreshCustomThemes(value => value + 1);
  }, [custom]);

  useEffect(() => {
    if (!editing) return;
    const draft = { id: editing.id, name: editing.name, mode: editing.mode, description: editing.description, preview: { ...editing.preview } as Record<string, string> };
    registerCustomThemes([...custom.filter(theme => theme.id !== draft.id), draft]);
    applyThemePreference(editing.id, editing.mode);
  }, [editing]);

  const createCustom = () => setEditing({
    id: `custom-${Date.now().toString(36)}`, name: 'My Theme', family: 'Praxis', section: 'Recent', source: 'custom', mode: 'dark',
    description: 'A custom Praxis theme.',
    preview: { canvas: '#1c1c1c', panel: '#202020', raised: '#181818', border: '#3d3d3d', text: '#e4e4e4', muted: '#858585', accent: '#7c5cff', success: '#3fb950', warning: '#d29922', danger: '#f47067' }
  });

  const saveCustom = async () => {
    if (!editing) return;
    const draft = editing;
    if (!draft.name.trim()) return;
    const record = { id: draft.id, name: draft.name.trim(), mode: draft.mode, description: draft.description.trim(), preview: { ...draft.preview } as Record<string, string> };
    const next = [...custom.filter(theme => theme.id !== record.id), record];
    await update({ appearance: { customThemes: next, installedThemeIds: [...new Set([...installedIds, record.id])], themeId: record.id, themeMode: record.mode } });
    registerCustomThemes(next);
    applyThemePreference(record.id, record.mode);
    setSelectedTheme(record.id);
    setEditing(undefined);
  };

  const importCustom = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as Partial<ThemeDefinition>;
      if (typeof raw.name !== 'string' || !raw.preview || typeof raw.preview !== 'object') throw new Error('Invalid theme file');
      setEditing({ id: `custom-${Date.now().toString(36)}`, name: raw.name, family: 'Praxis', section: 'Recent', source: 'custom', mode: raw.mode === 'light' ? 'light' : 'dark', description: typeof raw.description === 'string' ? raw.description : 'Imported custom theme.', preview: raw.preview as ThemeDefinition['preview'] });
    } catch { /* Invalid files are ignored without changing the current editor. */ }
  };

  const exportCustom = () => {
    if (!editing) return;
    const blob = new Blob([JSON.stringify({ name: editing.name, mode: editing.mode, description: editing.description, preview: editing.preview }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${editing.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'custom-theme'}.json`; anchor.click(); URL.revokeObjectURL(url);
  };

  const deleteCustom = async () => {
    if (!editing) return;
    const next = custom.filter(theme => theme.id !== editing.id);
    const fallback = selectedTheme === editing.id ? 'praxis-dark' : selectedTheme;
    await update({ appearance: { customThemes: next, installedThemeIds: installedIds.filter(id => id !== editing.id), ...(selectedTheme === editing.id ? { themeId: fallback, themeMode: 'dark' } : {}) } });
    registerCustomThemes(next);
    if (selectedTheme === editing.id) { setSelectedTheme(fallback); applyThemePreference(fallback, 'dark'); }
    setEditing(undefined);
  };

  const themes = allThemes();
  useEffect(() => {
    const syncTheme = (event: Event) => setSelectedTheme((event as CustomEvent<string>).detail);
    window.addEventListener('tm-theme-changed', syncTheme);
    return () => window.removeEventListener('tm-theme-changed', syncTheme);
  }, []);

  const visible = themes.filter(theme => {
    const needle = query.trim().toLowerCase();
    return !needle || `${theme.name} ${theme.family} ${theme.mode} ${theme.description}`.toLowerCase().includes(needle);
  });

  return (
    <>
      <CategoryHeader category={category} />
      <div className="custom-theme-toolbar"><button type="button" className="btn btn-secondary" onClick={createCustom}>＋ Create custom theme</button><label className="btn btn-secondary">Import theme<input type="file" accept="application/json,.json" hidden onChange={event => void importCustom(event)} /></label><span>Design your own palette with a live preview.</span></div>
      {editing && <CustomThemeEditor theme={editing} onChange={setEditing} onSave={() => void saveCustom()} onDelete={custom.some(theme => theme.id === editing.id) ? () => void deleteCustom() : undefined} onDuplicate={() => setEditing({ ...editing, id: `custom-${Date.now().toString(36)}`, name: `${editing.name} Copy` })} onExport={exportCustom} onCancel={() => { setEditing(undefined); applyThemePreference(selectedTheme, settings.appearance.themeMode as ThemeModePreference); }} />}
      <div className="theme-mode-toolbar" role="group" aria-label="Theme appearance mode">
        <span>Appearance</span>
        {(['system', 'light', 'dark'] as const).map(mode => (
          <button key={mode} type="button" className={settings.appearance.themeMode === mode ? 'active' : ''}
            onClick={() => {
              applyThemePreference(selectedTheme, mode);
              void update({ appearance: { themeMode: mode } });
            }}>{mode === 'system' ? 'System' : mode[0]!.toUpperCase() + mode.slice(1)}</button>
        ))}
      </div>
      <div className="theme-gallery-toolbar">
        <label className="theme-gallery-search">
          <Icon name="search" size={13} />
          <input type="search" value={query} aria-label="Search themes" placeholder={`Search ${themes.length} themes…`} onChange={event => setQuery(event.target.value)} />
        </label>
        <span>{visible.length} themes</span>
      </div>
      {(['Recent', 'Staff picks'] as const).map(section => {
        const sectionThemes = visible.filter(theme => theme.section === section && (!theme.source || installedIds.includes(theme.id)));
        if (sectionThemes.length === 0) return null;
        return (
          <section className="theme-gallery-section" key={section}>
            <h4>{section}</h4>
            <div className="theme-gallery-grid">
              {sectionThemes.map(theme => (
                <ThemePreviewCard key={theme.id} theme={theme} installed={theme.source !== 'marketplace' || installedIds.includes(theme.id)} active={selectedTheme === theme.id} onSelect={() => {
                  setSelectedTheme(theme.id);
                  applyThemePreference(theme.id, theme.mode);
                  void update({ appearance: { themeId: theme.id, themeMode: theme.mode } });
                }} onEdit={theme.source === 'custom' ? () => setEditing(theme as ThemeDefinition & { source: 'custom' }) : undefined} />
              ))}
            </div>
          </section>
        );
      })}
      {visible.some(theme => theme.source === 'marketplace' && !installedIds.includes(theme.id)) && (
        <section className="theme-gallery-section theme-marketplace-section">
          <div className="theme-marketplace-heading">
            <div><h4>Marketplace</h4><p>Install community-curated palettes into this workspace.</p></div>
            <span className="theme-marketplace-count">{visible.filter(theme => theme.source === 'marketplace' && !installedIds.includes(theme.id)).length} available</span>
          </div>
          <div className="theme-gallery-grid">
            {visible.filter(theme => theme.source === 'marketplace' && !installedIds.includes(theme.id)).map(theme => (
              <ThemePreviewCard key={theme.id} theme={theme} active={false} installed={false} onSelect={() => undefined}
                onInstall={() => void update({ appearance: { installedThemeIds: [...installedIds, theme.id], themeId: theme.id, themeMode: theme.mode } }).then(() => {
                  setSelectedTheme(theme.id);
                  applyThemePreference(theme.id, theme.mode);
                })} />
            ))}
          </div>
        </section>
      )}
      {visible.length === 0 && <div className="placeholder-text">No themes match “{query}”.</div>}

      <section className="theme-gallery-section surface-section" data-testid="surface-section">
        <div className="theme-marketplace-heading">
          <div><h4>Surface</h4><p>A material layer — texture, grain, depth, translucency — on top of the theme above. Composes with any theme.</p></div>
        </div>
        <div className="theme-gallery-grid surface-pack-grid">
          {visibleSurfacePacks.map(pack => (
            <div className="surface-pack-card-wrap" key={pack.id}>
              <SurfacePackCard
                pack={pack}
                active={surfaceId === pack.id}
                onSelect={() => {
                  applySurface(pack.id, surfaceOpts);
                  void update({ appearance: { surfacePackId: pack.id } });
                }}
              />
              {pack.source === 'custom' && (
                <button
                  type="button"
                  className="surface-pack-edit"
                  aria-label={`Edit ${pack.name}`}
                  data-testid={`surface-edit-${pack.id}`}
                  onClick={() => setEditingSurface(customSurfacePacks.find(record => record.id === pack.id))}
                >Edit</button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="surface-new-btn"
          data-testid="surface-new"
          onClick={() => setEditingSurface(newCustomSurface())}
        >+ New custom surface</button>
        {editingSurface && (
          <CustomSurfaceEditor
            pack={editingSurface}
            onChange={setEditingSurface}
            onCancel={() => setEditingSurface(undefined)}
            onExport={() => exportSurface(editingSurface)}
            onDelete={customSurfacePacks.some(record => record.id === editingSurface.id)
              ? () => {
                  const remaining = customSurfacePacks.filter(record => record.id !== editingSurface.id);
                  setEditingSurface(undefined);
                  void persistSurfacePacks(remaining, surfaceId === editingSurface.id ? 'parchment' : undefined);
                }
              : undefined}
            onSave={() => {
              const others = customSurfacePacks.filter(record => record.id !== editingSurface.id);
              const nextPacks = [...others, editingSurface];
              setEditingSurface(undefined);
              void persistSurfacePacks(nextPacks, editingSurface.id);
            }}
          />
        )}
        <MotifPanel
          pack={activeSurfacePack}
          motif={surfaceOpts.motif}
          disabled={surfaceId === 'flat'}
          onChange={next => {
            const updated = { ...surfaceOpts, motif: next };
            applySurface(surfaceId, updated);
            void update({ appearance: { surface: { motif: next } } });
          }}
        />
        <div className="surface-dials">
          <label className="surface-dial">
            <span className="surface-dial-label">Intensity <em>{Math.round(surfaceOpts.intensity * 100)}%</em></span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(surfaceOpts.intensity * 100)}
              aria-label="Surface intensity"
              data-testid="surface-intensity"
              disabled={surfaceId === 'flat'}
              onChange={event => {
                const next = { ...surfaceOpts, intensity: Number(event.target.value) / 100 };
                applySurface(surfaceId, next);
                void update({ appearance: { surface: { intensity: next.intensity } } });
              }}
            />
          </label>
        </div>
        <Toggle
          label="Texture"
          description="Paper fibre, brushed metal, and other grain layers. Turn off for flat panels while keeping the pack's depth and edges."
          checked={surfaceOpts.texture}
          disabled={surfaceId === 'flat'}
          testId="surface-texture-toggle"
          onChange={next => {
            const updated = { ...surfaceOpts, texture: next };
            applySurface(surfaceId, updated);
            void update({ appearance: { surface: { texture: next } } });
          }}
        />
        <Toggle
          label="Translucency"
          description="Frosted, see-through panels for glass packs like Aurora Glass. Ignored by opaque packs; forced off when the OS asks for reduced transparency."
          checked={surfaceOpts.translucency}
          disabled={!activeSurfacePack?.glass}
          testId="surface-translucency-toggle"
          onChange={next => {
            const updated = { ...surfaceOpts, translucency: next };
            applySurface(surfaceId, updated);
            void update({ appearance: { surface: { translucency: next } } });
          }}
        />
        {vibrancySupported && (
          <Toggle
            label="Window blur"
            description="Let the desktop behind the app show through frosted panels, using the OS's native vibrancy. Takes full effect after the next relaunch."
            checked={surfaceOpts.windowVibrancy}
            disabled={!activeSurfacePack?.glass || !surfaceOpts.translucency}
            testId="surface-vibrancy-toggle"
            onChange={next => {
              const updated = { ...surfaceOpts, windowVibrancy: next };
              applySurface(surfaceId, updated);
              void update({ appearance: { surface: { windowVibrancy: next } } });
            }}
          />
        )}
      </section>
    </>
  );
}

function AppearanceSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'appearance')!;
  return (
    <>
      <CategoryHeader category={category} />
      <div className="settings-list">
        <Toggle
          label="Brand artwork in board list"
          description="Show each backend's logo (Jira, GitHub, GitLab) as the board icon. When off, boards use the generic board-type icons."
          checked={settings.appearance.showBrandArtwork}
          onChange={next => void update({ appearance: { showBrandArtwork: next } })}
        />
      </div>
      <div className="priority-color-list">
        {PRIORITY_NAMES.map(priority => (
          <PriorityColorRow
            key={priority}
            priority={priority}
            value={settings.appearance.priorityColors[priority] ?? ''}
            onCommit={next =>
              update({ appearance: { priorityColors: { [priority]: next } } })
            }
          />
        ))}
      </div>
    </>
  );
}

function TerminalSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'terminal')!;
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; shell: string; isDefault: boolean }>>([]);

  useEffect(() => {
    let active = true;
    void window.ticketManager.terminal.listProfiles().then(next => {
      if (active) setProfiles(next);
    });
    return () => { active = false; };
  }, []);

  const updateTerminal = (patch: Partial<AppSettings['terminal']>) => void update({ terminal: patch });
  const profileId = settings.terminal.defaultProfileId || profiles.find(profile => profile.isDefault)?.id || '';

  return (
    <>
      <CategoryHeader category={category} />
      <div className="settings-subsection-title">Profiles</div>
      <FieldRow
        label="Default profile"
        description="Used when you click New terminal without choosing a profile."
      >
        <select
          className="select"
          aria-label="Terminal default profile"
          value={profileId}
          onChange={event => updateTerminal({ defaultProfileId: event.target.value })}
        >
          {profiles.length === 0 && <option value="">Detecting profiles…</option>}
          {profiles.map(profile => (
            <option key={profile.id} value={profile.id}>{profile.name} · {profile.shell}</option>
          ))}
        </select>
      </FieldRow>
      <div className="settings-subsection-title">Appearance</div>
      <FieldRow label="Font family" description="A comma-separated CSS font stack used by terminal sessions.">
        <DebouncedTextField
          ariaLabel="Terminal font family"
          value={settings.terminal.fontFamily}
          onCommit={value => updateTerminal({ fontFamily: value })}
          placeholder="Menlo, Monaco, monospace"
        />
      </FieldRow>
      <FieldRow label="Font size" description="Terminal text size in pixels.">
        <input
          className="input settings-number-input"
          aria-label="Terminal font size"
          type="number"
          min={9}
          max={32}
          value={settings.terminal.fontSize}
          onChange={event => updateTerminal({ fontSize: Number(event.target.value) })}
        />
      </FieldRow>
      <FieldRow label="Line height" description="Multiplier applied to each terminal row.">
        <input
          className="input settings-number-input"
          aria-label="Terminal line height"
          type="number"
          min={0.9}
          max={2}
          step={0.05}
          value={settings.terminal.lineHeight}
          onChange={event => updateTerminal({ lineHeight: Number(event.target.value) })}
        />
      </FieldRow>
      <FieldRow label="Cursor" description="Choose the cursor shape used in terminal sessions.">
        <select
          className="select"
          aria-label="Terminal cursor style"
          value={settings.terminal.cursorStyle}
          onChange={event => updateTerminal({ cursorStyle: event.target.value as AppSettings['terminal']['cursorStyle'] })}
        >
          <option value="block">Block</option>
          <option value="bar">Line</option>
          <option value="underline">Underline</option>
        </select>
      </FieldRow>
      <Toggle
        label="Blinking cursor"
        description="Animate the cursor while the terminal is focused."
        checked={settings.terminal.cursorBlink}
        onChange={next => updateTerminal({ cursorBlink: next })}
      />
      <Toggle
        label="GPU acceleration"
        description="Use WebGL rendering when available for smoother terminal output."
        checked={settings.terminal.gpuAcceleration}
        onChange={next => updateTerminal({ gpuAcceleration: next })}
      />
      <div className="settings-subsection-title">Behaviour</div>
      <FieldRow label="Scrollback" description="Number of terminal lines retained for scrolling and chat context.">
        <input
          className="input settings-number-input"
          aria-label="Terminal scrollback"
          type="number"
          min={100}
          max={100000}
          step={100}
          value={settings.terminal.scrollback}
          onChange={event => updateTerminal({ scrollback: Number(event.target.value) })}
        />
      </FieldRow>
      <Toggle
        label="Copy on selection"
        description="Copy selected terminal text immediately, like a native terminal."
        checked={settings.terminal.copyOnSelection}
        onChange={next => updateTerminal({ copyOnSelection: next })}
      />
      <Toggle
        label="Confirm paste"
        description="Ask before pasting multi-line text into a shell."
        checked={settings.terminal.confirmPaste}
        onChange={next => updateTerminal({ confirmPaste: next })}
      />
      <Toggle
        label="Terminal bell"
        description="Play a subtle sound when a shell emits a bell."
        checked={settings.terminal.bellSound}
        onChange={next => updateTerminal({ bellSound: next })}
      />
      <Toggle
        label="Shell integration"
        description="Advertise terminal capabilities to shells that support integration sequences."
        checked={settings.terminal.shellIntegration}
        onChange={next => updateTerminal({ shellIntegration: next })}
      />
    </>
  );
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** A `linear-gradient(...)` broken into the parts the row can edit with color pickers. */
interface GradientParts {
  /** Everything before the first color stop, e.g. `to bottom` or `90deg`. */
  direction: string;
  /** Two or more `#rrggbb` stops, in source order. */
  stops: string[];
}

/**
 * Parses the subset of `linear-gradient(...)` the editor can offer pickers for:
 * an optional direction followed by two or more bare `#rrggbb` stops. Anything
 * richer (named colors, `rgb()`, percentage positions, nested functions) parses
 * to `undefined` and stays text-only — it is still a valid stored value.
 */
function parseLinearGradient(value: string): GradientParts | undefined {
  const match = /^\s*linear-gradient\s*\(([\s\S]*)\)\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const parts = match[1].split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const hasDirection = !HEX6.test(parts[0]!);
  const direction = hasDirection ? parts[0]! : 'to bottom';
  const stops = hasDirection ? parts.slice(1) : parts;
  if (stops.length < 2 || !stops.every(stop => HEX6.test(stop))) {
    return undefined;
  }
  return { direction, stops };
}

function formatLinearGradient({ direction, stops }: GradientParts): string {
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

/** Directions offered in the row's dropdown. A value using anything else keeps its
 *  own direction as an extra option so switching stops never rewrites it. */
const GRADIENT_DIRECTIONS = ['to bottom', 'to top', 'to right', 'to left', 'to bottom right'];

/** Scales a `#rrggbb` toward black (positive ratio) or white (negative). Used to
 *  seed the second stop when a solid color is switched to a gradient, so the new
 *  gradient is visibly a gradient instead of two identical stops. */
function shiftHex(hex: string, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const next = ratio >= 0 ? c * (1 - ratio) : c + (255 - c) * -ratio;
    return Math.max(0, Math.min(255, Math.round(next)));
  });
  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Inline style that paints `value` — gradients need `background-image`, hex needs `background-color`. */
function colorStyle(value: string): React.CSSProperties {
  return /^\s*linear-gradient/i.test(value)
    ? { backgroundImage: value, backgroundColor: 'transparent' }
    : { backgroundImage: 'none', backgroundColor: value };
}

/**
 * One priority's color, edited entirely with pickers: a Solid/Gradient toggle, a
 * direction dropdown, and one `<input type="color">` per stop (two for the
 * shipped gradients). Values that the parser cannot represent as pickers — named
 * colors, `rgb()`, percentage stops — fall back to a raw CSS text field so an
 * existing setting is never silently dropped or rewritten.
 */
function PriorityColorRow({
  priority,
  value,
  onCommit
}: {
  priority: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const gradient = useMemo(() => parseLinearGradient(value), [value]);
  const hex = useMemo(() => (HEX6.test(value.trim()) ? value.trim().toUpperCase() : undefined), [value]);

  const setStop = (index: number, next: string) => {
    if (!gradient) {
      return;
    }
    const stops = gradient.stops.slice();
    stops[index] = next.toUpperCase();
    onCommit(formatLinearGradient({ ...gradient, stops }));
  };

  const toGradient = () => {
    const start = hex ?? '#808080';
    onCommit(formatLinearGradient({ direction: 'to bottom', stops: [start, shiftHex(start, 0.35)] }));
  };

  const toSolid = () => {
    onCommit(gradient?.stops[0] ?? '#808080');
  };

  const directions = gradient && !GRADIENT_DIRECTIONS.includes(gradient.direction)
    ? [gradient.direction, ...GRADIENT_DIRECTIONS]
    : GRADIENT_DIRECTIONS;

  return (
    <div className="priority-color-row">
      <span className="priority-swatch" style={colorStyle(value)} aria-hidden />
      <div className="priority-color-name">{priority}</div>

      {hex || gradient ? (
        <>
          <div className="priority-mode-toggle" role="group" aria-label={`${priority} color style`}>
            <button
              type="button"
              className={`priority-mode-btn${hex ? ' active' : ''}`}
              aria-pressed={Boolean(hex)}
              onClick={toSolid}
            >
              Solid
            </button>
            <button
              type="button"
              className={`priority-mode-btn${gradient ? ' active' : ''}`}
              aria-pressed={Boolean(gradient)}
              onClick={toGradient}
            >
              Gradient
            </button>
          </div>

          <div className="priority-color-pickers">
            {hex && (
              <input
                type="color"
                className="priority-color-picker"
                value={hex}
                aria-label={`${priority} priority color`}
                onChange={event => onCommit(event.target.value.toUpperCase())}
              />
            )}
            {gradient?.stops.map((stop, index) => (
              <input
                /* Index is a stable identity: the stop count only changes when the
                   whole value is replaced, which re-renders this list wholesale. */
                key={index}
                type="color"
                className="priority-color-picker"
                value={stop}
                aria-label={
                  index === 0
                    ? `${priority} gradient start color`
                    : index === gradient.stops.length - 1
                      ? `${priority} gradient end color`
                      : `${priority} gradient stop ${index + 1}`
                }
                onChange={event => setStop(index, event.target.value)}
              />
            ))}
          </div>

          {gradient ? (
            <select
              className="input priority-gradient-direction"
              value={gradient.direction}
              aria-label={`${priority} gradient direction`}
              onChange={event => onCommit(formatLinearGradient({ ...gradient, direction: event.target.value }))}
            >
              {directions.map(direction => (
                <option key={direction} value={direction}>
                  {direction}
                </option>
              ))}
            </select>
          ) : (
            <span />
          )}
        </>
      ) : (
        <CustomColorField priority={priority} value={value} onCommit={onCommit} />
      )}
    </div>
  );
}

/** Escape hatch for stored values the pickers cannot represent. */
function CustomColorField({
  priority,
  value,
  onCommit
}: {
  priority: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(value);
    setError(undefined);
  }, [value]);

  const commit = () => {
    // A bare `rrggbb` is a common paste shape; accept it by adding the `#`.
    const candidate = /^[0-9a-fA-F]{6}$/.test(draft.trim()) ? `#${draft.trim()}` : draft;
    const normalised = normalizePriorityColor(candidate);
    if (!normalised) {
      setError('Use a #rrggbb hex or a linear-gradient(...) expression.');
      return;
    }
    setError(undefined);
    onCommit(normalised);
  };

  return (
    <>
      <input
        type="text"
        className="input priority-color-custom"
        value={draft}
        aria-label={`${priority} priority color`}
        placeholder="#rrggbb or linear-gradient(…)"
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            commit();
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      {error && <div className="error-banner priority-color-error">{error}</div>}
    </>
  );
}

interface DebouncedTextFieldProps {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  delayMs?: number;
}

/** Multi-line variant of DebouncedTextField (e.g. the analysis system prompt). */
function DebouncedTextArea({ ariaLabel, value, placeholder, onCommit, delayMs = 600 }: DebouncedTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const schedule = (next: string) => {
    setDraft(next);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => onCommit(next), delayMs);
  };
  return (
    <textarea
      className="textarea"
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      rows={4}
      onChange={event => schedule(event.target.value)}
      style={{ width: '100%' }}
    />
  );
}

function DebouncedTextField({ ariaLabel, value, placeholder, onCommit, delayMs = 400 }: DebouncedTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const schedule = (next: string) => {
    setDraft(next);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => onCommit(next), delayMs);
  };
  return (
    <input
      type="text"
      className="input"
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={event => schedule(event.target.value)}
      style={{ width: '100%' }}
    />
  );
}

interface DebouncedNumberFieldProps {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  onCommit: (next: number) => void;
  delayMs?: number;
}

function DebouncedNumberField({ ariaLabel, value, min, max, onCommit, delayMs = 400 }: DebouncedNumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const commit = (next: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    let clamped = parsed;
    if (typeof min === 'number' && clamped < min) {
      clamped = min;
    }
    if (typeof max === 'number' && clamped > max) {
      clamped = max;
    }
    setDraft(String(clamped));
    if (clamped !== value) {
      onCommit(clamped);
    }
  };
  return (
    <input
      type="number"
      className="input"
      value={draft}
      aria-label={ariaLabel}
      min={min}
      max={max}
      onChange={event => {
        const next = event.target.value;
        setDraft(next);
        if (timer.current) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => commit(next), delayMs);
      }}
      onBlur={event => commit(event.target.value)}
      style={{ width: 140 }}
    />
  );
}
