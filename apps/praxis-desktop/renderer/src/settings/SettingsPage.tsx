import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { useDialogs } from '../ui/dialogs';
import type {
  AiProvider,
  AiProviderStatus,
  AgentRuntimeSnapshot,
  AgentSessionRecord,
  AddonKind,
  AddonUpdate,
  AppSettings,
  AppSettingsPatch,
  AppearanceLook,
  CatalogEntry,
  InstalledAddon,
  MarketplaceStatus,
  SurfaceMotifSettings,
  BoardsSidebarMode,
  Connection
} from '@praxis/core';
import {
  BUILT_IN_LOOKS,
  DEFAULT_APP_SETTINGS,
  normalizePriorityColor,
  PRIORITY_NAMES
} from './settingsDefaults';
import { Icon, type IconName } from '../ui/Icon';
import { ModelManagerPanel } from '../ai/ModelManagerPanel';
import { AiUsageStatsSection } from './AiUsageStatsSection';
import { MODEL_PROVIDERS } from '../ai/modelProviders';
import {
  formatCost,
  formatTokenCount,
  sessionsWithinDays,
  summariseSpend,
  summariseSpendByConnection,
  summariseSpendByProviderModel,
  type SpendGroupRow
} from '../ai/sessionNav';
import { useSettings } from './useSettings';
import { useKindAddons } from './marketplaceAddons';
import { isHostShimProfile } from '../agents/agentCatalog';
import { BUILT_IN_GADGET_CATALOG } from '../ai/gadgets';
import { allThemes, applySurfacePack, applyThemePreference, DEFAULT_THEME_ID, getInitialThemeId, registerCustomThemes, resolvePatternInk, THEMES, type ThemeDefinition, type ThemeModePreference, type ThemePreviewColors } from './themes';
import { allSurfacePacks, registerCustomSurfacePacks, SURFACE_PACKS, SURFACE_TOKEN_KEYS, type SurfaceMode, type SurfacePackDefinition } from './surfacePacks';
import {
  DEFAULT_MOTIF_FADE, DEFAULT_MOTIF_SPREAD, findSurfacePattern, isRevealAnimation,
  perceptualOpacityScale, resolveSurfacePattern, SURFACE_MOTIF_ANIMATIONS, SURFACE_PATTERNS,
  type SurfaceMotifAnimation, type SurfacePatternAnchor, type SurfacePatternInk,
  type SurfacePatternPlacement, type SurfacePatternSpec
} from './surfacePatterns';

export type SettingsCategory =
  | 'overview'
  | 'startup'
  | 'connections'
  | 'marketplace'
  | 'jira'
  | 'ai'
  | 'ai-usage'
  | 'gadgets'
  | 'agent-runtime'
  | 'workflow-templates'
  | 'performance'
  | 'delivery'
  | 'mcp'
  | 'preview'
  | 'appearance-themes'
  | 'appearance-looks'
  | 'appearance-surfaces'
  | 'appearance'
  | 'terminal';

interface CategoryDef {
  id: SettingsCategory;
  label: string;
  icon: IconName;
  description: string;
}

/** A collapsible parent in the settings nav. Its children are real categories; the header itself only expands/collapses. */
interface NavGroupDef {
  id: string;
  label: string;
  icon: IconName;
  children: SettingsCategory[];
}

/**
 * Four sections, so the nav's shape tells the truth about where weight sits.
 * Sixteen equal peers read as sixteen equally-important choices — with three of
 * them appearance, a new user is told appearance matters three times as much as
 * connecting their tracker. Overview stays loose at the top as the landing page.
 */
const APPEARANCE_GROUP: NavGroupDef = {
  id: 'appearance-group',
  label: 'Appearance',
  icon: 'theme',
  children: ['appearance-themes', 'appearance-surfaces', 'appearance-looks']
};

const WORKSPACE_GROUP: NavGroupDef = {
  id: 'workspace-group',
  label: 'Workspace',
  icon: 'home',
  children: ['startup', 'appearance']
};

const AI_GROUP: NavGroupDef = {
  id: 'ai-group',
  label: 'AI & agents',
  icon: 'robot',
  children: ['ai', 'ai-usage', 'gadgets', 'agent-runtime', 'workflow-templates', 'mcp', 'delivery']
};

const INTEGRATIONS_GROUP: NavGroupDef = {
  id: 'integrations-group',
  label: 'Integrations & tools',
  icon: 'plug',
  children: ['connections', 'marketplace', 'jira', 'terminal', 'performance', 'preview']
};

type NavEntry = { type: 'item'; category: SettingsCategory } | { type: 'group'; group: NavGroupDef };

const NAV: NavEntry[] = [
  { type: 'item', category: 'overview' },
  { type: 'group', group: WORKSPACE_GROUP },
  { type: 'group', group: APPEARANCE_GROUP },
  { type: 'group', group: AI_GROUP },
  { type: 'group', group: INTEGRATIONS_GROUP }
];

const CATEGORIES: CategoryDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'home',
    description: 'Quick summary of where settings live and what is currently configured.'
  },
  {
    id: 'startup',
    label: 'Startup',
    icon: 'rocket',
    description: 'Choose what Praxis opens when the desktop app starts.'
  },
  {
    id: 'appearance-themes',
    label: 'Themes',
    icon: 'theme',
    description: 'Choose a complete color palette for the Praxis interface.'
  },
  {
    id: 'appearance-looks',
    label: 'Looks',
    icon: 'sparkles',
    description: 'One-click presets that bundle a theme, surface, motif, and colours.'
  },
  {
    id: 'appearance-surfaces',
    label: 'Surfaces',
    icon: 'sliders',
    description: 'The material layer — texture, grain, depth, translucency — worn over any theme.'
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
    id: 'ai-usage',
    label: 'AI Usage',
    icon: 'graph',
    description: 'Token and cost usage across every session and internal AI feature, by day, week, or month.'
  },
  {
    id: 'gadgets',
    label: 'Gadgets',
    icon: 'tools',
    description: 'Interactive chat surfaces Praxis uses to present tool results, evidence, and decisions.'
  },
  {
    id: 'agent-runtime',
    label: 'Agent Runtime',
    icon: 'robot',
    description: 'Local AI runtimes, agent profiles, launch bindings, and progressively indexed skills.'
  },
  {
    id: 'workflow-templates',
    label: 'Workflow Templates',
    icon: 'git-branch',
    description: 'Starting points for the workflow designer — install more from the marketplace.'
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
  },
  {
    id: 'marketplace',
    label: 'Add-ons',
    icon: 'archive',
    description: 'Install themes, surface packs, agents, and workflow templates from a GitHub Packages catalogue.'
  }
];

interface SettingsPageProps {
  connections: Connection[];
  onOpenConnections: () => void;
  initialCategory?: SettingsCategory;
  onNewAgentItem?: (kind: 'agent' | 'import') => void;
  onOpenAgent?: (agentId: string) => void;
}

export function SettingsPage({ connections, onOpenConnections, initialCategory = 'overview', onNewAgentItem, onOpenAgent }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsCategory>(initialCategory);
  const [resettingData, setResettingData] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<'defaults' | 'sessions' | 'project-data' | 'appearance'>();
  const { settings, update, error } = useSettings();

  const resetToDefaults = async () => {
    await update({ ...DEFAULT_APP_SETTINGS });
    setResetConfirmation('sessions');
  };

  const clearProjectWorkspaceBoardData = async () => {
    setResettingData(true);
    try {
      await window.praxis.settings.clearProjectWorkspaceBoardData();
      await window.praxis.window.reload();
    } finally {
      setResettingData(false);
    }
  };

  const resetAppearanceToFactory = async () => {
    const appearance = DEFAULT_APP_SETTINGS.appearance;
    applyThemePreference(appearance.themeId, appearance.themeMode);
    applySurfacePack(appearance.surfacePackId, appearance.surface);
    await update({
      appearance: {
        showBrandArtwork: appearance.showBrandArtwork,
        themeId: appearance.themeId,
        themeMode: appearance.themeMode,
        installedThemeIds: [...appearance.installedThemeIds],
        customThemes: [],
        surfacePackId: appearance.surfacePackId,
        // `surface` is merged by the settings backend, so explicitly provide
        // an undefined motif to remove a user override rather than leaving the
        // previous motif behind.
        surface: { ...appearance.surface, motif: undefined },
        installedSurfacePackIds: [...appearance.installedSurfacePackIds],
        customSurfacePacks: [],
        looks: appearance.looks.map(look => ({ ...look, surface: { ...look.surface }, priorityColors: { ...look.priorityColors } })),
        activeLookId: appearance.activeLookId,
        priorityColors: { ...appearance.priorityColors }
      }
    });
    await window.praxis.window.reload();
  };

  const confirmResetAction = async () => {
    const action = resetConfirmation;
    setResetConfirmation(undefined);
    if (action === 'defaults') {
      await resetToDefaults();
    } else if (action === 'sessions') {
      await window.praxis.settings.clearSessionData();
      await window.praxis.window.reload();
    } else if (action === 'project-data') {
      await clearProjectWorkspaceBoardData();
    } else if (action === 'appearance') {
      await resetAppearanceToFactory();
    }
  };

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
        {NAV.map(entry =>
          entry.type === 'item' ? (
            <NavItem
              key={entry.category}
              def={CATEGORIES.find(category => category.id === entry.category)!}
              active={active}
              onSelect={setActive}
            />
          ) : (
            <NavGroup key={entry.group.id} group={entry.group} active={active} onSelect={setActive} />
          )
        )}
      </nav>
      <div className="settings-content">
        {error && <div className="error-banner">{error}</div>}
        {active === 'overview' && (
          <OverviewSection
            settings={settings}
            onReset={() => setResetConfirmation('defaults')}
            onResetAppearance={() => setResetConfirmation('appearance')}
            onClearProjectWorkspaceBoardData={() => setResetConfirmation('project-data')}
            clearingProjectWorkspaceBoardData={resettingData}
          />
        )}
        {active === 'startup' && <StartupSection settings={settings} update={update} />}
        {active === 'connections' && (
          <ConnectionsSection connections={connections} onOpenConnections={onOpenConnections} />
        )}
        {active === 'marketplace' && <MarketplaceSection />}
        {active === 'jira' && <JiraSection settings={settings} update={update} />}
        {active === 'ai' && <AiSection settings={settings} update={update} connections={connections} />}
        {active === 'ai-usage' && <AiUsageStatsSection />}
        {active === 'gadgets' && <GadgetsSection />}
        {active === 'agent-runtime' && (
          <AgentRuntimeSection settings={settings} onNewAgentItem={onNewAgentItem} onOpenAgent={onOpenAgent} />
        )}
        {active === 'workflow-templates' && <WorkflowTemplatesSection />}
        {active === 'performance' && <PerformanceSection settings={settings} update={update} />}
        {active === 'delivery' && <DeliverySection settings={settings} update={update} />}
        {active === 'mcp' && <McpSection settings={settings} update={update} />}
        {active === 'preview' && <PreviewSection settings={settings} update={update} />}
        {active === 'appearance-themes' && <ThemesGallerySection settings={settings} update={update} />}
        {active === 'appearance-looks' && <LooksSection settings={settings} update={update} />}
        {active === 'appearance-surfaces' && <SurfacesSection settings={settings} update={update} />}
        {active === 'appearance' && <AppearanceSection settings={settings} update={update} />}
        {active === 'terminal' && <TerminalSection settings={settings} update={update} />}
      </div>
      {resetConfirmation && (
        <ResetConfirmationDialog
          action={resetConfirmation}
          onCancel={() => setResetConfirmation(undefined)}
          onConfirm={() => void confirmResetAction()}
        />
      )}
    </div>
  );
}

function ResetConfirmationDialog({
  action,
  onCancel,
  onConfirm
}: {
  action: 'defaults' | 'sessions' | 'project-data' | 'appearance';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const content = action === 'defaults'
    ? {
        title: 'Reset settings to defaults?',
        message: 'All Praxis settings will be replaced with their shipped defaults. Connections and credentials will be kept.',
        confirm: 'Reset settings'
      }
    : action === 'sessions'
      ? {
          title: 'Clear saved session data too?',
          message: 'This removes saved AI sessions and issue-analysis history from this device. Connections and credentials will be kept.',
          confirm: 'Clear session data'
        }
      : action === 'project-data'
        ? {
            title: 'Clear project data?',
            message: 'This removes app-owned projects, workspaces, tracked boards, board layouts, and task canvases. Portable workspace files and connections will be kept.',
            confirm: 'Clear project data'
          }
        : {
          title: 'Reset appearance to factory defaults?',
          message: 'This restores the factory theme, Looks, surface, motifs, priority colours, and appearance libraries. Other settings and connections will be kept.',
          confirm: 'Reset appearance'
          };

  return (
    <div className="modal-overlay" data-testid="reset-confirmation-overlay">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="reset-confirmation-title">
        <div className="modal-header">
          <div>
            <h2 id="reset-confirmation-title">{content.title}</h2>
            <p>{content.message}</p>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>{content.confirm}</button>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  def,
  active,
  onSelect,
  nested
}: {
  def: CategoryDef;
  active: SettingsCategory;
  onSelect: (id: SettingsCategory) => void;
  nested?: boolean;
}) {
  return (
    <button
      className={`settings-nav-item${nested ? ' nested' : ''}${active === def.id ? ' active' : ''}`}
      onClick={() => onSelect(def.id)}
      data-testid={`settings-nav-${def.id}`}
      type="button"
    >
      <span className="tree-icon">
        <Icon name={def.icon} size={15} />
      </span>
      <span className="settings-nav-label">{def.label}</span>
    </button>
  );
}

function NavGroup({
  group,
  active,
  onSelect
}: {
  group: NavGroupDef;
  active: SettingsCategory;
  onSelect: (id: SettingsCategory) => void;
}) {
  const containsActive = group.children.includes(active);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  return (
    <>
      <button
        className={`settings-nav-item settings-nav-group${open ? ' open' : ''}${containsActive ? ' has-active' : ''}`}
        onClick={() => setOpen(value => !value)}
        data-testid={`settings-nav-${group.id}`}
        aria-expanded={open}
        type="button"
      >
        <span className="settings-nav-chevron">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </span>
        <span className="tree-icon">
          <Icon name={group.icon} size={15} />
        </span>
        <span className="settings-nav-label">{group.label}</span>
      </button>
      {open &&
        group.children.map(childId => (
          <NavItem
            key={childId}
            def={CATEGORIES.find(category => category.id === childId)!}
            active={active}
            onSelect={onSelect}
            nested
          />
        ))}
    </>
  );
}

function AgentRuntimeSection({
  settings,
  onNewAgentItem,
  onOpenAgent
}: {
  settings: AppSettings;
  onNewAgentItem?: (kind: 'agent' | 'import') => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot>();
  const [roots, setRoots] = useState<{ agents: Record<string, string>; runtimeHosts?: Record<string, string>; profiles?: Record<string, string>; skills: Record<string, string> }>();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const agentAddons = useKindAddons('agent');
  useEffect(() => {
    if (agentAddons.ready && agentAddons.catalog === undefined && !agentAddons.busy) {
      void agentAddons.browse();
    }
  }, [agentAddons.ready, agentAddons.catalog, agentAddons.busy, agentAddons.browse]);
  const installedAgentAddonIds = new Set(agentAddons.installed.map(addon => addon.manifest.id));

  const refresh = async () => {
    setBusy(true);
    try {
      setSnapshot(await window.praxis.agentRuntime.refresh());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void window.praxis.agentRuntime.list().then(setSnapshot).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    void window.praxis.agentRuntime.roots().then(setRoots).catch(() => {});
    void window.praxis.ai.listProviderStatuses().then(setProviderStatuses).catch(() => {});
  }, []);

  const runtimeProviders = AI_PROVIDERS.filter(provider => provider.kind === 'cli-agent');
  // Every binding always has *some* profile entry — one it wrote itself
  // (curated) or one Praxis auto-synthesizes as a placeholder when it has no
  // AGENT.md. Only the curated ones belong under "Agent profiles"; a binding
  // whose only profile is that placeholder is a custom launch binding.
  const profiles = (snapshot?.profiles ?? []).filter(profile => !isHostShimProfile(profile));
  const launchBindings = snapshot?.runtimeHosts ?? snapshot?.agents ?? [];
  const launchBindingsById = new Map(launchBindings.map(binding => [binding.manifest.id, binding]));
  const standaloneBindings = launchBindings.filter(binding => !profiles.some(profile => profile.profile.id === binding.manifest.id));

  return (
    <section data-testid="settings-agent-runtime">
      <CategoryHeader category={CATEGORIES.find(category => category.id === 'agent-runtime')!} />
      <div className="settings-list">
        <div className="settings-field-row">
          <div className="settings-field-label">
            <strong>Registry</strong>
            <div className="settings-field-help">
              Read-only diagnostics. AI runtimes execute sessions; profiles define behaviour; launch bindings connect custom agents to Praxis.
            </div>
          </div>
          <div className="settings-field-control">
            <button className="btn" type="button" onClick={() => void refresh()} disabled={busy} data-testid="agent-runtime-refresh">
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {roots && (
          <div className="settings-field-row" data-testid="agent-runtime-paths">
            <div className="settings-field-label">
              <strong>Discovery paths</strong>
              <div className="settings-field-help">
                Global profiles: <code>{roots.profiles?.global ?? roots.agents.global}</code>
                <br />
                Global launch bindings: <code>{roots.runtimeHosts?.global ?? roots.agents.global}</code> · skills: <code>{roots.skills.global}</code>
                <br />
                Project profiles: <code>{roots.profiles?.project ?? roots.agents.project}</code>
                <br />
                Project launch bindings: <code>{roots.runtimeHosts?.project ?? roots.agents.project}</code> · skills: <code>{roots.skills.project}</code>
              </div>
            </div>
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        {!snapshot && !error && <div className="placeholder-text">Loading agent runtime…</div>}
        {snapshot && (
          <>
            <div className="settings-section-description">
              Last refreshed: {snapshot.refreshedAt || 'not yet'} · {runtimeProviders.length} AI runtimes · {profiles.length} profiles · {launchBindings.length} launch bindings · {snapshot.skills.length} skills
            </div>

            <h4 className="settings-subsection-title">AI runtimes</h4>
            <p className="settings-field-help">
              These are the executors used for AI sessions. Configure them in <strong>AI Provider</strong>; a profile such as Praxis Reviewer can run on any available runtime.
            </p>
            {runtimeProviders.map(runtime => {
              const status = providerStatuses.find(candidate => candidate.provider === runtime.id);
              const isActive = settings.ai.activeProvider === runtime.id;
              return (
                <div className="settings-field-row" key={runtime.id} data-testid={`agent-runtime-provider-${runtime.id}`}>
                  <div className="settings-field-label">
                    <strong>{runtime.label}</strong>
                    <div className="settings-field-help">
                      AI runtime · {status ? (status.configured ? 'available' : 'unavailable') : 'checking availability'}{isActive ? ' · active for new sessions' : ''}
                    </div>
                  </div>
                </div>
              );
            })}

            <h4 className="settings-subsection-title">Agent profiles</h4>
            {profiles.map(profile => {
              const binding = launchBindingsById.get(profile.profile.id);
              return (
                <div className="settings-field-row" key={profile.profile.id} data-testid={`agent-runtime-profile-${profile.profile.id}`}>
                  <div className="settings-field-label">
                    <strong>{profile.profile.name}</strong>
                    <div className="settings-field-help">
                      agent profile · {profile.scope} · {profile.trusted ? 'trusted' : 'approval required'} · uses the runtime selected for the session
                      {binding ? ` · ${binding.manifest.type.toUpperCase()} launch binding` : ''}
                      {profile.legacy ? ' · legacy brief.md' : ''}
                      {profile.error ? ` · ${profile.error}` : ''}
                      {binding?.errors.length ? ` · ${binding.errors.map(item => item.message).join('; ')}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
            {profiles.length === 0 && <div className="placeholder-text">No agent profiles discovered.</div>}

            <div className="settings-field-row">
              <div className="settings-field-label">
                <strong>Custom launch bindings</strong>
                <div className="settings-field-help">
                  Advanced: a transport manifest for an agent that isn't just an AGENT.md profile running on a provider — creation and import live here, not in the primary Agent Hub.
                </div>
              </div>
              {(onNewAgentItem || onOpenAgent) && (
                <div className="settings-field-control">
                  {onNewAgentItem && (
                    <>
                      <button className="btn" type="button" onClick={() => onNewAgentItem('agent')} data-testid="agent-runtime-new-binding">
                        New launch binding
                      </button>
                      <button className="btn" type="button" onClick={() => onNewAgentItem('import')} data-testid="agent-runtime-import-binding">
                        Import…
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            {standaloneBindings.map(binding => (
              <div className="settings-field-row" key={binding.manifest.id} data-testid={`agent-runtime-binding-${binding.manifest.id}`}>
                <div className="settings-field-label">
                  <strong>{binding.manifest.name}</strong>
                  <div className="settings-field-help">launch binding · {binding.manifest.type} · {binding.scope} · {binding.trusted ? 'trusted' : 'approval required'}{binding.errors.length ? ` · ${binding.errors.map(item => item.message).join('; ')}` : ''}</div>
                </div>
                {onOpenAgent && (
                  <div className="settings-field-control">
                    <button className="btn-compact" type="button" onClick={() => onOpenAgent(binding.manifest.id)}>
                      Manage
                    </button>
                  </div>
                )}
              </div>
            ))}
            {standaloneBindings.length === 0 && <div className="placeholder-text">No custom launch bindings.</div>}

            <h4 className="settings-subsection-title">Skills</h4>
            {snapshot.skills.map(skill => (
              <div className="settings-field-row" key={skill.metadata.name} data-testid={`agent-runtime-skill-${skill.metadata.name}`}>
                <div className="settings-field-label">
                  <strong>{skill.metadata.name}</strong>
                  <div className="settings-field-help">{skill.error ? `Invalid: ${skill.error}` : `${skill.scope} · ${skill.trusted ? 'indexed' : 'approval required'}`}</div>
                </div>
              </div>
            ))}
            {snapshot.skills.length === 0 && <div className="placeholder-text">No skills discovered.</div>}
          </>
        )}

        <div data-testid="agent-runtime-marketplace">
        <h4 className="settings-subsection-title">Marketplace</h4>
        {agentAddons.error && <div className="error-banner">{agentAddons.error}</div>}
        {!agentAddons.ready && (
          <p className="settings-field-help">Set up the add-on catalogue in Settings › Add-ons to install agents from GitHub Packages.</p>
        )}
        {agentAddons.installed.map(addon => (
          <div className="settings-field-row" key={addon.manifest.id} data-testid={`agent-marketplace-installed-${addon.manifest.id}`}>
            <div className="settings-field-label">
              <strong>{addon.manifest.name}</strong>
              <div className="settings-field-help">
                v{addon.version} · {addon.enabled ? 'trusted — runs like a global agent' : 'installed but not trusted — will not run until you allow it'}
              </div>
            </div>
            <div className="settings-field-control settings-inline-controls">
              <button
                className="btn btn-quiet"
                type="button"
                disabled={agentAddons.busy === `trust:${addon.manifest.id}`}
                onClick={() => void agentAddons.setTrust(addon.manifest.id, !addon.enabled)}
              >
                {addon.enabled ? 'Revoke trust' : 'Trust'}
              </button>
              <button
                className="btn btn-quiet"
                type="button"
                disabled={agentAddons.busy === `remove:${addon.manifest.id}`}
                onClick={() => void agentAddons.remove(addon.manifest.id)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {agentAddons.ready && agentAddons.catalog === undefined && <div className="placeholder-text">Loading the catalogue…</div>}
        {(agentAddons.catalog ?? [])
          .filter(entry => !installedAgentAddonIds.has(entry.manifest.id))
          .map(entry => (
            <div className="settings-field-row" key={entry.packageName} data-testid={`agent-marketplace-${entry.manifest.id}`}>
              <div className="settings-field-label">
                <strong>{entry.manifest.name}</strong>
                <div className="settings-field-help">
                  v{entry.latestVersion}
                  {entry.manifest.author ? ` · ${entry.manifest.author}` : ''}
                  {entry.manifest.summary ? ` — ${entry.manifest.summary}` : ''}
                  {entry.incompatible ? ' · needs a newer Praxis' : ''}
                </div>
              </div>
              <div className="settings-field-control">
                <button
                  className="btn"
                  type="button"
                  disabled={entry.incompatible || agentAddons.busy === `install:${entry.packageName}`}
                  onClick={() => void agentAddons.install(entry.packageName)}
                >
                  Install (untrusted)
                </button>
              </div>
            </div>
          ))}
        {agentAddons.ready &&
          agentAddons.catalog?.filter(entry => !installedAgentAddonIds.has(entry.manifest.id)).length === 0 &&
          agentAddons.installed.length === 0 && (
            <div className="placeholder-text">No agents in the catalogue.</div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * A `workflow-template` add-on is declarative — it activates on install, no
 * trust step, the same as a theme or surface pack (see marketplaceInstance.ts'
 * `globalTemplateDefinitions`, which reads every installed-and-enabled one
 * straight onto the "New workflow" dialog's global tier). This panel is the
 * only place that install can happen — nothing else in the app browses this
 * kind's catalogue.
 */
function WorkflowTemplatesSection() {
  const templateAddons = useKindAddons('workflow-template');
  useEffect(() => {
    if (templateAddons.ready && templateAddons.catalog === undefined && !templateAddons.busy) {
      void templateAddons.browse();
    }
  }, [templateAddons.ready, templateAddons.catalog, templateAddons.busy, templateAddons.browse]);
  const installedTemplateIds = new Set(templateAddons.installed.map(addon => addon.manifest.id));

  return (
    <section data-testid="settings-workflow-templates">
      <CategoryHeader category={CATEGORIES.find(category => category.id === 'workflow-templates')!} />
      <div className="settings-list">
        <div className="settings-field-row">
          <div className="settings-field-label">
            <div className="settings-field-help">
              An installed template appears alongside <strong>Governed delivery</strong> and{' '}
              <strong>Quick change</strong> in every project's New Workflow dialog. Its agent stages
              still need matching agents installed and trusted in <strong>Agent Runtime</strong> before a run can start.
            </div>
          </div>
        </div>

        <div data-testid="workflow-template-marketplace">
          <h4 className="settings-subsection-title">Marketplace</h4>
          {templateAddons.error && <div className="error-banner">{templateAddons.error}</div>}
          {!templateAddons.ready && (
            <p className="settings-field-help">Set up the add-on catalogue in Settings › Add-ons to install workflow templates from GitHub Packages.</p>
          )}
          {templateAddons.installed.map(addon => (
            <div className="settings-field-row" key={addon.manifest.id} data-testid={`workflow-template-installed-${addon.manifest.id}`}>
              <div className="settings-field-label">
                <strong>{addon.manifest.name}</strong>
                <div className="settings-field-help">v{addon.version}{addon.manifest.summary ? ` — ${addon.manifest.summary}` : ''}</div>
              </div>
              <div className="settings-field-control">
                <button
                  className="btn btn-quiet"
                  type="button"
                  disabled={templateAddons.busy === `remove:${addon.manifest.id}`}
                  onClick={() => void templateAddons.remove(addon.manifest.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {templateAddons.ready && templateAddons.catalog === undefined && <div className="placeholder-text">Loading the catalogue…</div>}
          {(templateAddons.catalog ?? [])
            .filter(entry => !installedTemplateIds.has(entry.manifest.id))
            .map(entry => (
              <div className="settings-field-row" key={entry.packageName} data-testid={`workflow-template-marketplace-${entry.manifest.id}`}>
                <div className="settings-field-label">
                  <strong>{entry.manifest.name}</strong>
                  <div className="settings-field-help">
                    v{entry.latestVersion}
                    {entry.manifest.author ? ` · ${entry.manifest.author}` : ''}
                    {entry.manifest.summary ? ` — ${entry.manifest.summary}` : ''}
                    {entry.incompatible ? ' · needs a newer Praxis' : ''}
                  </div>
                </div>
                <div className="settings-field-control">
                  <button
                    className="btn"
                    type="button"
                    disabled={entry.incompatible || templateAddons.busy === `install:${entry.packageName}`}
                    onClick={() => void templateAddons.install(entry.packageName)}
                  >
                    Install
                  </button>
                </div>
              </div>
            ))}
          {templateAddons.ready &&
            templateAddons.catalog?.filter(entry => !installedTemplateIds.has(entry.manifest.id)).length === 0 &&
            templateAddons.installed.length === 0 && (
              <div className="placeholder-text">No workflow templates in the catalogue.</div>
            )}
        </div>
      </div>
    </section>
  );
}

export const ADDON_KIND_LABELS: Record<AddonKind, string> = {
  theme: 'Theme',
  'surface-pack': 'Surface pack',
  agent: 'Agent',
  skill: 'Skill',
  'workflow-template': 'Workflow template'
};

/**
 * Central marketplace *configuration* only — the GitHub Packages owner, token,
 * and endpoints. Browsing and installing add-ons happens in each kind's own
 * panel (Themes, Surfaces, Agent Runtime — Skills too, right alongside Agents),
 * so a user sees the add-ons for a thing where they already are.
 */
function MarketplaceSection() {
  const [status, setStatus] = useState<MarketplaceStatus>();
  const [installed, setInstalled] = useState<InstalledAddon[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testCounts, setTestCounts] = useState<Record<AddonKind, number>>();
  const [testError, setTestError] = useState<string>();

  // Local edit buffer for the config form, seeded from status.
  const [ownerDraft, setOwnerDraft] = useState('');
  const [ownerTypeDraft, setOwnerTypeDraft] = useState<'user' | 'org'>('user');
  const [prefixDraft, setPrefixDraft] = useState('');
  const [apiUrlDraft, setApiUrlDraft] = useState('');
  const [registryUrlDraft, setRegistryUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');

  const refreshStatus = async () => {
    const next = await window.praxis.marketplace.getStatus();
    setStatus(next);
    setOwnerDraft(next.owner);
    setOwnerTypeDraft(next.ownerType);
    setPrefixDraft(next.packageNamePrefix);
    setApiUrlDraft(next.apiBaseUrl);
    setRegistryUrlDraft(next.registryBaseUrl);
    return next;
  };

  useEffect(() => {
    void refreshStatus().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    void window.praxis.marketplace.listInstalled().then(setInstalled).catch(() => {});
    return window.praxis.marketplace.onChanged(() => {
      void window.praxis.marketplace.listInstalled().then(setInstalled).catch(() => {});
    });
  }, []);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const saveConfig = () =>
    run('config', async () => {
      await window.praxis.marketplace.configure({
        owner: ownerDraft.trim(),
        ownerType: ownerTypeDraft,
        packageNamePrefix: prefixDraft.trim() || 'praxis-addon-',
        apiBaseUrl: apiUrlDraft.trim() || 'https://api.github.com',
        registryBaseUrl: registryUrlDraft.trim() || 'https://npm.pkg.github.com'
      });
      await refreshStatus();
    });

  const saveToken = () =>
    run('token', async () => {
      await window.praxis.marketplace.setToken(tokenDraft.trim() || null);
      setTokenDraft('');
      // Update status to show token is stored, but preserve unsaved config drafts
      setStatus(s => (s ? { ...s, hasToken: true } : undefined));
    });

  const toggleEnabled = (enabled: boolean) =>
    run('enabled', async () => {
      await window.praxis.marketplace.configure({ enabled });
      await refreshStatus();
    });

  // Hits the real GitHub Packages catalogue directly — the same call every
  // kind's own panel makes — and counts entries per kind, so a config change
  // can be checked right here instead of hopping to Themes/Surfaces/Agent
  // Runtime and reading "N available" in each one separately.
  const testCatalog = async () => {
    setBusy('test');
    setTestError(undefined);
    setTestCounts(undefined);
    try {
      const entries = await window.praxis.marketplace.listCatalog();
      const counts: Record<AddonKind, number> = {
        theme: 0,
        'surface-pack': 0,
        agent: 0,
        skill: 0,
        'workflow-template': 0
      };
      for (const entry of entries) {
        counts[entry.manifest.kind] += 1;
      }
      setTestCounts(counts);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const byKind = new Map<AddonKind, number>();
  for (const addon of installed) {
    byKind.set(addon.manifest.kind, (byKind.get(addon.manifest.kind) ?? 0) + 1);
  }
  const installedSummary = [...byKind.entries()]
    .map(([kind, count]) => `${count} ${ADDON_KIND_LABELS[kind].toLowerCase()}${count === 1 ? '' : 's'}`)
    .join(' · ');

  const category = CATEGORIES.find(item => item.id === 'marketplace')!;

  return (
    <section data-testid="settings-marketplace">
      <CategoryHeader category={category} />
      <div className="settings-list">
        <FieldRow
          label="Enable the marketplace"
          description="When off, nothing is fetched and installed add-ons stay inactive."
        >
          <Toggle
            checked={status?.enabled ?? false}
            onChange={value => void toggleEnabled(value)}
            label={status?.enabled ? 'On' : 'Off'}
          />
        </FieldRow>

        <FieldRow
          label="Catalogue owner"
          description="The GitHub user or organisation that publishes the add-on packages."
        >
          <div className="settings-inline-controls">
            <input
              className="input"
              value={ownerDraft}
              placeholder="e.g. your-org"
              onChange={event => setOwnerDraft(event.target.value)}
              data-testid="marketplace-owner"
            />
            <select
              className="input"
              value={ownerTypeDraft}
              onChange={event => setOwnerTypeDraft(event.target.value === 'org' ? 'org' : 'user')}
              data-testid="marketplace-owner-type"
            >
              <option value="user">User</option>
              <option value="org">Organisation</option>
            </select>
          </div>
        </FieldRow>

        <FieldRow
          label="GitHub token"
          description={
            status?.hasToken
              ? 'A token is stored. Enter a new one to replace it, or clear it below.'
              : 'A personal access token with `read:packages`. Stored with OS-backed encryption.'
          }
        >
          <div className="settings-inline-controls">
            <input
              className="input"
              type="password"
              value={tokenDraft}
              placeholder={status?.hasToken ? '•••••••• (stored)' : 'ghp_…'}
              onChange={event => setTokenDraft(event.target.value)}
              data-testid="marketplace-token"
            />
            <button
              className="btn"
              type="button"
              disabled={busy === 'token' || tokenDraft.trim().length === 0}
              onClick={() => void saveToken()}
            >
              Save token
            </button>
            {status?.hasToken && (
              <button
                className="btn btn-quiet"
                type="button"
                disabled={busy === 'token'}
                onClick={() =>
                  void run('token', async () => {
                    await window.praxis.marketplace.setToken(null);
                    await refreshStatus();
                  })
                }
              >
                Clear
              </button>
            )}
          </div>
        </FieldRow>

        <div className="settings-field-row">
          <div className="settings-field-label">
            <button className="btn btn-quiet" type="button" onClick={() => setShowAdvanced(value => !value)}>
              {showAdvanced ? 'Hide' : 'Show'} advanced endpoints
            </button>
          </div>
        </div>
        {showAdvanced && (
          <>
            <FieldRow label="Package name prefix" description="Only packages whose name starts with this are treated as add-ons.">
              <input className="input" value={prefixDraft} onChange={event => setPrefixDraft(event.target.value)} />
            </FieldRow>
            <FieldRow label="GitHub API base URL" description="Override for GitHub Enterprise Server.">
              <input className="input" value={apiUrlDraft} onChange={event => setApiUrlDraft(event.target.value)} />
            </FieldRow>
            <FieldRow label="npm registry base URL" description="Where packuments and tarballs are fetched from.">
              <input className="input" value={registryUrlDraft} onChange={event => setRegistryUrlDraft(event.target.value)} />
            </FieldRow>
          </>
        )}

        <div className="settings-field-row">
          <div className="settings-field-control">
            <button className="btn" type="button" disabled={busy === 'config'} onClick={() => void saveConfig()} data-testid="marketplace-save">
              {busy === 'config' ? 'Saving…' : 'Save configuration'}
            </button>
          </div>
        </div>

        {error && <div className="error-banner" data-testid="marketplace-error">{error}</div>}
        <div className="settings-section-description" data-testid="marketplace-status">
          {status?.ready
            ? 'Marketplace is configured and ready. Browse and install add-ons from the Themes, Surfaces, and Agent Runtime panels.'
            : 'Set an owner, add a token, and enable the marketplace, then browse add-ons from the Themes, Surfaces, and Agent Runtime panels.'}
        </div>
        {installed.length > 0 && (
          <div className="settings-section-description">Installed: {installedSummary}.</div>
        )}

        <div className="settings-field-row">
          <div className="settings-field-label">
            <strong>Test connection</strong>
            <p>Fetch the real catalogue right now and count what's in it per kind, without leaving this page.</p>
          </div>
          <div className="settings-field-control">
            <button
              className="btn"
              type="button"
              disabled={busy === 'test' || !status?.ready}
              onClick={() => void testCatalog()}
              data-testid="marketplace-test"
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
        </div>
        {!status?.ready && (
          <div className="settings-field-help">Enable the marketplace with an owner and token first.</div>
        )}
        {testError && <div className="error-banner" data-testid="marketplace-test-error">{testError}</div>}
        {testCounts && (
          <div className="settings-section-description" data-testid="marketplace-test-results">
            {(Object.keys(ADDON_KIND_LABELS) as AddonKind[]).map((kind, index) => (
              <span key={kind}>
                {index > 0 && ' · '}
                {ADDON_KIND_LABELS[kind]}s: <strong>{testCounts[kind]}</strong>
              </span>
            ))}
            {' · '}Total: <strong>{Object.values(testCounts).reduce((sum, count) => sum + count, 0)}</strong>
          </div>
        )}
      </div>
    </section>
  );
}

function GadgetsSection() {
  return (
    <section data-testid="settings-gadgets">
      <CategoryHeader category={CATEGORIES.find(category => category.id === 'gadgets')!} />
      <div className="settings-list">
        <div className="settings-section-description">
          These browser-safe surfaces keep structured agent results readable and make decisions explicit. Tool completions are host-generated; the other gadgets are requested by an agent and validated by Praxis before rendering.
        </div>
        {BUILT_IN_GADGET_CATALOG.map(gadget => (
          <div className="settings-field-row" key={gadget.id} data-testid={`settings-gadget-${gadget.id}`}>
            <div className="settings-field-label">
              <strong className="settings-gadget-name">
                <Icon name={gadget.icon} size={14} />
                {gadget.name}
              </strong>
              <div className="settings-field-help">{gadget.purpose}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CategoryHeader({ category, children, actions }: { category: CategoryDef; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="settings-category-header">
      <div>
        <h3 className="settings-section-title">{category.label}</h3>
        <p className="settings-section-description">
          {category.description}
          {children}
        </p>
      </div>
      {actions && <div className="settings-category-actions">{actions}</div>}
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
  onReset,
  onResetAppearance,
  onClearProjectWorkspaceBoardData,
  clearingProjectWorkspaceBoardData
}: {
  settings: AppSettings;
  onReset: () => void;
  onResetAppearance: () => void;
  onClearProjectWorkspaceBoardData: () => void;
  clearingProjectWorkspaceBoardData: boolean;
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
      <div className="section-divider">
        <strong>Clear project data</strong>
        <div className="settings-field-help">
          Removes app-owned projects, workspaces, board layouts, and task canvases. Portable workspace files, connections, and credentials are kept.
        </div>
        <button
          className="btn danger"
          style={{ marginTop: 8 }}
          onClick={onClearProjectWorkspaceBoardData}
          disabled={clearingProjectWorkspaceBoardData}
          data-testid="clear-project-workspace-board-data"
        >
          {clearingProjectWorkspaceBoardData ? 'Clearing…' : 'Clear project/workspace/board data'}
        </button>
      </div>
      <div className="section-divider">
        <strong>Reset appearance</strong>
        <div className="settings-field-help">
          Restores the factory theme, built-in Looks, surface, motifs, priority colours, and appearance libraries.
        </div>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={onResetAppearance}
          data-testid="reset-appearance-factory"
        >
          Reset appearance to factory defaults
        </button>
      </div>
    </>
  );
}

function StartupSection({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const category = CATEGORIES.find(c => c.id === 'startup')!;
  return (
    <>
      <CategoryHeader category={category} />
      <Toggle
        label="Reopen last workspace"
        description="Restore the last valid workspace, project, board, ticket, AI session, and browser state. Turn this off to choose a workspace from Getting Started."
        checked={settings.startup.reopenLastWorkspace}
        testId="startup-reopen-last-workspace"
        onChange={next => void update({ startup: { reopenLastWorkspace: next } })}
      />
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
    id: 'gemini',
    kind: 'api',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    urlPlaceholder: 'https://generativelanguage.googleapis.com',
    modelPlaceholder: 'e.g. gemini-2.5-flash'
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
  },
  {
    id: 'antigravity-cli',
    kind: 'cli-agent',
    label: 'Antigravity',
    keyLabel: '',
    urlPlaceholder: '',
    modelPlaceholder: '',
    defaultCommand: 'agy',
    notInstalledHint: 'Not found on PATH — run "npm install -g agy" or install via system package manager.'
  }
];

/**
 * A group row's meta line: session count, cost per currency (only currencies
 * that actually reported — never a blended total, per `summariseSpend`), and
 * tokens if any session in the group reported those instead. A row can show
 * both when its sessions mix ACP and API providers.
 */
function spendGroupMeta(row: SpendGroupRow): string {
  const parts = [`${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`];
  const cost = row.costByCurrency
    .map(({ currency, amount }) => formatCost({ amount, currency }))
    .filter((value): value is string => Boolean(value));
  if (cost.length > 0) parts.push(cost.join(' + '));
  if (typeof row.totalTokens === 'number') parts.push(formatTokenCount(row.totalTokens));
  return parts.join(' · ');
}

function AiSection({
  settings,
  update,
  connections
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  connections: Connection[];
}) {
  const category = CATEGORIES.find(c => c.id === 'ai')!;
  const { confirm } = useDialogs();
  const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<AiProvider>(settings.ai.activeProvider);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [resettingKeys, setResettingKeys] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [managingModels, setManagingModels] = useState(false);
  const [spendSessions, setSpendSessions] = useState<AgentSessionRecord[]>([]);
  const [spendRangeDays, setSpendRangeDays] = useState<number | undefined>(undefined);

  const reloadStatuses = () => {
    window.praxis.ai
      .listProviderStatuses()
      .then(setStatuses)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reloadStatuses, []);

  // Self-contained, like `reloadStatuses` above — the Settings dialog has no
  // App-level session state threaded into it, so this section fetches and
  // stays live on its own rather than growing App's already large prop
  // surface for a section-local concern.
  useEffect(() => {
    let cancelled = false;
    window.praxis.ai
      .listSessions()
      .then(sessions => {
        if (!cancelled) setSpendSessions(sessions);
      })
      .catch(() => undefined);
    const unsubscribeChanged = window.praxis.ai.onSessionChanged(record => {
      setSpendSessions(current => [record, ...current.filter(session => session.issueKey !== record.issueKey)]);
    });
    const unsubscribeDeleted = window.praxis.ai.onSessionDeleted(issueKey => {
      setSpendSessions(current => current.filter(session => session.issueKey !== issueKey));
    });
    return () => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeDeleted();
    };
  }, []);

  const spendRangeSessions = sessionsWithinDays(spendSessions, spendRangeDays);
  const spendTotals = summariseSpend(spendRangeSessions);
  const spendByProviderModel = summariseSpendByProviderModel(spendRangeSessions);
  const spendByConnection = summariseSpendByConnection(spendRangeSessions, connections);
  const spendReportingCount = spendRangeSessions.filter(
    session => (session.cost && session.cost.amount > 0) || (session.tokenUsage?.totalTokens ?? 0) > 0
  ).length;
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
      await window.praxis.ai.setProviderApiKey(selectedProviderId, value);
      reloadStatuses();
      setKeyDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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

      <FieldRow
        label="Recommendations provider"
        description="Which provider lightweight AI recommendations (workflow template pick, workflow agent-for-stage pick) use. Auto prefers the active provider above when it's an API provider and configured, else the first configured API provider — CLI-hosted providers (Claude Code, Codex, Copilot) can't run these single-completion requests."
      >
        <select
          className="input"
          data-testid="ai-recommendation-provider-select"
          value={settings.ai.recommendationProvider ?? ''}
          onChange={event => {
            const value = event.target.value;
            void update({ ai: { recommendationProvider: value ? (value as AiProvider) : undefined } });
          }}
        >
          <option value="">Auto (first configured provider)</option>
          {AI_PROVIDERS.filter(meta => meta.kind === 'api').map(meta => (
            <option key={meta.id} value={meta.id}>
              {meta.label}
            </option>
          ))}
        </select>
      </FieldRow>

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
      <FieldRow
        label="Spend limit"
        description="A budget you set, warned against the cost your agent reports. 0 turns it off. This is not an account balance — no provider tells Praxis one, and only CLI agents (Claude Code, Codex) report cost at all."
      >
        <DebouncedNumberField
          ariaLabel="Spend limit"
          value={settings.ai.spendLimit}
          min={0}
          onCommit={value => update({ ai: { spendLimit: value } })}
        />
      </FieldRow>
      <div className="settings-section-block" data-testid="ai-spend-report">
        <div className="settings-section-subhead">
          <span>Spend report</span>
          <div className="chip-row" role="group" aria-label="Spend report time range">
            {(
              [
                { label: 'All time', days: undefined },
                { label: '30 days', days: 30 },
                { label: '7 days', days: 7 }
              ] as const
            ).map(range => (
              <button
                key={range.label}
                type="button"
                className={`chip${spendRangeDays === range.days ? ' filter-active' : ''}`}
                onClick={() => setSpendRangeDays(range.days)}
                data-testid={`ai-spend-range-${range.days ?? 'all'}`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
        {spendRangeSessions.length === 0 ? (
          <p className="settings-hint">No sessions in this range.</p>
        ) : (
          <>
            <div className="list-row is-static">
              <div>
                <div className="list-row-title">Total cost</div>
                <div className="list-row-meta" data-testid="ai-spend-total-cost">
                  {spendTotals.byCurrency.length === 0
                    ? 'No session in this range reported a cost.'
                    : spendTotals.byCurrency
                        .map(({ currency, amount }) => formatCost({ amount, currency }))
                        .filter((value): value is string => Boolean(value))
                        .join(' + ')}
                </div>
              </div>
            </div>
            <div className="list-row is-static">
              <div>
                <div className="list-row-title">Sessions reporting cost or tokens</div>
                <div className="list-row-meta">
                  {spendReportingCount} of {spendRangeSessions.length}
                </div>
              </div>
            </div>
            <div className="settings-section-subhead"><span>By provider &amp; model</span></div>
            {spendByProviderModel.map(row => (
              <div className="list-row is-static" key={row.label} data-testid="ai-spend-provider-row">
                <div>
                  <div className="list-row-title">{row.label}</div>
                  <div className="list-row-meta">{spendGroupMeta(row)}</div>
                </div>
              </div>
            ))}
            <div className="settings-section-subhead"><span>By connection</span></div>
            {spendByConnection.map(row => (
              <div className="list-row is-static" key={row.label} data-testid="ai-spend-connection-row">
                <div>
                  <div className="list-row-title">{row.label}</div>
                  <div className="list-row-meta">{spendGroupMeta(row)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <Toggle
        label="Let the AI use the in-app browser"
        description="Full-tools sessions get browser_navigate / browser_read / browser_click / browser_type against a browser docked in the session view. Each navigation to a new host asks first. Loopback and private-network addresses are always blocked."
        checked={settings.ai.browserTools.enabled}
        testId="ai-browser-tools-toggle"
        onChange={next => void update({ ai: { browserTools: { enabled: next } } })}
      />
      {settings.ai.browserTools.allowedHosts.length > 0 && (
        <FieldRow
          label="Allowed browser hosts"
          description="Hosts the agent may open without asking (added when you choose “Always allow”). Edit the settings file to remove one."
        >
          <div className="ai-allowed-hosts" data-testid="ai-browser-allowed-hosts">
            {settings.ai.browserTools.allowedHosts.map(host => (
              <span key={host} className="chip">{host}</span>
            ))}
          </div>
        </FieldRow>
      )}
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

const ADDON_THEME_FALLBACK_PREVIEW: ThemePreviewColors = {
  canvas: '#1c1c1c', panel: '#242424', raised: '#181818', border: '#3d3d3d',
  text: '#e4e4e4', muted: '#8a8a8a', accent: '#7c5cff',
  success: '#3fb950', warning: '#d29922', danger: '#f47067'
};

/** Builds a gallery-card shape for an uninstalled marketplace theme from its manifest display hints. */
function addonThemePreview(entry: CatalogEntry): ThemeDefinition {
  const hint = entry.manifest.display;
  return {
    id: entry.manifest.id,
    name: entry.manifest.name,
    family: 'Inspired palettes',
    section: 'Recent',
    source: 'marketplace',
    mode: hint?.mode ?? 'dark',
    description:
      entry.manifest.summary ??
      (entry.manifest.author ? `From ${entry.manifest.author}` : 'From your add-on catalogue') +
        (entry.incompatible ? ' — needs a newer Praxis' : ''),
    preview: { ...ADDON_THEME_FALLBACK_PREVIEW, ...(hint?.preview ?? {}) } as ThemePreviewColors
  };
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
        <PraxisPreviewScene />
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

function PraxisPreviewScene() {
  return (
    <>
      <span className="praxis-preview-titlebar">
        <span className="praxis-preview-window-dots"><i /><i /><i /></span>
        <span className="praxis-preview-brand"><b>P</b><strong>PRAXIS</strong></span>
        <span className="praxis-preview-titlebar-actions"><i /><i /></span>
      </span>
      <span className="praxis-preview-layout">
        <span className="praxis-preview-sidebar">
          <span className="praxis-preview-workspace"><b>W</b><strong>Workspace</strong><i /></span>
          <span className="praxis-preview-nav active"><b>◈</b><span>Overview</span></span>
          <span className="praxis-preview-nav"><b>▦</b><span>Projects</span></span>
          <span className="praxis-preview-nav"><b>◌</b><span>Sessions</span></span>
          <span className="praxis-preview-sidebar-rule" />
          <span className="praxis-preview-project"><i />Product launch</span>
        </span>
        <span className="praxis-preview-main">
          <span className="praxis-preview-breadcrumb">WORKSPACE <b>/</b> PRODUCT LAUNCH</span>
          <span className="praxis-preview-heading"><strong>Product board</strong><i>3 active</i></span>
          <span className="praxis-preview-toolbar"><i>All work</i><i>Assigned to me</i><b>＋</b></span>
          <span className="praxis-preview-board">
            <span className="praxis-preview-column"><strong>Todo</strong><i>2</i><b><em /><span>Prepare brief</span><small>PRX-24</small></b><b><em /><span>Map milestones</span><small>PRX-27</small></b></span>
            <span className="praxis-preview-column"><strong>Doing</strong><i>1</i><b><em /><span>Build workspace</span><small>PRX-22</small></b></span>
            <span className="praxis-preview-column"><strong>Done</strong><i>3</i><b><em /><span>Research</span><small>PRX-18</small></b></span>
          </span>
          <span className="praxis-preview-activity"><b /><span>AI session ready</span><i>●</i></span>
        </span>
      </span>
    </>
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
  pack, motif, disabled, animationsEnabled, onChange
}: {
  pack?: SurfacePackDefinition;
  motif?: SurfaceMotifSettings;
  disabled?: boolean;
  /** The master gate. False greys the motion controls and says why. */
  animationsEnabled: boolean;
  onChange: (motif: SurfaceMotifSettings | undefined) => void;
}) {
  const base = pack?.pattern;
  const effective: SurfacePatternSpec = {
    id: 'none', scale: 62, opacity: 0.3, ink: 'accent',
    placement: 'tile', anchor: 'top-right', spread: DEFAULT_MOTIF_SPREAD, fade: DEFAULT_MOTIF_FADE,
    fill: 0, outline: 0, animation: 'none', animationSpeed: 1, animationRepeat: false,
    ...(base ?? {}),
    ...(motif ?? {})
  };
  const set = (patch: Partial<SurfacePatternSpec>) =>
    onChange({ ...effective, ...patch } as SurfaceMotifSettings);
  const isCorner = effective.placement === 'corner';
  const overridden = motif !== undefined;
  const definition = findSurfacePattern(effective.id);
  const style = effective.animation ?? 'none';
  // Motion controls are dead while the master gate is off, the pattern is None,
  // or the panel itself is disabled — one condition, so they never disagree.
  const motionOff = Boolean(disabled) || !animationsEnabled || effective.id === 'none';
  const isReveal = isRevealAnimation(style);
  // The plural `anchors` supersedes the legacy single `anchor`; fall back to it,
  // then to the default corner, so a pack that only sets `anchor` still lights up.
  const corners: SurfacePatternAnchor[] = effective.anchors?.length
    ? effective.anchors
    : effective.anchor
      ? [effective.anchor]
      : ['top-right'];
  const toggleCorner = (value: SurfacePatternAnchor) => {
    const next = corners.includes(value)
      ? corners.filter(corner => corner !== value)
      : [...corners, value];
    // Always keep at least one corner lit — deselecting the last is a no-op.
    set({ anchors: next.length ? next : corners });
  };

  return (
    <section className={`surface-motif${disabled ? ' disabled' : ''}`} data-testid="motif-panel">
      <div className="surface-motif-head">
        <div>
          <strong>Motif</strong>
          <span>
            The mark laid on the material. Independent of the pack, so it rides over any theme.
            {!animationsEnabled && ' Motion is off — turn on Animate motifs below.'}
          </span>
        </div>
        {overridden && (
          <button type="button" className="surface-motif-reset" data-testid="motif-reset" onClick={() => onChange(undefined)}>
            Use surface default
          </button>
        )}
      </div>
      <div className="surface-dials surface-motif-dials">
        <label className="surface-dial"><span className="surface-dial-label">Pattern</span>
          <select value={effective.id} disabled={disabled} data-testid="motif-pattern"
            onChange={e => {
              // Adopt the incoming pattern's own line weight. The library spans
              // an order of magnitude — 0.012 for the Mandelbrot emblem against
              // 0.1 for weave — because a mark drawn once at the full spread
              // needs a far finer line than a lattice cell. Carrying the old
              // value across renders the new motif unusably heavy or invisible.
              const next = findSurfacePattern(e.target.value);
              set({ id: e.target.value, ...(next ? { weight: next.weight } : {}) });
            }}>
            {SURFACE_PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>

        <label className="surface-dial"><span className="surface-dial-label">Placement</span>
          <select value={effective.placement} disabled={disabled || effective.id === 'none'} data-testid="motif-placement"
            onChange={e => set({ placement: e.target.value as SurfacePatternPlacement })}>
            <option value="tile">Tile — repeats everywhere</option>
            <option value="corner">Corner — one fading mark</option>
          </select></label>

        {isCorner && (
          <div className="surface-dial surface-motif-corners-field">
            <span className="surface-dial-label">Corners <em>{corners.length} of 4</em></span>
            <div className="surface-motif-corners" role="group" aria-label="Motif corners" data-testid="motif-corners">
              {MOTIF_ANCHORS.map(([value, label]) => {
                const on = corners.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    className={`surface-corner${on ? ' on' : ''}`}
                    data-corner={value}
                    data-testid={`motif-corner-${value}`}
                    aria-pressed={on}
                    aria-label={label}
                    title={label}
                    disabled={disabled}
                    onClick={() => toggleCorner(value)}
                  >
                    <span className="surface-corner-dot" />
                  </button>
                );
              })}
            </div>
          </div>
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
            disabled={disabled || !definition?.fillable} data-testid="motif-fill"
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

        <label className="surface-dial"><span className="surface-dial-label">Animation</span>
          <select value={style} disabled={motionOff} data-testid="motif-animation"
            onChange={e => set({ animation: e.target.value as SurfaceMotifAnimation })}>
            {SURFACE_MOTIF_ANIMATIONS.map(entry => (
              <option
                key={entry.id}
                value={entry.id}
                // Plot walks a head along one continuous line, and only a
                // pattern that declares a route has one to walk.
                disabled={entry.id === 'plot' && !definition?.route}
              >{entry.name}</option>
            ))}
          </select></label>

        {style !== 'none' && (
          <label className="surface-dial">
            <span className="surface-dial-label">Speed <em>{(effective.animationSpeed ?? 1).toFixed(2)}×</em></span>
            <input type="range" min={25} max={400} step={5} value={Math.round((effective.animationSpeed ?? 1) * 100)}
              disabled={motionOff} data-testid="motif-speed"
              onChange={e => set({ animationSpeed: Number(e.target.value) / 100 })} /></label>
        )}

        {isReveal && (
          <label className="surface-dial surface-motif-repeat">
            <span className="surface-dial-label">Repeat</span>
            <span>
              <input type="checkbox" checked={effective.animationRepeat ?? false}
                disabled={motionOff} data-testid="motif-repeat"
                onChange={e => set({ animationRepeat: e.target.checked })} />
              <em>{effective.animationRepeat ? 'Loops' : 'Draws once, then rests complete'}</em>
            </span></label>
        )}

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

/** The look-scoped slice of the live appearance — everything a Look captures bar its id/name. */
function currentLookFields(settings: AppSettings): Omit<AppearanceLook, 'id' | 'name'> {
  const a = settings.appearance;
  return {
    themeId: a.themeId,
    themeMode: a.themeMode,
    surfacePackId: a.surfacePackId,
    surface: a.surface,
    priorityColors: a.priorityColors,
    showBrandArtwork: a.showBrandArtwork
  };
}

/** Merge incoming library records into the profile's, keeping the profile's copy on an id clash. */
function mergeById<T extends { id: string }>(existing: T[], incoming: unknown[]): T[] {
  const seen = new Set(existing.map(item => item.id));
  const extra = incoming.filter(
    (item): item is T => Boolean(item) && typeof (item as T).id === 'string' && !seen.has((item as T).id)
  );
  return [...existing, ...extra];
}

/** Neutral palette used when a Look references a custom theme that has since been deleted. */
const FALLBACK_LOOK_PREVIEW: ThemePreviewColors = {
  canvas: '#1c1c1c', panel: '#242424', raised: '#161616', border: '#3d3d3d',
  text: '#e4e4e4', muted: '#8a8a8a', accent: '#7c5cff',
  success: '#3fb950', warning: '#d29922', danger: '#f47067'
};

const LOOK_IDS = new Set(BUILT_IN_LOOKS.map(look => look.id));

/**
 * The surface material a Look card should paint over its palette mock. Renders
 * the Look's pack pattern (with any motif override) from the shared library —
 * tinted for *that Look's* theme, not the live one — shrunk and lifted so it
 * reads at thumbnail size. Returns `undefined` for Flat / a pattern-less pack.
 */
function lookSurfacePreview(
  look: AppearanceLook,
  themePreview: ThemePreviewColors
): { image?: string; size?: string; opacity: number; blend: string; glass: boolean } | undefined {
  const pack = allSurfacePacks().find(entry => entry.id === look.surfacePackId);
  const motif = look.surface.motif;
  const base = pack?.pattern;
  const spec = motif && Object.keys(motif).length
    ? { ...(base ?? { id: 'none', scale: 96, opacity: 0.08 }), ...motif }
    : base;
  const glass = Boolean(pack?.glass);
  if (!spec || spec.id === 'none' || (spec.opacity ?? 0) <= 0) {
    return glass ? { opacity: 0, blend: 'normal', glass } : undefined;
  }
  const ink = spec.ink === 'text'
    ? themePreview.text
    : spec.ink === 'custom' && spec.inkColor
      ? spec.inkColor
      : themePreview.accent;
  const resolved = resolveSurfacePattern(
    {
      ...spec,
      placement: 'tile',
      scale: Math.max(13, (spec.scale ?? 96) * 0.46),
      opacity: Math.min(
        0.34,
        (spec.opacity ?? 0.1) * 2.6 * perceptualOpacityScale(ink, themePreview.panel)
      )
    },
    ink
  );
  if (!resolved) {
    return glass ? { opacity: 0, blend: 'normal', glass } : undefined;
  }
  return { image: resolved.image, size: resolved.size, opacity: Number(resolved.opacity), blend: resolved.blend, glass };
}

/**
 * A Look card — the theme gallery's app-chrome mock painted in the Look's
 * palette, with its surface material layered over it, so theme + colours +
 * surface all read at a glance. Hover reveals rename / duplicate / export /
 * delete.
 */
function LookPreviewCard({
  look, active, packName, canDelete, renaming,
  onApply, onStartRename, onCommitRename, onCancelRename, onDuplicate, onExport, onDelete
}: {
  look: AppearanceLook;
  active: boolean;
  packName: string;
  canDelete: boolean;
  renaming: { value: string; set: (value: string) => void } | undefined;
  onApply: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const themePreview = allThemes().find(theme => theme.id === look.themeId)?.preview ?? FALLBACK_LOOK_PREVIEW;
  const previewStyle = {
    '--preview-canvas': themePreview.canvas,
    '--preview-panel': themePreview.panel,
    '--preview-raised': themePreview.raised,
    '--preview-border': themePreview.border,
    '--preview-text': themePreview.text,
    '--preview-muted': themePreview.muted,
    '--preview-accent': themePreview.accent,
    '--preview-success': themePreview.success,
    '--preview-warning': themePreview.warning,
    '--preview-danger': themePreview.danger
  } as CSSProperties;
  const surface = lookSurfacePreview(look, themePreview);

  return (
    <div
      className={`theme-gallery-card look-card${active ? ' active' : ''}`}
      style={previewStyle}
      data-testid={`look-card-${look.id}`}
    >
      <button
        type="button"
        className="look-card-apply"
        aria-pressed={active}
        aria-label={`Apply the ${look.name} Look`}
        onClick={onApply}
      >
        <span className="theme-card-preview" aria-hidden="true">
          <PraxisPreviewScene />
          {surface?.image && (
            <span
              className="look-card-surface"
              style={{
                backgroundImage: surface.image,
                backgroundSize: surface.size,
                opacity: surface.opacity,
                mixBlendMode: surface.blend as CSSProperties['mixBlendMode']
              }}
            />
          )}
          {surface?.glass && <span className="look-card-glass" />}
        </span>
      </button>
      <div className="theme-card-meta">
        <span>
          {renaming ? (
            <input
              autoFocus
              className="look-card-rename"
              value={renaming.value}
              maxLength={80}
              aria-label={`Rename ${look.name}`}
              onChange={event => renaming.set(event.target.value)}
              onBlur={onCommitRename}
              onKeyDown={event => {
                if (event.key === 'Enter') onCommitRename();
                if (event.key === 'Escape') onCancelRename();
              }}
            />
          ) : (
            <strong>{look.name}</strong>
          )}
          <small>{packName}</small>
        </span>
        {active && <span className="theme-card-active">Active</span>}
      </div>
      <div className="look-card-actions">
        {!LOOK_IDS.has(look.id) && <button type="button" title="Rename" aria-label={`Rename ${look.name}`} data-testid={`look-rename-${look.id}`} onClick={onStartRename}>✎</button>}
        <button type="button" title="Duplicate" aria-label={`Duplicate ${look.name}`} onClick={onDuplicate}>⧉</button>
        <button type="button" title="Export" aria-label={`Export ${look.name}`} onClick={onExport}>↧</button>
        {!LOOK_IDS.has(look.id) && <button type="button" title="Delete" aria-label={`Delete ${look.name}`} className="danger" disabled={!canDelete} data-testid={`look-delete-${look.id}`} onClick={onDelete}>✕</button>}
      </div>
    </div>
  );
}

/**
 * The Looks gallery — switchable presets that bundle the whole appearance stack
 * (theme, mode, surface pack, dials/motif, priority colours, brand artwork),
 * grouped into Built in / Custom exactly like the theme gallery. Selecting a
 * Look applies it in one shot; while a Look is selected every edit anywhere in
 * Appearance is folded back into it by core's `mirrorActiveLook`, so this only
 * handles select / save / rename / duplicate / delete / export / import.
 */
function LooksStrip({
  settings,
  update
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
}) {
  const looks = settings.appearance.looks;
  const activeLookId = settings.appearance.activeLookId;
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const applyLook = (look: AppearanceLook) => {
    applyThemePreference(look.themeId, look.themeMode as ThemeModePreference);
    applySurfacePack(look.surfacePackId, {
      intensity: look.surface.intensity,
      texture: look.surface.texture,
      translucency: look.surface.translucency,
      windowVibrancy: look.surface.windowVibrancy,
      animateMotifs: look.surface.animateMotifs,
      motif: look.surface.motif
    });
    void update({
      appearance: {
        themeId: look.themeId,
        themeMode: look.themeMode,
        surfacePackId: look.surfacePackId,
        surface: look.surface,
        priorityColors: look.priorityColors,
        showBrandArtwork: look.showBrandArtwork,
        activeLookId: look.id
      }
    });
  };

  const saveCurrent = () => {
    const name = draftName.trim();
    if (!name) return;
    const look: AppearanceLook = { id: `look-${Date.now().toString(36)}`, name, ...currentLookFields(settings) };
    void update({ appearance: { looks: [...looks, look], activeLookId: look.id } });
    setNaming(false);
    setDraftName('');
  };

  const commitRename = (id: string) => {
    const name = renameDraft.trim();
    setRenamingId(undefined);
    if (!name) return;
    void update({ appearance: { looks: looks.map(look => (look.id === id ? { ...look, name } : look)) } });
  };

  const duplicate = (look: AppearanceLook) => {
    const copy: AppearanceLook = { ...look, id: `look-${Date.now().toString(36)}`, name: `${look.name} copy` };
    void update({ appearance: { looks: [...looks, copy] } });
  };

  const remove = (id: string) => {
    void update({
      appearance: {
        looks: looks.filter(look => look.id !== id),
        ...(activeLookId === id ? { activeLookId: '' } : {})
      }
    });
  };

  const exportLook = (look: AppearanceLook) => {
    const customThemes = (settings.appearance.customThemes ?? []).filter(theme => theme.id === look.themeId);
    const customSurfacePacks = (settings.appearance.customSurfacePacks ?? []).filter(pack => pack.id === look.surfacePackId);
    const blob = new Blob([JSON.stringify({ look, customThemes, customSurfacePacks }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${look.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'look'}.look.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importLook = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        look?: Partial<AppearanceLook>;
        customThemes?: unknown[];
        customSurfacePacks?: unknown[];
      };
      const raw = parsed.look;
      if (!raw || typeof raw.themeId !== 'string' || typeof raw.surfacePackId !== 'string') {
        throw new Error('Not a Look file');
      }
      const nextThemes = mergeById(
        settings.appearance.customThemes ?? [],
        Array.isArray(parsed.customThemes) ? parsed.customThemes : []
      );
      const nextPacks = mergeById(
        settings.appearance.customSurfacePacks ?? [],
        Array.isArray(parsed.customSurfacePacks) ? parsed.customSurfacePacks : []
      );
      const look: AppearanceLook = {
        id: `look-${Date.now().toString(36)}`,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Imported look',
        themeId: raw.themeId,
        themeMode: raw.themeMode === 'light' || raw.themeMode === 'system' ? raw.themeMode : 'dark',
        surfacePackId: raw.surfacePackId,
        surface:
          raw.surface && typeof raw.surface === 'object'
            ? (raw.surface as AppearanceLook['surface'])
            : settings.appearance.surface,
        priorityColors:
          raw.priorityColors && typeof raw.priorityColors === 'object'
            ? (raw.priorityColors as Record<string, string>)
            : settings.appearance.priorityColors,
        showBrandArtwork: typeof raw.showBrandArtwork === 'boolean' ? raw.showBrandArtwork : true
      };
      registerCustomThemes(nextThemes);
      registerCustomSurfacePacks(nextPacks);
      // The settings backend re-sanitises this write, so a hand-edited file can
      // only ever land a well-formed Look / library record.
      await update({ appearance: { customThemes: nextThemes, customSurfacePacks: nextPacks, looks: [...looks, look] } });
      applyLook(look);
    } catch {
      /* A malformed file is ignored without disturbing the current Looks. */
    }
  };

  const builtInLooks = looks.filter(look => LOOK_IDS.has(look.id));
  const customLooks = looks.filter(look => !LOOK_IDS.has(look.id));
  const packNameOf = (look: AppearanceLook) =>
    allSurfacePacks().find(pack => pack.id === look.surfacePackId)?.name ?? look.surfacePackId;

  const renderCard = (look: AppearanceLook) => (
    <LookPreviewCard
      key={look.id}
      look={look}
      active={look.id === activeLookId}
      packName={packNameOf(look)}
      canDelete={!LOOK_IDS.has(look.id) && looks.length > 1}
      renaming={!LOOK_IDS.has(look.id) && renamingId === look.id ? { value: renameDraft, set: setRenameDraft } : undefined}
      onApply={() => applyLook(look)}
      onStartRename={() => { if (!LOOK_IDS.has(look.id)) { setRenamingId(look.id); setRenameDraft(look.name); } }}
      onCommitRename={() => commitRename(look.id)}
      onCancelRename={() => setRenamingId(undefined)}
      onDuplicate={() => duplicate(look)}
      onExport={() => exportLook(look)}
      onDelete={() => { if (!LOOK_IDS.has(look.id)) remove(look.id); }}
    />
  );

  return (
    <section className="looks-strip" data-testid="looks-strip">
      <div className="looks-gallery-toolbar">
        {naming ? (
          <span className="looks-name-field">
            <input
              autoFocus
              value={draftName}
              maxLength={80}
              placeholder="Look name"
              aria-label="New Look name"
              data-testid="look-name-input"
              onChange={event => setDraftName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') saveCurrent();
                if (event.key === 'Escape') {
                  setNaming(false);
                  setDraftName('');
                }
              }}
            />
            <button type="button" className="primary" disabled={!draftName.trim()} onClick={saveCurrent} data-testid="look-save-confirm">
              Save
            </button>
            <button type="button" onClick={() => { setNaming(false); setDraftName(''); }}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="btn btn-secondary" data-testid="look-save" onClick={() => setNaming(true)}>
            ＋ Save current as Look
          </button>
        )}
        <label className="btn btn-secondary">
          Import Look
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importLook(event)} />
        </label>
        <span>
          {activeLookId
            ? 'Editing any appearance setting updates the selected Look.'
            : 'Pick a Look to apply it everywhere.'}
        </span>
      </div>

      <section className="theme-gallery-section">
        <h4>Built in</h4>
        <div className="theme-gallery-grid">{builtInLooks.map(renderCard)}</div>
      </section>

      {customLooks.length > 0 && (
        <section className="theme-gallery-section">
          <h4>Custom</h4>
          <div className="theme-gallery-grid">{customLooks.map(renderCard)}</div>
        </section>
      )}
    </section>
  );
}

function ThemesGallerySection({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const category = CATEGORIES.find(c => c.id === 'appearance-themes')!;
  const [selectedTheme, setSelectedTheme] = useState(() => settings.appearance.themeId || getInitialThemeId());
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ThemeDefinition & { source: 'custom' }>();
  const [, refreshCustomThemes] = useState(0);
  const [marketplaceFilter, setMarketplaceFilter] = useState<'all' | 'installed'>('all');
  const installedIds = settings.appearance.installedThemeIds ?? [];
  const custom = settings.appearance.customThemes ?? [];

  // The add-on marketplace, scoped to themes. Auto-browses once configured so
  // the Marketplace section fills in without an extra click.
  const themeAddons = useKindAddons('theme');
  useEffect(() => {
    if (themeAddons.ready && themeAddons.catalog === undefined && !themeAddons.busy) {
      void themeAddons.browse();
    }
  }, [themeAddons.ready, themeAddons.catalog, themeAddons.busy, themeAddons.browse]);
  useEffect(() => {
    const bump = () => refreshCustomThemes(value => value + 1);
    window.addEventListener('praxis-marketplace-appearance', bump);
    return () => window.removeEventListener('praxis-marketplace-appearance', bump);
  }, []);
  const installedAddonThemeIds = new Set(themeAddons.installed.map(addon => addon.manifest.id));

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
    const fallback = selectedTheme === editing.id ? DEFAULT_THEME_ID : selectedTheme;
    await update({ appearance: { customThemes: next, installedThemeIds: installedIds.filter(id => id !== editing.id), ...(selectedTheme === editing.id ? { themeId: fallback, themeMode: 'light' } : {}) } });
    registerCustomThemes(next);
    if (selectedTheme === editing.id) { setSelectedTheme(fallback); applyThemePreference(fallback, 'light'); }
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
      <CategoryHeader
        category={category}
        actions={
          <>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Create custom theme" title="Create custom theme" data-testid="theme-create-custom" onClick={createCustom}>
              <Icon name="plus" size={14} />
            </button>
            <label className="icon-btn icon-btn-sm" aria-label="Import theme" title="Import theme" data-testid="theme-import">
              <Icon name="folder-open" size={14} />
              <input type="file" accept="application/json,.json" hidden onChange={event => void importCustom(event)} />
            </label>
          </>
        }
      />
      <p className="theme-gallery-helper">Design your own palette with a live preview.</p>
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
        const sectionThemes = visible.filter(theme => theme.section === section && (!theme.source || installedIds.includes(theme.id) || installedAddonThemeIds.has(theme.id)));
        if (sectionThemes.length === 0) return null;
        return (
          <section className="theme-gallery-section" key={section}>
            <h4>{section}</h4>
            <div className="theme-gallery-grid">
              {sectionThemes.map(theme => (
                <ThemePreviewCard key={theme.id} theme={theme} installed={theme.source !== 'marketplace' || installedIds.includes(theme.id) || installedAddonThemeIds.has(theme.id)} active={selectedTheme === theme.id} onSelect={() => {
                  setSelectedTheme(theme.id);
                  applyThemePreference(theme.id, theme.mode);
                  void update({ appearance: { themeId: theme.id, themeMode: theme.mode } });
                }} onEdit={theme.source === 'custom' ? () => setEditing(theme as ThemeDefinition & { source: 'custom' }) : undefined} />
              ))}
            </div>
          </section>
        );
      })}
      {(() => {
        const bundled = visible.filter(
          theme =>
            theme.source === 'marketplace'
        );
        const needle = query.trim().toLowerCase();
        const fromCatalogue = (themeAddons.catalog ?? []).filter(
          entry =>
            !needle ||
            `${entry.manifest.name} ${entry.manifest.summary ?? ''} ${entry.manifest.author ?? ''}`
              .toLowerCase()
              .includes(needle)
        );

        const availableBundled = bundled.filter(
          theme => !installedIds.includes(theme.id) && !installedAddonThemeIds.has(theme.id)
        );
        const availableCatalogue = fromCatalogue.filter(
          entry => !installedAddonThemeIds.has(entry.manifest.id)
        );
        // Installing a bundled marketplace card only flips `installedThemeIds` (see
        // onInstall below) — it never calls the real add-on API, so these never land in
        // `themeAddons.installed`. Excluded from totalInstalled, they used to vanish from
        // the total entirely once installed, hiding this whole section (`total === 0`)
        // even though every marketplace theme was in active use. `!installedAddonThemeIds`
        // avoids double-counting a bundled id that also happens to be a real install.
        const installedBundled = bundled.filter(
          theme => installedIds.includes(theme.id) && !installedAddonThemeIds.has(theme.id)
        );

        const totalAvailable = availableBundled.length + availableCatalogue.length;
        const totalInstalled = installedBundled.length + themeAddons.installed.length;
        const total = totalAvailable + totalInstalled;

        const removeBundledTheme = (theme: ThemeDefinition) => {
          const nextIds = installedIds.filter(id => id !== theme.id);
          const fallbackActive = selectedTheme === theme.id;
          void update({
            appearance: {
              installedThemeIds: nextIds,
              ...(fallbackActive ? { themeId: DEFAULT_THEME_ID, themeMode: 'light' } : {})
            }
          }).then(() => {
            if (fallbackActive) {
              setSelectedTheme(DEFAULT_THEME_ID);
              applyThemePreference(DEFAULT_THEME_ID, 'light');
            }
          });
        };

        if (total === 0 && themeAddons.ready && themeAddons.catalog !== undefined) {
          return null;
        }
        return (
          <section className="theme-gallery-section theme-marketplace-section" data-testid="theme-marketplace">
            <div className="theme-marketplace-heading">
              <div>
                <h4>Marketplace</h4>
                <p>Install curated and community palettes into this workspace.</p>
              </div>
              {total > 0 && (
                <div className="theme-marketplace-filter">
                  <span className="theme-marketplace-count">
                    {marketplaceFilter === 'all' ? totalAvailable : totalInstalled} {marketplaceFilter === 'all' ? 'available' : 'installed'}
                  </span>
                  <div className="filter-toggle" role="group" aria-label="Marketplace filter">
                    <button
                      type="button"
                      className={marketplaceFilter === 'all' ? 'active' : ''}
                      onClick={() => setMarketplaceFilter('all')}
                      data-testid="theme-marketplace-filter-all"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={marketplaceFilter === 'installed' ? 'active' : ''}
                      onClick={() => setMarketplaceFilter('installed')}
                      disabled={totalInstalled === 0}
                      data-testid="theme-marketplace-filter-installed"
                    >
                      Installed {totalInstalled > 0 && `(${totalInstalled})`}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {themeAddons.error && <div className="error-banner">{themeAddons.error}</div>}
            {!themeAddons.ready && (
              <p className="settings-field-help">
                Set up the add-on catalogue in Settings › Add-ons to install themes from GitHub Packages.
              </p>
            )}
            {themeAddons.ready && themeAddons.catalog === undefined && (
              <p className="settings-field-help">Loading the catalogue…</p>
            )}
            {marketplaceFilter === 'all' && (
              // A marketplace card stays here once installed — it doesn't move away to
              // Recent/Staff picks and disappear from this grid. Browsing the catalogue
              // should always show the full catalogue, installed state included.
              <div className="theme-gallery-grid">
                {bundled.map(theme => {
                  const isInstalled = installedIds.includes(theme.id) || installedAddonThemeIds.has(theme.id);
                  return (
                    <ThemePreviewCard
                      key={theme.id}
                      theme={theme}
                      active={selectedTheme === theme.id}
                      installed={isInstalled}
                      onSelect={() => {
                        setSelectedTheme(theme.id);
                        applyThemePreference(theme.id, theme.mode);
                        void update({ appearance: { themeId: theme.id, themeMode: theme.mode } });
                      }}
                      onInstall={
                        isInstalled
                          ? undefined
                          : () =>
                              void update({
                                appearance: {
                                  installedThemeIds: [...installedIds, theme.id],
                                  themeId: theme.id,
                                  themeMode: theme.mode
                                }
                              }).then(() => {
                                setSelectedTheme(theme.id);
                                applyThemePreference(theme.id, theme.mode);
                              })
                      }
                    />
                  );
                })}
                {fromCatalogue.map(entry => {
                  const isInstalled = installedAddonThemeIds.has(entry.manifest.id);
                  const previewTheme = addonThemePreview(entry);
                  return (
                    <ThemePreviewCard
                      key={entry.packageName}
                      theme={previewTheme}
                      active={selectedTheme === entry.manifest.id}
                      installed={isInstalled}
                      onSelect={() => {
                        setSelectedTheme(entry.manifest.id);
                        applyThemePreference(entry.manifest.id, previewTheme.mode);
                        void update({ appearance: { themeId: entry.manifest.id, themeMode: previewTheme.mode } });
                      }}
                      onInstall={
                        isInstalled || entry.incompatible
                          ? undefined
                          : () => void themeAddons.install(entry.packageName)
                      }
                    />
                  );
                })}
              </div>
            )}
            {marketplaceFilter === 'installed' && (installedBundled.length > 0 || themeAddons.installed.length > 0) && (
              <div className="theme-marketplace-installed-list">
                {installedBundled.map((theme, index) => (
                  <div key={theme.id} className="theme-marketplace-installed-item" data-testid="theme-marketplace-installed-item">
                    {index > 0 && ' · '}
                    <span>{theme.name}</span>
                    <button type="button" className="linklike" onClick={() => removeBundledTheme(theme)}>
                      Remove
                    </button>
                  </div>
                ))}
                {themeAddons.installed.map((addon, index) => (
                  <div key={addon.manifest.id} className="theme-marketplace-installed-item" data-testid="theme-marketplace-installed-item">
                    {(installedBundled.length > 0 || index > 0) && ' · '}
                    <span>{addon.manifest.name}</span>
                    <button
                      type="button"
                      className="linklike"
                      disabled={themeAddons.busy === `remove:${addon.manifest.id}`}
                      onClick={() => void themeAddons.remove(addon.manifest.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })()}
      {visible.length === 0 && <div className="placeholder-text">No themes match “{query}”.</div>}
    </>
  );
}

function LooksSection({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const category = CATEGORIES.find(c => c.id === 'appearance-looks')!;
  return (
    <>
      <CategoryHeader category={category} />
      <LooksStrip settings={settings} update={update} />
    </>
  );
}

function SurfacesSection({ settings, update }: { settings: AppSettings; update: (patch: AppSettingsPatch) => Promise<void> }) {
  const category = CATEGORIES.find(c => c.id === 'appearance-surfaces')!;
  const surfaceId = settings.appearance.surfacePackId;
  const surfaceOpts = settings.appearance.surface;
  const customSurfacePacks = settings.appearance.customSurfacePacks ?? [];
  const applySurface = (id: string, opts: typeof surfaceOpts) =>
    applySurfacePack(id, {
      intensity: opts.intensity,
      texture: opts.texture,
      translucency: opts.translucency,
      windowVibrancy: opts.windowVibrancy,
      animateMotifs: opts.animateMotifs,
      motif: opts.motif
    });
  const selectSurface = (id: string) => {
    // Selecting a material starts from that material's own motif. A motif is
    // still independently customisable afterwards; clearing the override here
    // is what makes the surface cards behave like complete presets.
    const nextOpts = { ...surfaceOpts, motif: undefined };
    applySurface(id, nextOpts);
    void update({ appearance: { surfacePackId: id, surface: { motif: undefined } } });
  };
  const currentMode = ((document.documentElement.getAttribute('data-mode') as SurfaceMode | null) ?? 'dark');
  const visibleSurfacePacks = allSurfacePacks().filter(pack => pack.supports.includes(currentMode));
  const activeSurfacePack = allSurfacePacks().find(pack => pack.id === surfaceId);
  const [editingSurface, setEditingSurface] = useState<CustomSurfacePack>();
  const [vibrancySupported, setVibrancySupported] = useState(false);
  const [, bumpPacks] = useState(0);
  useEffect(() => {
    void window.praxis.window.supportsVibrancy?.().then(setVibrancySupported).catch(() => setVibrancySupported(false));
  }, []);
  useEffect(() => {
    registerCustomSurfacePacks(customSurfacePacks);
  }, [customSurfacePacks]);

  // The add-on marketplace, scoped to surface packs.
  const packAddons = useKindAddons('surface-pack');
  useEffect(() => {
    if (packAddons.ready && packAddons.catalog === undefined && !packAddons.busy) {
      void packAddons.browse();
    }
  }, [packAddons.ready, packAddons.catalog, packAddons.busy, packAddons.browse]);
  useEffect(() => {
    const bump = () => bumpPacks(value => value + 1);
    window.addEventListener('praxis-marketplace-appearance', bump);
    return () => window.removeEventListener('praxis-marketplace-appearance', bump);
  }, []);
  const installedAddonPackIds = new Set(packAddons.installed.map(addon => addon.manifest.id));

  const persistSurfacePacks = (packs: CustomSurfacePack[], nextActiveId?: string) => {
    registerCustomSurfacePacks(packs);
    if (nextActiveId) {
      applySurface(nextActiveId, { ...surfaceOpts, motif: undefined });
    }
    return update({ appearance: {
      customSurfacePacks: packs,
      ...(nextActiveId ? { surfacePackId: nextActiveId, surface: { motif: undefined } } : {})
    } });
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

  return (
    <>
      <CategoryHeader category={category} />
      <section className="theme-gallery-section surface-section" data-testid="surface-section">
        <div className="theme-gallery-grid surface-pack-grid">
          {visibleSurfacePacks.map(pack => (
            <div className="surface-pack-card-wrap" key={pack.id}>
              <SurfacePackCard
                pack={pack}
                active={surfaceId === pack.id}
                onSelect={() => selectSurface(pack.id)}
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
              {pack.source === 'marketplace' && installedAddonPackIds.has(pack.id) && (
                <button
                  type="button"
                  className="surface-pack-edit"
                  aria-label={`Remove ${pack.name}`}
                  data-testid={`surface-remove-${pack.id}`}
                  onClick={() => void packAddons.remove(pack.id)}
                >Remove</button>
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
        <div className="theme-marketplace-heading" data-testid="surface-marketplace">
          <div>
            <h4>Marketplace</h4>
            <p>Install material packs from your add-on catalogue.</p>
          </div>
          {(packAddons.catalog?.filter(entry => !installedAddonPackIds.has(entry.manifest.id)).length ?? 0) > 0 && (
            <span className="theme-marketplace-count">
              {packAddons.catalog!.filter(entry => !installedAddonPackIds.has(entry.manifest.id)).length} available
            </span>
          )}
        </div>
        {packAddons.error && <div className="error-banner">{packAddons.error}</div>}
        {!packAddons.ready && (
          <p className="settings-field-help">Set up the add-on catalogue in Settings › Add-ons to install surface packs.</p>
        )}
        {packAddons.ready && packAddons.catalog === undefined && <p className="settings-field-help">Loading the catalogue…</p>}
        {packAddons.ready && packAddons.catalog?.filter(entry => !installedAddonPackIds.has(entry.manifest.id)).length === 0 && (
          <p className="settings-field-help">No new surface packs in the catalogue.</p>
        )}
        <div className="surface-marketplace-grid">
          {(packAddons.catalog ?? [])
            .filter(entry => !installedAddonPackIds.has(entry.manifest.id))
            .map(entry => (
              <div className="surface-marketplace-card" key={entry.packageName} data-testid={`surface-marketplace-${entry.manifest.id}`}>
                {entry.manifest.display?.preview && (
                  <span className="surface-marketplace-swatch" aria-hidden="true">
                    {['canvas', 'panel', 'accent', 'text'].map(token => (
                      <i key={token} style={{ background: entry.manifest.display!.preview![token] ?? 'transparent' }} />
                    ))}
                  </span>
                )}
                <span className="surface-marketplace-meta">
                  <strong>{entry.manifest.name}</strong>
                  <small>
                    v{entry.latestVersion}
                    {entry.manifest.author ? ` · ${entry.manifest.author}` : ''}
                    {entry.manifest.summary ? ` — ${entry.manifest.summary}` : ''}
                    {entry.incompatible ? ' · needs a newer Praxis' : ''}
                  </small>
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={entry.incompatible || packAddons.busy === `install:${entry.packageName}`}
                  onClick={() => void packAddons.install(entry.packageName)}
                >
                  Install
                </button>
              </div>
            ))}
        </div>
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
          animationsEnabled={surfaceOpts.animateMotifs}
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
          label="Animate motifs"
          description="Let the motif move — draw itself, shimmer, glow, and the rest. The style is chosen per motif below. Always off when the OS asks for reduced motion."
          checked={surfaceOpts.animateMotifs}
          testId="surface-animate-toggle"
          onChange={next => {
            const updated = { ...surfaceOpts, animateMotifs: next };
            applySurface(surfaceId, updated);
            void update({ appearance: { surface: { animateMotifs: next } } });
          }}
        />
        <Toggle
          label="Plain chat background"
          description="Drop the surface material behind the AI session view — its list and console — so long transcripts stay legible. The colour theme still applies. Each session can override this from its header."
          checked={surfaceOpts.plainChatSurface}
          testId="surface-plain-chat-toggle"
          onChange={next => {
            void update({ appearance: { surface: { plainChatSurface: next } } });
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
    void window.praxis.terminal.listProfiles().then(next => {
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
