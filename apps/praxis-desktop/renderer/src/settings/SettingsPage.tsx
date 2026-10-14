import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { useResizable } from '../app/useResizable';
import { useUpdateStatus } from '../app/useUpdateStatus';
import { useDialogs } from '../ui/dialogs';
import { QrCodeSvg } from '../ui/qrCodeSvg';
import type {
  AddonManifest,
  AiProvider,
  AiProviderStatus,
  AgentRuntimeSnapshot,
  AgentSessionRecord,
  AddonKind,
  AddonUpdate,
  AppSettings,
  AppSettingsPatch,
  MobileCapability,
  MobilePairingInvitation,
  MobilePairingSnapshot,
  AppearanceLook,
  CatalogEntry,
  InstalledAddon,
  MarketplaceStatus,
  ModelChoice,
  SurfaceMotifSettings,
  BoardsSidebarMode,
  Connection,
  CustomProviderConfig,
  ProviderPreset,
  UpdateStatus
} from '@praxis/core';
import {
  BUILT_IN_LOOKS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_WORKING_STYLE,
  normalizePriorityColor,
  PRIORITY_NAMES
} from './settingsDefaults';
import { Icon, type IconName } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import { ModelManagerPanel } from '../ai/ModelManagerPanel';
import { AiUsageStatsSection } from './AiUsageStatsSection';
import { fetchModelOptions, hasModelCatalog, providerIconName } from '../ai/modelProviders';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';
import { AddProviderDialog, CustomEndpointForm, endpointDisplayUrl, type BuiltInCatalogEntry } from './AiProviderCatalog';
import { RemoveProviderDialog } from './RemoveProviderDialog';
import { McpServersPanel } from './McpServersPanel';
import { CodeIntelligencePanel } from './CodeIntelligencePanel';
import { useSettings } from './useSettings';
import { useKindAddons } from './marketplaceAddons';
import { isHostShimProfile, NATIVE_TOOL_LABELS, nativeReaders, nativeSourceLabel, skillTitle } from '../agents/agentCatalog';
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
  | 'updates'
  | 'connections'
  | 'mobile'
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
  children: ['startup', 'updates', 'appearance']
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
  children: ['connections', 'mobile', 'marketplace', 'jira', 'terminal', 'performance', 'preview']
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
    id: 'updates',
    label: 'Updates',
    icon: 'refresh',
    description: 'Praxis checks GitHub Releases for new versions, downloads them in the background, and installs them when you restart.'
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
    id: 'mobile',
    label: 'Mobile access',
    icon: 'server',
    description: 'Control which phones may connect to this desktop and copy its encrypted connection details.'
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
    label: 'AI Usage & Spend',
    icon: 'graph',
    description: 'Token and cost usage across sessions and features, budget limits, and connection breakdowns.'
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
    description: 'Agents are the roles a session can take on; skills are procedures an agent can load; runtimes are the local AI programs that run them.'
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
    label: 'Appearance',
    icon: 'columns',
    description: 'App-wide display size, board presentation, brand artwork, and ticket colors.'
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
  onNewAgentItem?: (kind: 'agent' | 'profile' | 'skill' | 'import' | 'import-binding') => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenAgentProfile?: (profileId: string) => void;
  onOpenSkill?: (skillName: string) => void;
}

export function SettingsPage({ connections, onOpenConnections, initialCategory = 'overview', onNewAgentItem, onOpenAgent, onOpenAgentProfile, onOpenSkill }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsCategory>(initialCategory);
  const [resettingData, setResettingData] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<'defaults' | 'sessions' | 'project-data' | 'appearance'>();
  const { settings, update, error } = useSettings();

  const nav = useResizable({
    storageKey: 'praxis:settings:nav-width:v1',
    initial: 220,
    min: 160,
    max: 420,
    side: 'left'
  });

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
        displayMode: appearance.displayMode,
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
      <nav className="settings-nav" aria-label="Settings categories" style={{ width: nav.size }}>
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
      <div
        className={`splitter${nav.dragging ? ' dragging' : ''}`}
        aria-label="Resize settings navigation"
        data-testid="settings-nav-splitter"
        {...nav.handleProps}
      />
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
        {active === 'updates' && <UpdatesSection />}
        {active === 'connections' && (
          <ConnectionsSection connections={connections} onOpenConnections={onOpenConnections} />
        )}
        {active === 'mobile' && <MobileAccessSection settings={settings} update={update} />}
        {active === 'marketplace' && <MarketplaceSection />}
        {active === 'jira' && <JiraSection settings={settings} update={update} />}
        {active === 'ai' && <AiSection settings={settings} update={update} connections={connections} />}
        {active === 'ai-usage' && <AiUsageStatsSection settings={settings} update={update} connections={connections} />}
        {active === 'gadgets' && <GadgetsSection />}
        {active === 'agent-runtime' && (
          <AgentRuntimeSection
            settings={settings}
            update={update}
            onNewAgentItem={onNewAgentItem}
            onOpenAgent={onOpenAgent}
            onOpenAgentProfile={onOpenAgentProfile}
            onOpenSkill={onOpenSkill}
          />
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

type AgentRuntimeTab = 'agents' | 'skills' | 'instructions' | 'runtimes' | 'advanced';

/** One agent or skill row: identity icon on the surface, title with badges, description, one action. */
function RuntimeItem({
  icon,
  title,
  badges = [],
  description,
  meta,
  action,
  testId
}: {
  icon: IconName;
  title: string;
  badges?: string[];
  description?: string;
  meta?: string;
  action?: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="settings-field-row" data-testid={testId}>
      <span className="runtime-item-icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="settings-field-label">
        <div className="runtime-item-title">
          <strong>{title}</strong>
          {badges.map(badge => (
            <span key={badge} className="badge">
              {badge}
            </span>
          ))}
        </div>
        {description && <div className="settings-field-help">{description}</div>}
        {meta && <div className="settings-field-help">{meta}</div>}
      </div>
      {action && <div className="settings-field-control settings-inline-controls">{action}</div>}
    </div>
  );
}

/**
 * One kind's marketplace: every catalogue item once, with Install or
 * Uninstall. Agents and skills carry instructions (a skill may carry scripts)
 * that agents act on, so installing asks first — confirming is the trust
 * decision; there is no separate trust step.
 */
function RuntimeMarketplace({
  addons,
  kind
}: {
  addons: ReturnType<typeof useKindAddons>;
  kind: 'agent' | 'skill';
}) {
  const dialogs = useDialogs();
  const catalog = addons.catalog ?? [];
  const installedById = new Map(addons.installed.map(addon => [addon.manifest.id, addon]));
  const rows = [
    ...catalog.map(entry => ({ id: entry.manifest.id, manifest: entry.manifest, version: entry.latestVersion, entry })),
    // Installed add-ons that left the catalogue stay listed so they can be uninstalled.
    ...addons.installed
      .filter(addon => !catalog.some(entry => entry.manifest.id === addon.manifest.id))
      .map(addon => ({ id: addon.manifest.id, manifest: addon.manifest, version: addon.version, entry: undefined }))
  ];

  const install = async (entry: (typeof catalog)[number]) => {
    const confirmed = await dialogs.confirm({
      title: `Install ${entry.manifest.name}?`,
      message: `This ${kind} gives Praxis agents instructions${kind === 'skill' ? ' — and any scripts it includes —' : ''} to follow when they use it. Install it only if you trust its author.`,
      details: [`${entry.packageName} v${entry.latestVersion}`, ...(entry.manifest.author ? [`By ${entry.manifest.author}`] : [])],
      confirmLabel: 'Install'
    });
    if (confirmed) await addons.install(entry.packageName, { trust: true });
  };
  const uninstall = async (manifest: AddonManifest) => {
    const confirmed = await dialogs.confirm({
      title: `Uninstall ${manifest.name}?`,
      message: `Agents will no longer be able to use this ${kind}. You can install it again from the marketplace.`,
      confirmLabel: 'Uninstall',
      danger: true
    });
    if (confirmed) await addons.remove(manifest.id);
  };

  return (
    <div data-testid={`${kind}-runtime-marketplace`}>
      <h4 className="settings-subsection-title">Marketplace</h4>
      {addons.error && <div className="error-banner">{addons.error}</div>}
      {!addons.ready && (
        <p className="settings-field-help">Set up the add-on catalogue in Settings › Add-ons to browse {kind}s from GitHub Packages.</p>
      )}
      {addons.ready && addons.catalog === undefined && <div className="placeholder-text">Loading the catalogue…</div>}
      {rows.map(row => {
        const installed = installedById.get(row.id);
        const busy = addons.busy === `remove:${row.id}` || (row.entry ? addons.busy === `install:${row.entry.packageName}` : false);
        return (
          <RuntimeItem
            key={row.id}
            testId={`${kind}-marketplace-${row.id}`}
            icon={kind === 'agent' ? 'robot' : 'sparkles'}
            title={row.manifest.name}
            badges={installed ? [installed.enabled ? 'Installed' : 'Installed · disabled'] : []}
            description={row.manifest.summary}
            meta={[
              `v${row.version}`,
              row.manifest.author,
              row.entry?.incompatible ? 'needs a newer Praxis' : undefined
            ].filter(Boolean).join(' · ')}
            action={
              installed ? (
                <>
                  {!installed.enabled && (
                    <button className="btn" type="button" disabled={busy} onClick={() => void addons.setTrust(row.id, true)}>
                      Enable
                    </button>
                  )}
                  <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void uninstall(row.manifest)}>
                    Uninstall
                  </button>
                </>
              ) : row.entry ? (
                <button className="btn" type="button" disabled={busy || row.entry.incompatible} onClick={() => void install(row.entry!)}>
                  Install
                </button>
              ) : undefined
            }
          />
        );
      })}
      {addons.ready && addons.catalog !== undefined && rows.length === 0 && (
        <div className="placeholder-text">No {kind}s in the marketplace yet.</div>
      )}
    </div>
  );
}

function useBrowseOnce(addons: ReturnType<typeof useKindAddons>): void {
  useEffect(() => {
    if (addons.ready && addons.catalog === undefined && !addons.busy) {
      void addons.browse();
    }
  }, [addons.ready, addons.catalog, addons.busy, addons.browse]);
}

function AgentRuntimeSection({
  settings,
  update,
  onNewAgentItem,
  onOpenAgent,
  onOpenAgentProfile,
  onOpenSkill
}: {
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  onNewAgentItem?: (kind: 'agent' | 'profile' | 'skill' | 'import' | 'import-binding') => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenAgentProfile?: (profileId: string) => void;
  onOpenSkill?: (skillName: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot>();
  const [roots, setRoots] = useState<{ agents: Record<string, string>; runtimeHosts?: Record<string, string>; profiles?: Record<string, string>; skills: Record<string, string> }>();
  const [providerStatuses, setProviderStatuses] = useState<AiProviderStatus[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<AgentRuntimeTab>('agents');
  const [nativeError, setNativeError] = useState<string>();
  const [nativeBusy, setNativeBusy] = useState<string>();
  const runNative = async (key: string, action: () => Promise<AgentRuntimeSnapshot | void>) => {
    setNativeBusy(key);
    setNativeError(undefined);
    try {
      const next = await action();
      if (next) setSnapshot(next);
    } catch (cause) {
      setNativeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNativeBusy(undefined);
    }
  };
  /** Show-file and Copy-to-Praxis for an item found in another AI tool's folder. */
  const nativeActions = (kind: 'agent' | 'skill' | 'instruction', id: string, itemPath: string, trusted: boolean) => (
    <>
      <button className="btn btn-quiet" type="button" onClick={() => void runNative(`reveal:${itemPath}`, () => window.praxis.agentRuntime.revealNative(itemPath))}>
        Show file
      </button>
      {kind !== 'instruction' && (
        <button
          className="btn btn-quiet"
          type="button"
          disabled={!trusted || nativeBusy === `copy:${id}`}
          title={trusted ? 'Make an editable copy in Praxis; it replaces this one in Praxis' : 'Allow this project first'}
          onClick={() => void runNative(`copy:${id}`, () => window.praxis.agentRuntime.copyNative(kind, id))}
        >
          Copy to Praxis
        </button>
      )}
    </>
  );

  const agentAddons = useKindAddons('agent');
  const skillAddons = useKindAddons('skill');
  useBrowseOnce(agentAddons);
  useBrowseOnce(skillAddons);

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

  // Trusting or removing an agent/skill add-on changes what discovery finds.
  const addonState = [...agentAddons.installed, ...skillAddons.installed].map(addon => `${addon.manifest.id}:${addon.enabled}`).join(',');
  useEffect(() => {
    if (snapshot) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addonState]);

  const runtimeProviders = AI_PROVIDERS.filter(provider => provider.kind === 'cli-agent');
  const availableRuntimes = runtimeProviders.filter(runtime => providerStatuses.find(status => status.provider === runtime.id)?.configured).length;
  // Every binding always has *some* profile entry — one it wrote itself
  // (curated) or one Praxis auto-synthesizes as a placeholder when it has no
  // AGENT.md. Only the curated ones are agents; a binding whose only profile
  // is that placeholder is a custom launch binding.
  const profiles = (snapshot?.profiles ?? []).filter(profile => !isHostShimProfile(profile));
  const launchBindin…69955 tokens truncated…e<boolean>;
}

/** Live state of the in-app AI browser, pushed on `browser:didNavigate`. */
export interface BrowserNavigationState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/** Result of a page-level browser action returned to the renderer toolbar. */
export interface BrowserPageResult {
  url: string;
  title: string;
  text: string;
}

/**
 * The in-app browser surface: a `WebContentsView` the AI drives (via the gateway
 * browser tools) and the user watches. The renderer owns its on-screen position
 * — it draws a placeholder and reports the rect through `setBounds`.
 */
export interface BrowserIpc {
  /** Parents the view to this window (idempotent). */
  attach(): Promise<void>;
  /** Positions the native view over the renderer's placeholder, in CSS px. */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Shows or hides the view without detaching it. */
  setVisible(visible: boolean): Promise<void>;
  navigate(url: string): Promise<BrowserPageResult>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  getState(): Promise<BrowserNavigationState | undefined>;
  /** Subscribes to navigation updates; returns an unsubscribe function. */
  onDidNavigate(listener: (state: BrowserNavigationState) => void): () => void;
}

/**
 * Run lifecycle control (FX-BE-055 / TASK-146): start/stop the whole run,
 * start/stop/restart one service, live status/log push events, and
 * conservative post-restart reconciliation for whatever a previous session
 * left running when Praxis itself was closed.
 */
export interface RunsIpc {
  /** Starts the project's saved Run profile. Rejects if none exists, the profile is invalid, or a run is already active. */
  start(projectId: string): Promise<void>;
  /** Stops every service in the project's active run and revokes its preview grants. A no-op if nothing is running. */
  stop(projectId: string): Promise<void>;
  stopService(projectId: string, serviceId: string): Promise<void>;
  startService(projectId: string, serviceId: string): Promise<void>;
  restartService(projectId: string, serviceId: string): Promise<void>;
  /** A snapshot of every tracked service's current status — empty when nothing is running for this project this session. */
  status(projectId: string): Promise<RunServiceStatus[]>;
  /**
   * Conservative reconciliation against whatever this project's last run
   * persisted (TASK-146's "after app restart" half). Empty when this
   * session's own manager already owns the project's run, or nothing was
   * ever persisted — only meaningful right after launch, before `start` has
   * been called for this project in this session.
   */
  reconcile(projectId: string): Promise<ReconciledService[]>;
  /** The granted preview origin for a ready service, or undefined if it isn't ready (yet) or declares no port. */
  previewUrl(projectId: string, serviceId: string): Promise<string | undefined>;
  /** Fires on every service status transition for any project's active run. */
  onStatusChanged(listener: (projectId: string, status: RunServiceStatus) => void): () => void;
  /** Fires on every stdout/stderr line from any project's active run. */
  onLog(listener: (projectId: string, line: RunLogLine) => void): () => void;
  /**
   * Runs one preview verification check against a ready service (FX-BE-056
   * / TASK-149): opens its granted origin, runs the check's interactions,
   * and evaluates its assertions. Rejects if the service has no active
   * preview grant (its run must be started and the service `ready` first).
   */
  runVerification(projectId: string, check: PreviewVerificationCheck): Promise<PreviewVerificationOutcome>;
  /**
   * Starts a diagnosis session from a failed verification outcome. Refuses
   * (without opening a session) when `outcome.passed` is true or the
   * project has no working folder — the same "never open a session with
   * nothing to work from" discipline as `WorkflowsIpc.startDiagnosis`.
   */
  diagnoseVerificationFailure(
    projectId: string,
    check: PreviewVerificationCheck,
    outcome: PreviewVerificationOutcome
  ): Promise<CreateDiagnosisSessionResult>;
}

/**
 * The Run preview surface (FX-BE-055 / TASK-146) — a passive viewer onto a
 * granted preview origin, structurally the same `WebContentsView` control
 * channel as `BrowserIpc` but with no navigation/action methods: a preview
 * only ever opens the one URL its owning service was granted. Hiding it
 * (`setVisible(false)`, what closing the preview tab does) never touches
 * the underlying run — see `previewBrowser.ts`'s module comment.
 */
export interface PreviewIpc {
  attach(): Promise<void>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  /** Rejects with the same reason `previewAccessBlockedReason` would give if the URL's origin has no active grant. */
  open(url: string): Promise<void>;
  /**
   * Screenshots the currently open page, folds it into the console/network
   * evidence captured since the last `open()`, persists the bundle, and
   * returns it (FX-BE-056 / TASK-147). `undefined` when nothing is
   * currently open with a resolvable grant to attribute the capture to.
   */
  captureDiagnostics(): Promise<BrowserDiagnosticsBundle | undefined>;
}

/**
 * Update state as the main process sees it. `unsupported` is the ordinary case
 * in development and in a build published without a feed — not an error.
 * `available` carries `canInstall: false` when the build can find an update but
 * cannot apply one (an unsigned macOS bundle; Squirrel.Mac refuses those); the
 * renderer then points at `releaseUrl` for a manual download instead.
 */
export type UpdateStatus =
  | { state: 'unsupported'; reason: string }
  | { state: 'checking' }
  | { state: 'current'; version: string }
  | { state: 'available'; version: string; canInstall: boolean; releaseUrl?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface UpdateIpc {
  getStatus(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  /** Quits and relaunches into the downloaded version. */
  installNow(): Promise<UpdateStatus>;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

export interface AppIpc {
  getVersion(): Promise<string>;
  update: UpdateIpc;
}

/** Marketplace configuration state, safe to show in the renderer (no token value). */
export interface MarketplaceStatus {
  /** `enabled`, an `owner`, and a stored token are all present. */
  ready: boolean;
  enabled: boolean;
  owner: string;
  ownerType: 'user' | 'org';
  packageNamePrefix: string;
  apiBaseUrl: string;
  registryBaseUrl: string;
  checkOnLaunch: boolean;
  hasToken: boolean;
}

/** Config the renderer may change — everything in {@link MarketplaceStatus} bar the token. */
export type MarketplaceConfigPatch = Partial<
  Pick<
    MarketplaceSettings,
    | 'enabled'
    | 'owner'
    | 'ownerType'
    | 'packageNamePrefix'
    | 'apiBaseUrl'
    | 'registryBaseUrl'
    | 'checkOnLaunch'
  >
>;

export interface MarketplaceInstallOptions {
  /** Pin a published version instead of `latest`. */
  version?: string;
  /** Grant a non-declarative (`agent`, `skill`) add-on execution trust as part of installing it. */
  trust?: boolean;
}

export interface MarketplaceIpc {
  getStatus(): Promise<MarketplaceStatus>;
  /** Persists marketplace config (not the token) and returns the new status. */
  configure(patch: MarketplaceConfigPatch): Promise<MarketplaceStatus>;
  /** Stores or (with `null`) clears the GitHub token in the OS-encrypted secret store. */
  setToken(token: string | null): Promise<MarketplaceStatus>;
  /** The browsable catalogue — every publishable add-on, resolved to its latest version. */
  listCatalog(): Promise<CatalogEntry[]>;
  listInstalled(): Promise<InstalledAddon[]>;
  /** Enabled declarative appearance content, for the renderer to register over the user's own. */
  listActiveAppearance(): Promise<ActiveAppearanceAddons>;
  install(packageName: string, options?: MarketplaceInstallOptions): Promise<InstalledAddon>;
  update(kind: AddonKind, id: string): Promise<InstalledAddon>;
  remove(kind: AddonKind, id: string): Promise<void>;
  checkForUpdates(): Promise<AddonUpdate[]>;
  /** Grants or revokes execution trust for an installed non-declarative (`agent`, `skill`) add-on. */
  setTrust(kind: AddonKind, id: string, enabled: boolean): Promise<void>;
  /** Fires after any install/remove/update/trust change. */
  onChanged(listener: () => void): () => void;
}

/** Durable app-managed projects and their default local boards. */
export interface ProjectsIpc {
  list(): Promise<ProjectRecord[]>;
  get(projectId: string): Promise<ProjectRecord | undefined>;
  /** Creates a project and assigns it to an existing workspace atomically. */
  create(input: CreateProjectInput, workspaceId: string): Promise<ProjectRecord>;
  useExisting(projectId: string, workspaceId: string): Promise<ProjectRecord>;
  /** Removes a project record; its generated project board is removed with it. */
  remove(projectId: string): Promise<void>;
  update(projectId: string, patch: UpdateProjectInput): Promise<ProjectRecord>;
  inspectFolder(folderPath: string): Promise<FolderInspection>;
  attachFolder(projectId: string, input: AttachProjectFolderInput): Promise<AttachProjectFolderResult>;
  linkBoard(projectId: string, board: ProjectBoardReference): Promise<ProjectRecord>;
  unlinkBoard(projectId: string, connectionId: string, boardId: string): Promise<ProjectRecord>;
  listDocuments(projectId: string): Promise<ProjectDocumentsResult>;
  readDocument(projectId: string, relativePath: string): Promise<ProjectDocument>;

  /**
   * Scans a picked parent folder for plans folders to import as projects —
   * step 1 of the import wizard. Merges two scans (plans roots and Git
   * repository roots); a repository with no discoverable plans is skipped
   * rather than guessed at.
   */
  discoverImports(folderPath: string): Promise<ProjectImportRow[]>;
  /** Re-validates edited rows (unique, well-formed project keys) before creation. */
  validateImports(rows: ProjectImportRow[]): Promise<string | undefined>;
  /** Creates a folder-backed project per selected row and adds them to the workspace. */
  createFromImports(rows: ProjectImportRow[], workspaceId: string): Promise<ProjectRecord[]>;

  /**
   * Reads the project's `run.praxis.json` (FX-BE-054 / TASK-143). No profile
   * yet — including a project with no working folder — is `{ issues: [] }`,
   * not an error; a hand-edited malformed file comes back with `issues`
   * describing why, per `readRunProfile`'s contract.
   */
  getRunProfile(projectId: string): Promise<{ profile?: RunProfile; issues: RunProfileIssue[] }>;
  /** Validates then writes the project's Run profile; rejects (no write) when invalid. */
  saveRunProfile(projectId: string, profile: RunProfile): Promise<void>;
  /**
   * Runs `validateRunProfile` without writing anything — live feedback while
   * editing. `saveRunProfile` re-validates independently before it writes;
   * this is a convenience for the editor, not the enforcement point.
   */
  validateRunProfile(profile: RunProfile): Promise<RunProfileValidationResult>;
  /**
   * Proposes Run services from a shallow scan of the project's working
   * folder (root plus immediate subdirectories) — reads `package.json` and
   * `Properties/launchSettings.json` only, never writes anything.
   */
  discoverRunServices(projectId: string): Promise<Array<ProposedRunService & { relativeDir: string }>>;
}

/** Saved workspaces — named groupings of projects/connections the user can switch between and export to a file. */
export interface WorkspacesIpc {
  list(): Promise<WorkspaceRecord[]>;
  get(workspaceId: string): Promise<WorkspaceRecord | undefined>;
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  setActive(workspaceId: string | undefined): Promise<void>;
  update(workspaceId: string, patch: UpdateWorkspaceInput): Promise<WorkspaceRecord>;
  remove(workspaceId: string): Promise<void>;
  saveToFile(workspaceId: string): Promise<string | undefined>;
  openFromFile(): Promise<WorkspaceRecord | undefined>;
  openFolder(folderPath: string): Promise<WorkspaceRecord | undefined>;
}

/** Starts (or restarts) the interactive review of one ticket. */
export interface AiTicketReviewInput {
  issueKey: string;
  connectionId?: string;
  /** Provider override; defaults to `settings.ai.activeProvider`. */
  provider?: AiProvider;
  model?: string;
}

/** One chat turn in the per-issue analysis conversation. */
export interface AiAnalysisMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

/**
 * Per-issue analysis state. Messages/confirmed/confirmedAt/model persist;
 * `busy` is runtime-only (an analysis run is streaming right now).
 */
export interface AiAnalysisState {
  issueKey: string;
  messages: AiAnalysisMessage[];
  /** Gate flag: delegation/delivery can require a confirmed analysis first. */
  confirmed: boolean;
  confirmedAt?: string;
  /** True while an analysis run is streaming. */
  busy: boolean;
  /** Provider used by the latest analysis run. */
  provider?: AiProvider;
  model?: string;
}

/** Where the effective Vercel gateway API key came from. */
export type AiKeySource = 'secret' | 'env' | 'none';

/** What a workflow run has left in the repository (see `inspectRunWork`). */
export interface WorkflowRunWorkInfo {
  /** The run's branch, when it exists. */
  branch?: string;
  /** Commits on it that exist on no other branch — what deleting the branch would lose. */
  commitCount: number;
  /** Newest first, at most five. */
  commits: Array<{ sha: string; subject: string }>;
  /** The run's live worktree, when it still exists on disk. */
  worktreePath?: string;
  /** Files with uncommitted changes in that worktree. */
  uncommittedFiles: number;
  /** Anything a person would want warning about: commits only on the branch, or uncommitted files. */
  hasWork: boolean;
}

export interface AiProviderStatus {
  provider: AiProvider;
  /** Display name — a built-in's shipped label, or a custom endpoint's own name. */
  label: string;
  kind: 'api' | 'cli-agent';
  /** A user-added OpenAI-compatible endpoint (`custom:<slug>`). */
  custom?: boolean;
  /** Custom endpoints only: false for a "No key" endpoint. */
  needsKey?: boolean;
  /** Custom endpoints only: what the last connection test found. */
  capabilities?: ProviderCapabilities;
  /** True when a usable API key exists (secret store or, for vercel-gateway, env fallback). */
  configured: boolean;
  /**
   * The user has not turned this provider off (`ai.providers[id].enabled !== false`).
   * A provider is offered for new sessions only when it is both `configured` and `enabled`.
   */
  enabled: boolean;
  keySource: AiKeySource;
  /** Effective base URL — the configured value or the provider's shipped default. */
  gatewayUrl: string;
  defaultModel: string;
  agentName: string;
  /** Issue keys with a currently running agent task. */
  activeTasks: string[];
  /** Lightweight local CLI preflight; API providers do not carry this field. */
  preflight?: ProviderPreflightState;
}

export interface SaveCustomProviderInput {
  /** Omitted `id` creates a new endpoint; its id is derived from the label. */
  config: Omit<CustomProviderConfig, 'id'> & { id?: CustomProviderConfig['id'] };
  /** Typed key: stored in the keychain; `''` clears it; omitted leaves it as is. */
  apiKey?: string;
  /** Written to `ai.providers[id].defaultModel`. */
  defaultModel?: string;
}

export interface AiDelegateInput {
  /** Explicit session purpose; defaults to chat for ordinary new sessions. */
  mode?: SessionMode;
  /**
   * Issue to delegate. Omit for a free-form session: `goal` is then required and
   * the main process synthesizes a session key (the session is not bound to any
   * tracker issue).
   */
  issueKey?: string;
  connectionId?: string;
  /** Durable project ownership for project-scoped sessions and workflows. */
  projectId?: string;
  /** Free-form goal for an issue-less session (the New Session composer path). */
  goal?: string;
  /** Task overrides; any omitted field falls back to a default built from the issue. */
  task?: Partial<AgentTaskDefinition>;
  /**
   * Working directory the agent's local tools run in. Required for a full-tools
   * session (the main process rejects the delegate otherwise); read-only and
   * project-only sessions may omit it.
   */
  workingDirectory?: string;
  /**
   * Run this session in a dedicated git worktree branched off `workingDirectory`'s
   * current branch, instead of editing the working tree in place.
   */
  runInWorktree?: boolean;
  /** Provider override for this session; defaults to `settings.ai.activeProvider`. */
  provider?: AiProvider;
  /** Model id override for this session; omitted to use the selected provider's default. */
  model?: string;
  /**
   * Reasoning/thinking effort for this session's turns. Omitted uses the
   * provider's per-model default (Settings → AI Provider → Manage models),
   * then `'off'`.
   */
  reasoningEffort?: ReasoningEffort;
  /** Tool-permission policy for this session. */
  permissionMode?: AgentPermissionMode;
  /** Host-enforced tool access for this session. Analysis always uses read-only. */
  toolMode?: AgentToolMode;
  /** Starts the issue's read-only analysis as the first turn of its normal chat session. */
  purpose?: 'analysis';
  /** Legacy combined id; new callers send profileId and hostId. */
  agentId?: string;
  profileId?: string;
  hostId?: string;
  skillNames?: string[];
  /** Parent session that spawned this subagent session. */
  parentSessionKey?: string;
}

export interface AiHandoverBriefEdits {
  progress?: string;
  changes?: string;
  decisions?: string;
  risks?: string;
  openQuestions?: string;
  nextSteps?: string;
  userNotes?: string;
}

export interface AiHandoverInput {
  provider: AiProvider;
  model?: string;
  expectedBriefRevision: number;
  briefEdits?: AiHandoverBriefEdits;
}

export interface AiSessionModelInput {
  model: string;
}

/**
 * AI slice: Vercel-gateway provider setup plus agent session lifecycle. The API
 * key lives in the OS-keychain secrets store and never crosses IPC — the
 * renderer only learns whether one is configured. Session updates stream back
 * over the `ai:sessionChanged` push channel.
 */
export interface CodeIntelligenceRequest {
  action: 'list' | 'register' | 'index' | 'pause' | 'resume' | 'unregister' | 'query' | 'connect' | 'revoke' | 'model-install' | 'model-activate';
  repositoryId?: string;
  root?: string;
  manifest?: string;
  excludes?: string[];
  tool?: string;
  arguments?: Record<string, unknown>;
  provider?: string;
  bundle?: string;
  fingerprint?: string;
}
export interface CodeIntelligenceResponse {
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  mcpServer?: McpServerConfig;
  evidence?: unknown[];
  warnings?: Array<{ code: string; message: string }>;
  freshness?: { state: string };
}

export interface AiIpc {
  codeIntelligence(request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse>;
  /** Active provider's configuration snapshot — kept for back-compat callers. */
  getStatus(): Promise<AiProviderStatus>;
  /** Stores the active provider's API key encrypted; empty string clears it. */
  setApiKey(value: string): Promise<AiProviderStatus>;
  /** Every configured provider's status snapshot, for the settings UI and the session picker. */
  listProviderStatuses(): Promise<AiProviderStatus[]>;
  /** Runs the ACP handshake for a CLI provider without creating a session or sending a prompt. */
  probeProviderCapability(provider: AiProvider): Promise<ProviderCapabilityProbe | undefined>;
  /** Connects to a user-added MCP server once and lists its tools, for the settings "Test" button. */
  testMcpServer(config: McpServerConfig): Promise<McpTestResult>;
  /** Installs the allowlisted ACP package for a CLI provider, then returns its output summary. */
  installCliProvider(provider: AiProvider): Promise<{ message: string }>;
  /** Looks up the latest published version of a built-in provider's allowlisted ACP package. */
  getLatestCliProviderVersion(provider: AiProvider): Promise<{ version: string }>;
  /**
   * The available models for a `hostKind: 'acp'` provider (Claude Code,
   * Codex), read live from the agent's `session/new` response — a
   * throwaway connection is spun up and immediately disposed, no prompt
   * sent. `undefined` for providers with no model selector (including
   * every non-ACP provider).
   */
  listCliModelOptions(provider: AiProvider): Promise<ModelOptions | undefined>;
  /**
   * The available models for a `kind: 'api'` provider (Vercel AI Gateway,
   * OpenAI, Anthropic), read from its real `/v1/models`-style endpoint and
   * cached (see `modelCatalog.ts`) — pass `forceRefresh: true` to bypass the
   * cache (e.g. a "Refresh" button). `undefined` when no API key is
   * configured or the fetch fails.
   */
  listApiModelOptions(provider: AiProvider, forceRefresh?: boolean): Promise<ModelOptions | undefined>;
  /** Stores a specific provider's API key encrypted; empty string clears it. */
  setProviderApiKey(provider: AiProvider, value: string): Promise<AiProviderStatus>;
  /** Tests whether the configured API key and endpoint for a provider can connect successfully. */
  testProviderApiKey(provider: AiProvider): Promise<{ ok: boolean; message: string }>;
  /** Clears all AI provider API keys so credentials can be re-entered after a keychain migration. */
  resetProviderApiKeys(): Promise<void>;
  /** The OpenAI-compatible presets offered by Settings → AI Provider → Add provider. */
  listProviderPresets(): Promise<ProviderPreset[]>;
  /**
   * Probes an endpoint — saved, or an unsaved draft from the settings form.
   * `apiKey` is the key typed into the form; it is used for this probe only.
   */
  testCustomProvider(draft: CustomProviderConfig, options?: { apiKey?: string; model?: string }): Promise<ProviderProbeResult>;
  /**
   * Adds or updates an endpoint, and its key when one is given (`''` clears it).
   * Returns the saved endpoint — its id is assigned here for a new one.
   */
  saveCustomProvider(input: SaveCustomProviderInput): Promise<CustomProviderConfig>;
  /** Deletes an endpoint and its stored key; settings that pointed at it fall back. */
  removeCustomProvider(id: AiProvider): Promise<void>;
  /** Every persisted agent session, most recently started first. */
  listSessions(): Promise<AgentSessionRecord[]>;
  /** Gets a single agent session by issueKey or sessionId, hydrating its full event transcript on demand. */
  getSession(issueKey: string): Promise<AgentSessionRecord | undefined>;
  listInterruptedSessions(): Promise<AgentSessionRecord[]>;
  resumeInterruptedSession(issueKey: string): Promise<void>;
  dismissInterruptedSessions(issueKeys: string[]): Promise<void>;
  /**
   * Loads a raster image from the selected session's working folder for an
   * in-app chat preview. The host enforces the session-folder boundary and
   * returns a data URL so the renderer never receives filesystem access.
   */
  loadImagePreview(issueKey: string, filePath: string): Promise<string | undefined>;
  /** Opens a bounded HTML file from the session's working folder in a restricted in-app preview window. */
  openHtmlArtifactPreview(issueKey: string, filePath: string, title?: string): Promise<void>;
  /** Renames a persisted session without changing its ticket binding or task goal. */
  renameSession(issueKey: string, title: string): Promise<AgentSessionRecord>;
  assignSessionToProject(issueKey: string, projectId: string, ticketKey?: string, workingDirectory?: string): Promise<AgentSessionRecord>;
  /** Aborts a running session if needed, then permanently removes its saved conversation. */
  deleteSession(issueKey: string): Promise<void>;
  /**
   * Archives or restores a saved session. Reversible and non-destructive —
   * unlike `deleteSession`, the recorded conversation is kept; archived
   * sessions leave the active session tree but remain listed in the sessions
   * browser. Archiving a session whose task is still running is refused.
   */
  archiveSession(issueKey: string, archived: boolean): Promise<AgentSessionRecord>;
  /** Starts a general agent task for an issue; resolves with the new session record. */
  delegate(input: AiDelegateInput): Promise<AgentSessionRecord>;
  /** Aborts the running task for an issue (no-op when none is active). */
  abort(issueKey: string): Promise<void>;
  /** Sends a follow-up message and continues the existing recorded session. */
  /**
   * Sends a follow-up message and continues the existing recorded session.
   * `images` are attachments pasted/dropped into the composer, forwarded to the
   * agent with the message as provider-native image content.
   */
  continueSession(
    issueKey: string,
    message: string,
    images?: WireImageAttachment[],
    options?: { gadgetAnswer?: boolean }
  ): Promise<void>;
  /** Changes the model used for the next turn of an idle session. */
  updateSessionModel(issueKey: string, model: string): Promise<AgentSessionRecord>;
  /** Changes the reasoning/thinking effort used for the next turn of an idle session. */
  updateSessionReasoningEffort(issueKey: string, reasoningEffort: ReasoningEffort): Promise<AgentSessionRecord>;
  /** Changes the permission policy used for the next turn of an idle session. */
  updateSessionPermissionMode(issueKey: string, permissionMode: AgentPermissionMode): Promise<AgentSessionRecord>;
  /** Updates the working directory or tool mode for an idle session. */
  updateSessionToolAccess(
    issueKey: string,
    options: { workingDirectory?: string | null; toolMode?: AgentToolMode }
  ): Promise<AgentSessionRecord>;
  /** Hands the same Praxis session to another provider and seeds it with the living brief. */
  handoverSession(issueKey: string, input: AiHandoverInput): Promise<AgentSessionRecord>;
  startConversation(issueKey: string, input: AiStartConversationInput): Promise<AgentSessionRecord>;
  /** Queues a human message for a selected participant in a running AI conversation. */
  sendConversationMessage(issueKey: string, input: AiConversationMessageInput): Promise<AgentSessionRecord>;
  stopConversation(issueKey: string): Promise<AgentSessionRecord>;
  setConversationToolOwner(issueKey: string, participantId: string): Promise<AgentSessionRecord>;
  /** Saves user edits to the living handover brief. */
  editHandoverBrief(
    issueKey: string,
    expectedRevision: number,
    edits: AiHandoverBriefEdits
  ): Promise<AgentSessionRecord>;
  /**
   * Removes the git worktree a session was created in (branch and checkout).
   * Fails if the session has no worktree or its task is still running.
   */
  removeWorktree(issueKey: string): Promise<void>;
  /**
   * Creates or attaches a dedicated git worktree for an existing session.
   */
  setWorktree(issueKey: string, options?: { baseBranch?: string; branchName?: string }): Promise<AgentSessionRecord>;
  /** Switches the active phase of a session and continues it with that mode's contract. */
  switchSessionMode(issueKey: string, mode: SessionMode): Promise<void>;
  /**
   * Switches an ACP-hosted agent's own Session Mode (e.g. "ask" / "architect"
   * / "code") over its live connection — entirely distinct from
   * `switchSessionMode` above, which is Praxis's own chat/analysis/review
   * phase. Requires the session's task to still be running; throws for any
   * non-ACP provider. `modeId` is one of the ids in the session record's
   * `acpAvailableModes`.
   */
  setAcpMode(issueKey: string, modeId: string): Promise<void>;
  /**
   * Resolves the oldest pending permission request for an issue's active
   * task (no-op when none is pending). `'allow_always'` also resolves every
   * other request currently queued for that task.
   */
  respondToPermission(issueKey: string, decision: PermissionDecision): Promise<void>;
  /**
   * Reverts one file to what it was immediately before a specific recorded
   * edit — restoring `oldText` on disk, sandboxed to the session's own
   * working folder or worktree. Identifies the edit by the `tool_complete`
   * event's own timestamp plus the path, since a session can touch the same
   * file more than once. Refuses when the session has since made a later
   * edit to that same path (undoing it would silently discard the newer
   * one) or while a turn is still running.
   */
  undoToolFileChange(issueKey: string, eventTimestamp: string, path: string): Promise<AgentSessionRecord>;
  /** Subscribes to session record updates; returns an unsubscribe function. */
  onSessionChanged(listener: (record: AgentSessionRecord) => void): () => void;
  /** Subscribes to session deletions; returns an unsubscribe function. */
  onSessionDeleted(listener: (issueKey: string) => void): () => void;

  // ── Workflow packs ────────────────────────────────────────────────────────
  /** Workflow packs discovered under `<workingDirectory>/.github/skills`. */
  listWorkflowPacks(): Promise<AgentWorkflowReference[]>;
  /** The workflow pack assigned to an issue, if any. */
  getWorkflowAssignment(issueKey: string): Promise<IssueWorkflowAssignment | undefined>;
  /** Assigns a workflow pack to an issue; `null` clears the assignment. */
  setWorkflowAssignment(issueKey: string, workflow: AgentWorkflowReference | null): Promise<void>;

  // ── Ticket review ─────────────────────────────────────────────────────────
  /**
   * Starts the interactive review of a ticket as a read-only agent session,
   * superseding any earlier review of the same ticket. Findings arrive as
   * gadgets in the session; the record's `issueKey` is the review session's
   * own key (not the ticket's) and is what `onSessionChanged` reports under.
   */
  startTicketReview(input: AiTicketReviewInput): Promise<AgentSessionRecord>;
  /** The current review session for a ticket, or `undefined` when it has never been reviewed. */
  getTicketReview(issueKey: string): Promise<AgentSessionRecord | undefined>;

  // ── Local peer review ─────────────────────────────────────────────────────
  /**
   * Runs the three-section local peer review (code review, security review,
   * then a summarizing verdict). Resolves with the three markdown bodies.
   */
  localPeerReview(
    issueKey: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<LprResult>;
  /** Continues a local peer review with a follow-up question. */
  localPeerReviewFollowUp(
    issueKey: string,
    message: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<string>;

  // ── Issue analysis (chat) ─────────────────────────────────────────────────
  /** The persisted analysis conversation + confirmation state for an issue. */
  getAnalysis(issueKey: string): Promise<AiAnalysisState>;
  /**
   * Asks a question (empty string runs the base analysis) and streams the answer
   * into the state; every mutation pushes `ai:analysisChanged`.
   */
  submitAnalysis(
    issueKey: string,
    question: string,
    connectionId?: string,
    provider?: AiProvider,
    model?: string
  ): Promise<void>;
  /** Cancels a running analysis (no-op when none is active). */
  cancelAnalysis(issueKey: string): Promise<void>;
  /** Marks the analysis confirmed (or un-confirms it) for the delegation gate. */
  setAnalysisConfirmed(issueKey: string, confirmed: boolean): Promise<void>;
  /** Clears the stored analysis conversation for an issue. */
  clearAnalysis(issueKey: string): Promise<void>;
  /** Subscribes to analysis state updates; returns an unsubscribe function. */
  onAnalysisChanged(listener: (state: AiAnalysisState) => void): () => void;

  // ── Delivery / decomposition / merge requests ─────────────────────────────
  /** Starts the delivery workflow for an issue; validates delivery settings first. */
  startDelivery(issueKey: string, connectionId?: string): Promise<AgentSessionRecord>;
  /** Decomposes a feature-request issue into sub-tasks (created when the run completes). */
  decomposeFeature(issueKey: string, connectionId?: string): Promise<AgentSessionRecord>;
  /** Starts delivery of one decomposed sub-task of a feature issue. */
  startSubTaskDelivery(
    parentIssueKey: string,
    subTaskKey: string,
    connectionId?: string
  ): Promise<AgentSessionRecord>;
  /** Merge requests linked to the issue key (GitLab connections only). */
  listMergeRequests(issueKey: string, connectionId: string): Promise<GitLabMergeRequest[]>;
  /** Creates an MR for the issue's delivery branch; returns an existing open one when present. */
  createMergeRequest(issueKey: string, connectionId: string): Promise<GitLabMergeRequest>;
  /** Starts a feedback-addressing session when the open MR has new human notes. */
  checkMergeRequestFeedback(
    issueKey: string,
    connectionId: string
  ): Promise<{ started: boolean; noteCount: number }>;
}

/**
 * Read side of the AI usage ledger (`AiUsageLog`) — every token/cost delta
 * from every agent session plus internal one-shot calls like the workflow
 * agent recommendation, aggregated for the Settings → AI usage report.
 * Writes happen only from inside the main process (session-usage tracking,
 * the recommendation handler itself); there is deliberately no `record`
 * method here for the renderer to call.
 */
/** Agent session coordination (FX-BF-048): who holds what, who waits, and recovery. */
export interface CoordinationIpc {
  state(): Promise<{ state: CoordinationState; role: 'leader' | 'follower'; blockedReason: string | null }>;
  /** A person confirms a claim awaiting recovery really stopped. */
  recover(claimId: string, note: string): Promise<void>;
  /**
   * Stops a service an agent's shell command left running (its whole process group). Only a
   * process this app instance started can be stopped from here; false otherwise.
   */
  stopService(pgid: number): Promise<boolean>;
  onChanged(listener: () => void): () => void;
}

export interface AiUsageIpc {
  /**
   * Bucketed totals for the `periodsBack` most recent periods at this granularity, oldest first, zero-filled.
   * Pass `provider` to scope the buckets to one provider (the session usage bar shows the selected
   * provider's totals next to its account quota); omit it for account-wide totals.
   */
  series(granularity: UsageGranularity, periodsBack: number, provider?: AiProvider): Promise<UsageBucket[]>;
  /** The latest period vs. the one before it — "more or less AI than last week", generalised to day/week/month. */
  compareLatestPeriod(granularity: UsageGranularity): Promise<UsageComparison>;
  /** Today / week / month / all-time totals, per-model breakdowns and peaks in one read — the Overview panel and Settings model breakdown. */
  dashboardSummary(): Promise<UsageDashboardSummary>;
  /** The raw ledger, newest last — for a detail table; not meant for charting directly. */
  listEvents(): Promise<AiUsageEvent[]>;
  /** Provider account usage/limits, when the provider exposes a supported API. */
  providerSnapshot(provider: AiProvider): Promise<ProviderUsageSnapshot>;
  /**
   * Every enabled provider's account usage in one read (FX-BF-050). The
   * Overview dashboard needs all of them at once and the Codex adapter spawns
   * a CLI process, so a per-provider loop from the renderer would be N process
   * spawns per page load. One provider failing never fails the batch.
   */
  providerSnapshots(): Promise<ProviderUsageSnapshotsResult>;
  /** On-demand historical account usage; never writes to the local ledger. */
  providerHistory(provider: AiProvider): Promise<ProviderUsageHistory>;
  /** Stores a provider's optional admin/usage credential in the OS keychain. */
  setProviderUsageKey(provider: AiProvider, value: string): Promise<void>;
  /**
   * Alibaba Coding Plan quota is read through a signed-in Alibaba Cloud
   * console session that Praxis hosts in its own partition — the plan's API
   * key cannot read it. Status and sign-in take the endpoint's id so the
   * console region follows its base URL.
   */
  alibabaConsoleStatus(provider: AiProvider): Promise<{ signedIn: boolean }>;
  /** Opens the console sign-in window; resolves once it is closed. */
  alibabaConsoleSignIn(provider: AiProvider): Promise<{ signedIn: boolean }>;
  /** Clears the console session (cookies and storage) Praxis holds. */
  alibabaConsoleSignOut(): Promise<{ signedIn: boolean }>;
}

/**
 * Interactive chat gadgets (FX-BF-036).
 *
 * The renderer never mints a scope. It names a session, a gadget and an action;
 * the host looks the envelope up, pins the scope from its own view of the
 * session, and authorises against that — so a renderer cannot retarget an
 * approval at another project by rewriting what it sends.
 */
export interface GadgetsIpc {
  /** Every block for a session, with lifecycle state resolved against now. */
  getBlocks(sessionId: string): Promise<ChatBlock[]>;
  /** Validate and store a response's blocks. Refused gadgets come back as fallbacks. */
  publish(sessionId: string, blocks: RawChatBlockInput[]): Promise<ChatBlock[]>;
  /**
   * Parse one provider message and publish whatever it asked for. The host
   * stamps scope and identity, so the producer only chooses what to ask.
   */
  publishFromText(sessionId: string, idPrefix: string, text: string): Promise<ChatBlock[]>;
  /** Submit an answer. Safe to retry with the same `idempotencyKey`. */
  submit(input: GadgetSubmitRequest): Promise<GadgetActionResult>;
  /** Ledger events after a cursor, for a client that reconnected. */
  replay(afterSequence: number): Promise<GadgetLedgerEvent[]>;
  /** Withdraw a gadget so it stops accepting answers. */
  revoke(sessionId: string, gadgetId: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
  /** Fires when a session's blocks change, so an open transcript re-reads them. */
  onChanged(callback: (sessionId: string) => void): () => void;
}

export interface GadgetSubmitRequest {
  sessionId: string;
  gadgetId: string;
  actionId: string;
  value: GadgetActionValue;
  /** Stable per logical submission; a retry reuses it. Minted by the host when absent. */
  idempotencyKey?: string;
  correlationId?: string;
}

/** The app-wide Virtual Team Assistant: persona turns, team reviews and persisted chats. */
export interface AssistantIpc {
  /** One persona answers; an `@mention` in the message picks the persona. */
  turn(request: AssistantTurnRequest): Promise<AssistantTurnResult>;
  /** Dev → QA → Security → Lead pass over the supplied page context. */
  teamReview(request: AssistantTeamReviewRequest): Promise<AssistantTurnResult>;
  listChats(projectId: string): Promise<TeamChatSummary[]>;
  getChat(chatId: string): Promise<TeamChatRecord | undefined>;
  createChat(projectId: string, issueKey?: string): Promise<TeamChatRecord>;
  saveChat(chatId: string, messages: readonly AssistantMessage[]): Promise<TeamChatRecord>;
  renameChat(chatId: string, title: string): Promise<TeamChatRecord>;
  deleteChat(chatId: string): Promise<void>;
  /** Fires after any chat is created, saved, renamed or deleted, so the sidebar can refresh. */
  onChatsChanged(listener: () => void): () => void;
}

export interface PraxisIpc {
  activity: {
    list(projectId: string): Promise<import('../projects/projectActivity').ProjectActivitySnapshot>;
  };
  assistant: AssistantIpc;
  app: AppIpc;
  board: BoardIpc;
  issue: IssueIpc;
  connection: ConnectionIpc;
  folder: FolderIpc;
  window: WindowIpc;
  detachedChat: DetachedChatIpc;
  settings: SettingsIpc;
  log: LogIpc;
  dialog: DialogIpc;
  shell: ShellIpc;
  browser: BrowserIpc;
  boardPrefs: BoardPrefsIpc;
  ai: AiIpc;
  aiUsage: AiUsageIpc;
  coordination: CoordinationIpc;
  agentRuntime: AgentRuntimeIpc;
  gadgets: GadgetsIpc;
  marketplace: MarketplaceIpc;
  taskDesigner: TaskDesignerIpc;
  workflows: WorkflowsIpc;
  projects: ProjectsIpc;
  workspaces: WorkspacesIpc;
  terminal: TerminalIpc;
  git: GitIpc;
  runs: RunsIpc;
  preview: PreviewIpc;
  deployments: DeploymentsIpc;
}

/**
 * Direct deployment actions (FX-BE-059 / TASK-158) — prepare, approve,
 * deploy, health results, and explicit rollback, each a thin pass-through
 * to the core orchestrator (`deployments/directDeploymentOrchestrator.ts`).
 * A profile and its artifact/manifest are passed on every call rather than
 * looked up from a stored id — choosing which profile and published
 * artifact to act on is FX-BE-060's UI concern, not this surface's.
 */
export interface DeploymentsIpc {
  // ── Profiles (TASK-151/159) ──────────────────────────────────────────
  /** Every profile saved for a project. */
  listProfiles(projectId: string): Promise<DeploymentProfile[]>;
  getProfile(projectId: string, profileId: string): Promise<{ profile?: DeploymentProfile; issues: DeploymentProfileIssue[] }>;
  /** Rejects an invalid profile with its errors rather than persisting it. */
  saveProfile(projectId: string, profile: DeploymentProfile): Promise<DeploymentProfile>;
  /** Live validation for the editor — no persistence. */
  validateProfile(profile: DeploymentProfile): Promise<{ valid: boolean; errors: DeploymentProfileIssue[] }>;
  /** "Can this build, right now, actually run this" — unsupported executor/target kinds, distinct from a structural error. */
  preflightCapabilities(profile: DeploymentProfile): Promise<DeploymentProfileIssue[]>;
  /** Whether each credential the profile names is currently bound in the local secret store — never the credential's value. */
  evaluateCredentials(profile: DeploymentProfile): Promise<{ statuses: CredentialBindingStatus[]; allBound: boolean }>;

  // ── Artifacts (TASK-160) ─────────────────────────────────────────────
  /** Hashes `rootDir` and records the resulting immutable `PublishedArtifact`. Refuses to replace an existing artifact id. */
  publishArtifact(
    artifactId: string,
    deploymentProfileId: string,
    rootDir: string,
    sourceCommit?: WorkflowEvidenceSourceRef
  ): Promise<{ artifact: PublishedArtifact; manifest: PublishManifest }>;
  /** Artifacts published under one profile, newest first. */
  listArtifacts(deploymentProfileId: string): Promise<Array<{ artifact: PublishedArtifact; manifest: PublishManifest }>>;
  /** Every artifact published on this machine, newest first — for picking one to promote to a different profile. */
  listAllArtifacts(): Promise<Array<{ artifact: PublishedArtifact; manifest: PublishManifest }>>;
  getArtifact(artifactId: string): Promise<{ artifact: PublishedArtifact; manifest: PublishManifest } | undefined>;

  // ── Runs (TASK-158/160) ──────────────────────────────────────────────
  /**
   * Creates and persists a fresh run in `prepared` status. `context` is the
   * optional linking data TASK-160 adds to `DeploymentRun` (issue, workflow
   * run, target URL) — set once, immutable thereafter.
   */
  prepare(
    projectId: string,
    runId: string,
    profile: DeploymentProfile,
    artifact: PublishedArtifact,
    context?: { issueKey?: string; issueConnectionId?: string; workflowRunId?: string; targetUrl?: string }
  ): Promise<DeploymentRun>;
  /** Requests then grants approval; idempotent — re-approving an already-queued run changes nothing. */
  approve(
    projectId: string,
    runId: string,
    profile: DeploymentProfile,
    artifact: PublishedArtifact,
    actor: string
  ): Promise<{ run: DeploymentRun; ok: boolean; reason?: string }>;
  /**
   * Dispatches the deploy. Only ever actually invokes the executor once per
   * run — a repeated call, whether from a double click or a reconnected UI
   * re-sending the action, is refused with a reason rather than dispatching
   * again. `options` covers a `directory` target's exclude/backup/staging
   * paths and a `local-process` target's extra script inputs and timeout.
   */
  deploy(
    projectId: string,
    runId: string,
    profile: DeploymentProfile,
    artifact: PublishedArtifact,
    manifest: PublishManifest,
    options?: {
      excludePaths?: string[];
      backupDir?: string;
      stagingDir?: string;
      processInputs?: Record<string, string>;
      timeoutMs?: number;
      healthCheckHost?: string;
      healthCheckPort?: number;
    }
  ): Promise<{ dispatched: boolean; run: DeploymentRun; reason?: string }>;
  getRun(runId: string): Promise<DeploymentRun | undefined>;
  /** A profile's runs, newest first. */
  listRuns(deploymentProfileId: string): Promise<DeploymentRun[]>;
  /** A read-only summary of a run's last recorded health outcome. */
  health(runId: string): Promise<DeploymentHealthResult>;
  /**
   * Restores the previous version for a `directory` target. Refused for any
   * other target kind — the reason is returned, and the attempt itself is
   * still recorded on the run (`rollback-started` followed by
   * `rollback-failed`), never silently dropped.
   */
  rollback(
    projectId: string,
    runId: string,
    profile: DeploymentProfile,
    options?: { backupDir?: string; excludePaths?: string[] }
  ): Promise<{ rolledBack: boolean; run: DeploymentRun; reason?: string }>;
}

/**
 * Governed delivery workflows (FX-BF-012). Definitions and policy live in app
 * storage (global) or a project's `.praxis/workflows` folder (project); the
 * designer edits project-scoped definitions and reads the template library and
 * live validation from here.
 */
export interface WorkflowsIpc {
  /**
   * The template library offered to a project: built-in, then the user's
   * globals, then the project's committed definitions. Not collapsed by id.
   */
  listTemplates(projectId: string): Promise<WorkflowTemplate[]>;
  /**
   * The project's cached template recommendation, if any — a free read
   * (`ProjectRecord.recommendedWorkflowTemplate`), never an AI call. The New
   * Workflow dialog reads this on open; only `recommendTemplate` spends money.
   */
  getRecommendedTemplate(projectId: string): Promise<StoredTemplateRecommendation | undefined>;
  /**
   * Asks the configured AI which offered template best fits this project
   * (from its name/purpose/brief), then persists the answer onto the project
   * record so `getRecommendedTemplate` can hand it back for free afterwards —
   * see `ProjectStore.setRecommendedWorkflowTemplate`. Rejects when no
   * gateway-backed provider is configured. Every call is logged to the AI
   * usage ledger, tagged `workflow-template-recommendation`.
   */
  recommendTemplate(projectId: string): Promise<TemplateRecommendationResult>;
  /**
   * Asks the configured AI which model tier each agent stage of this (possibly unsaved) definition
   * needs. Read-only: it changes nothing stored — the designer applies the answer to its draft. Every
   * call is logged to the AI usage ledger, tagged `workflow-model-recommendation`.
   */
  recommendModelTiers(projectId: string, definition: WorkflowDefinition): Promise<ModelTierRecommendationResult>;
  /** Per-template readiness against the live Agent Hub catalog. */
  templateReadiness(projectId: string): Promise<TemplateReadiness[]>;
  /** The resolved run catalog for a project, with shadowing and invalid entries. */
  catalog(projectId: string): Promise<WorkflowCatalog>;
  /** One project-scoped definition by id, or undefined. */
  get(projectId: string, workflowId: string): Promise<WorkflowDefinition | undefined>;
  /**
   * Copies a template into the project as a new project-scoped definition and
   * saves it. Returns the saved copy.
   */
  instantiate(projectId: string, templateId: string, name?: string): Promise<WorkflowDefinition>;
  /** Promotes a discovered Markdown workflow pack into a governed project workflow. */
  promotePack(
    projectId: string,
    packId: string,
    binding: { agentId: string; profileId?: string; hostId?: string }
  ): Promise<WorkflowDefinition>;
  /** Saves a project-scoped definition; rejects an invalid one with its errors. */
  save(projectId: string, definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  /** Removes a project-scoped definition. */
  remove(projectId: string, workflowId: string): Promise<void>;
  /** Live validation for the designer — no persistence. */
  validate(projectId: string, definition: WorkflowDefinition): Promise<WorkflowValidationResult>;
  /** The designer's constrained assistant: workflow questions, validation, and workflow edits only. */
  assistant(
    projectId: string,
    definition: WorkflowDefinition,
    message: string,
    history?: readonly WorkflowAssistantMessage[]
  ): Promise<WorkflowAssistantResult>;
  /** The composed policy governing this project, strictest-wins over global. */
  effectivePolicy(projectId: string): Promise<WorkflowPolicyProfile | undefined>;
  /** Every stored policy profile, global and project-scoped, across all projects. */
  listPolicies(): Promise<WorkflowPolicyProfile[]>;
  /** Creates or updates a policy profile; rejects an invalid scope/projectId pairing. */
  savePolicy(profile: WorkflowPolicyProfile): Promise<WorkflowPolicyProfile>;
  /** Removes a policy profile. */
  removePolicy(profileId: string): Promise<void>;

  // ── Runs (FX-BE-022) ────────────────────────────────────────────────────
  /**
   * Starts a run of one project workflow against a task; returns the new run's
   * summary. `issue`, when given, ties the run to a tracker ticket: its
   * outcome is written back to that ticket as a comment once the run settles
   * (succeeded, failed, or cancelled) — see `WorkflowRun.issueKey`. Omit for
   * an ordinary project-scoped run with nothing to write back to.
   */
  projectTrust(projectId: string, workflowId: string): Promise<{ trusted: boolean; fingerprint: string; commands: string[] }>;
  approveProjectTrust(projectId: string, workflowId: string, fingerprint: string): Promise<void>;
  startRun(
    projectId: string,
    workflowId: string,
    taskTitle: string,
    issue?: { issueKey: string; connectionId?: string },
    controller?: { sessionKey: string; sessionId: string },
    planInput?: WorkflowPlanInput,
    /** Options for the run: permissionMode, AI provider and AI model. */
    options?: {
      permissionMode?: WorkflowPermissionMode;
      aiProvider?: AiProvider;
      aiModel?: string;
      /** Proceed although the checkout has uncommitted product changes: include them, or omit them. */
      uncommittedChanges?: WorkflowUncommittedChanges;
      /** When a stage's AI runs out of budget: ask (default), switch AI automatically, or stop. */
      providerLimitPolicy?: WorkflowProviderLimitPolicy;
      /** Values for the workflow's `parameters`; checked by `resolveRunParameters`, fixed for the run. */
      parameters?: Record<string, string | number>;
    }
  ): Promise<WorkflowRunSummary>;
  /**
   * What starting this workflow involves, before anything is created: the parameters it asks
   * for and the worst-case launches (and, where this machine has measured enough stage
   * sessions, a token/spend range) given `parameters`. Read-only.
   */
  prepareRun(
    projectId: string,
    workflowId: string,
    parameters?: Record<string, string | number>
  ): Promise<{ parameters: WorkflowRunParameter[]; requiresMeasurableGoal: boolean; estimate: RunEstimate; issues: RunParameterIssue[] }>;
  /**
   * Product files with uncommitted changes that a new run's worktree would silently omit
   * (Praxis metadata excluded). Empty means a run can start; use it to warn before creating anything.
   */
  checkRunBase(projectId: string): Promise<{ blockingFiles: string[] }>;
  /** Commits exactly the files `checkRunBase` reports, so the run can start from a clean checkout. */
  commitRunBase(projectId: string, message: string): Promise<void>;
  /** Makes one of this session's controller runs its active workflow context. */
  selectControllerRun(sessionKey: string, runId: string): Promise<WorkflowRunSummary>;
  /**
   * Cancels one of this session's controller runs if it is still active, then
   * detaches it from the session. Falls back to another remaining run as the
   * active context, or clears the session's workflow context if none remain.
   */
  removeControllerRun(sessionKey: string, runId: string, reason?: string): Promise<void>;
  /** Run summaries for a project, newest first. */
  listRuns(projectId: string): Promise<WorkflowRunSummary[]>;
  /** One run's summary, or undefined. */
  getRun(runId: string): Promise<WorkflowRunSummary | undefined>;
  /** Renames one automation run without changing its workflow definition. */
  renameRun(runId: string, name: string): Promise<WorkflowRunSummary>;
  /**
   * Records a stage outcome. FX-BF-011 will drive stages from real agent
   * sessions; until then the run monitor advances them explicitly, which is
   * also how the E2E suite exercises the engine.
   */
  advanceStage(
    runId: string,
    nodeId: string,
    outcome: 'succeeded' | 'failed',
    /** `findings` records structured findings, for a stage whose outcome routes or gates on them. */
    detail?: { error?: string; snapshotRef?: string; findings?: CheckFindings }
  ): Promise<WorkflowRunSummary>;
  /**
   * Grants approval at the run's approval stage; refuses while a required
   * gate is unmet. `nodeId` targets a specific approval node — required when
   * a workflow has more than one and several are awaiting approval at once;
   * omitted, it resolves to the workflow's only approval node, or the only
   * one currently awaiting.
   */
  approveRun(runId: string, actor: string, note?: string, nodeId?: string): Promise<WorkflowRunSummary>;
  /**
   * Records an attributed gate bypass, when policy and the stage permit one.
   * `nodeId` targets a specific approval node, resolved the same way as
   * `approveRun` when omitted.
   */
  bypassGate(runId: string, gate: string, actor: string, reason: string, nodeId?: string): Promise<WorkflowRunSummary>;
  /** Skips an optional approval (`WorkflowApprovalNode.optional`); what follows it is skipped too. */
  skipApproval(runId: string, nodeId: string, actor: string): Promise<WorkflowRunSummary>;
  /**
   * Answers a loop whose iteration budget ran out (FX-BE-162): `accept` continues past this
   * result (a reason is required), `grant` adds `extraIterations` and goes round again (never
   * past the ceiling), `stop` ends the run (a reason is required). Recorded with `actor`.
   */
  decideLoop(
    runId: string,
    edgeId: string,
    actor: string,
    decision: 'accept' | 'grant' | 'stop',
    reason?: string,
    extraIterations?: number
  ): Promise<WorkflowRunSummary>;
  /** The full written output (report or plan) of a stage, or undefined when it wrote none. */
  stageReport(runId: string, nodeId: string): Promise<string | undefined>;
  /** Asks where to save a stage's written output as Markdown, and saves it there. */
  saveStageReport(runId: string, nodeId: string): Promise<{ saved: boolean; path?: string }>;
  /** Queues a failed stage for another attempt within its budget. */
  retryStage(runId: string, nodeId: string): Promise<WorkflowRunSummary>;
  /** Moves a stage whose AI ran out of budget to another AI and optional model; a paused stage goes again on it. */
  switchStageProvider(runId: string, nodeId: string, provider: AiProvider, model?: string): Promise<WorkflowRunSummary>;
  /** Ends the run because a stage's AI ran out of budget. */
  stopForProviderLimit(runId: string, nodeId: string): Promise<WorkflowRunSummary>;
  /** Starts a new delivery revision and replays the selected stage's downstream path. */
  reworkStage(runId: string, nodeId: string): Promise<WorkflowRunSummary>;
  /** Cancels a run. */
  cancelRun(runId: string, reason?: string): Promise<WorkflowRunSummary>;
  /**
   * What a run has left in the repository — its branch and any live worktree — i.e. what deleting
   * the run's *work* would lose. Read-only; call it before offering a delete.
   */
  inspectRunWork(runId: string): Promise<WorkflowRunWorkInfo>;
  /**
   * Deletes a run: cancels it first if still live, then removes the run, its
   * stage sessions, and its link from the controller session.
   *
   * The run's branch is **kept** unless `deleteWork` is true — the branch is where the work is, and
   * deleting a record must not decide that silently. Uncommitted changes in a live worktree are
   * kept as a commit on the branch. With `deleteWork` the worktree and branch are removed too.
   */
  deleteRun(runId: string, options?: { deleteWork?: boolean }): Promise<void>;
  /**
   * Archives or restores a workflow run. Live runs cannot be archived.
   */
  archiveRun(runId: string, archived: boolean): Promise<WorkflowRunSummary>;
  /**
   * Fires with a run id after every persisted transition — the orchestrator
   * advancing a stage in the background included. Returns an unsubscribe.
   */
  onRunChanged(listener: (runId: string) => void): () => void;
  /**
   * The cached agent recommendation for one stage, if any — a free read, not
   * an AI call. `stale: true` means the stage's name/instructions/candidates
   * have changed since `recommendAgent` last computed it; the caller decides
   * whether to offer a refresh, this never recomputes on its own.
   */
  getRecommendation(
    workflowId: string,
    nodeId: string,
    input: { stageName: string; instructions: string; candidates: AgentRecommendationCandidate[] }
  ): Promise<{ recommendation: StoredAgentRecommendation | undefined; stale: boolean }>;
  /**
   * Asks the configured AI which of the given trusted agents best fits one
   * agent-task stage, from its name/instructions alone, and caches the
   * answer against `workflowId`/`nodeId` (see `getRecommendation`) so the
   * same stage never triggers a second call just from being reopened —
   * only an explicit "Recommend" or "Refresh" click in the designer reaches
   * this. Rejects when no gateway-backed provider is configured — the
   * caller only offers the action once `ai.listProviderStatuses()` shows
   * one is, so a rejection here means the configuration changed mid-flight.
   * Every call is logged to the AI usage ledger (`aiUsage`), tagged
   * `workflow-recommendation`.
   */
  recommendAgent(
    workflowId: string,
    nodeId: string,
    input: { stageName: string; instructions: string; candidates: AgentRecommendationCandidate[] }
  ): Promise<AgentRecommendationResult>;
  /**
   * Drops the cached agent recommendation for one stage — e.g. when the user
   * applies or dismisses it so they aren't repeatedly prompted.
   */
  clearRecommendation(workflowId: string, nodeId: string): Promise<void>;
  /**
   * Reads back the retained evidence for one stage attempt (FX-BE-051).
   * `entry` is undefined when nothing was ever captured for that attempt — a
   * stage that hasn't run, or one from before this capability shipped; that
   * is `unavailable`, not `expired`. `content` is withheld once `expired` is
   * true, even though the entry itself still says `present` — retention is
   * enforced on read here, not only by a future reclaim sweep.
   */
  getEvidence(runId: string, nodeId: string, attempt: number): Promise<WorkflowEvidenceView>;
  /**
   * Starts a diagnosis session from a stage attempt's retained evidence
   * (FX-BE-052). A refused preflight (no working folder, a read-only
   * session, or no retained evidence) returns `ok: false` with the reason —
   * no session opens just to discover it has nothing to work from.
   */
  startDiagnosis(runId: string, nodeId: string, attempt: number): Promise<CreateDiagnosisSessionResult>;
}

export interface WorkflowAssistantMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface WorkflowAssistantResult {
  action: 'answer' | 'updated' | 'rejected';
  message: string;
  workflow?: WorkflowDefinition;
}

/** One stage attempt's retained evidence, as read back through `WorkflowsIpc.getEvidence`. */
export interface WorkflowEvidenceView {
  entry?: WorkflowEvidenceEntry;
  /** Present only when `entry.presence === 'present'` and `expired` is false. */
  content?: string;
  expired: boolean;
}

/** Discovery and skill-registry status for the desktop runtime. */
export interface AgentRuntimeIpc {
  list(): Promise<AgentRuntimeSnapshot>;
  refresh(): Promise<AgentRuntimeSnapshot>;
  start(agentId: string): Promise<AgentRuntimeSnapshot>;
  /** Disposes the agent's host and clears its lifecycle state. */
  stop(agentId: string): Promise<AgentRuntimeSnapshot>;
  /** Disposes then recreates the agent's host. */
  restart(agentId: string): Promise<AgentRuntimeSnapshot>;
  /** The discovery roots for each scope — shown read-only in advanced Settings. */
  roots(): Promise<{
    agents: Record<CatalogScope, string>;
    runtimeHosts: Record<CatalogScope, string>;
    profiles: Record<CatalogScope, string>;
    skills: Record<CatalogScope, string>;
  }>;
  activateSkill(agentId: string, skillName: string): Promise<ActivatedSkill>;
  /** Writes a new agent folder in the chosen scope; rejects on validation failure. */
  createAgent(input: NewAgentInput): Promise<AgentRuntimeSnapshot>;
  /** Writes a provider-neutral AGENT.md profile. */
  createProfile(input: NewAgentProfileInput): Promise<AgentRuntimeSnapshot>;
  /** Writes a new skill package in the chosen scope; rejects on validation failure. */
  createSkill(input: NewSkillInput): Promise<AgentRuntimeSnapshot>;
  /** Reads and validates an on-disk agent/skill folder for a target scope, without copying or running it. */
  previewImport(kind: 'agent' | 'profile' | 'skill', sourceDir: string, scope: CatalogScope): Promise<ImportPreview>;
  /** Copies a validated agent/skill folder into the scope; rejects on validation failure or an unresolved duplicate. */
  importItem(
    kind: 'agent' | 'profile' | 'skill',
    sourceDir: string,
    scope: CatalogScope,
    onDuplicate: 'block' | 'rename'
  ): Promise<AgentRuntimeSnapshot>;
  /** Trusts (or stops trusting) the agents, skills and instruction files other AI tools keep in a project. */
  approveNativeProject(projectRoot: string, approved: boolean): Promise<AgentRuntimeSnapshot>;
  /** Shows a discovered agent, skill or instruction file in Finder / Explorer. */
  revealNative(itemPath: string): Promise<void>;
  /** Copies an agent or skill found in another AI tool's folder into Praxis's global folder. */
  copyNative(kind: 'agent' | 'skill', id: string): Promise<AgentRuntimeSnapshot>;
}

// ── Integrated terminal ─────────────────────────────────────────────────────

export interface CreateTerminalInput {
  cwd?: string;
  cols: number;
  rows: number;
  profileId?: string;
  /** Reuse an active matching terminal during automatic panel initialisation. */
  reuseExisting?: boolean;
}

export interface TerminalProfile {
  id: string;
  name: string;
  shell: string;
  isDefault: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  profileId: string;
  profileName: string;
  hasContext: boolean;
  exited: boolean;
  lastCommand?: TerminalCommandRecord;
}

export interface TerminalCommandRecord {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  output: string;
  status: 'running' | 'success' | 'failed';
}

export interface TerminalCommandEvent {
  sessionId: string;
  command: TerminalCommandRecord;
}

export interface TerminalContext {
  sessionId: string;
  cwd: string;
  /** ANSI-free recent output, capped main-side before it crosses IPC. */
  output: string;
  capturedAt: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface TerminalContextAvailabilityEvent {
  sessionId: string;
  terminalHasContext: boolean;
}

export interface TerminalIpc {
  listProfiles(): Promise<TerminalProfile[]>;
  list(): Promise<TerminalSessionInfo[]>;
  create(input: CreateTerminalInput): Promise<TerminalSessionInfo>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  kill(sessionId: string): Promise<void>;
  /** Raw xterm stream used to redraw a preserved terminal after the panel reopens. */
  getBuffer(sessionId: string): Promise<string>;
  getContext(sessionId: string): Promise<TerminalContext>;
  listCommands(sessionId: string): Promise<TerminalCommandRecord[]>;
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onContextAvailability(listener: (event: TerminalContextAvailabilityEvent) => void): () => void;
  onCommand(listener: (event: TerminalCommandEvent) => void): () => void;
}

export interface GitIpc {
  preflight(repositoryPath?: string): Promise<GitRepositoryPreflight>;
  initialize(repositoryPath: string): Promise<GitRepositoryPreflight>;
  clone(repositoryUrl: string, targetParent: string, targetName?: string): Promise<GitRepositoryPreflight>;
  open(repositoryPath: string): Promise<GitRepositorySnapshot>;
  refresh(repositoryPath: string): Promise<GitRepositorySnapshot>;
  status(repositoryPath: string): Promise<GitStatusSnapshot>;
  getCommit(repositoryPath: string, hash: string): Promise<GitCommitDetails>;
  getDiff(repositoryPath: string, hash: string, filePath?: string): Promise<GitDiffResult>;
  getComparison(repositoryPath: string, request: GitDiffRequest): Promise<GitDiffDocument>;
  applyHunk(repositoryPath: string, request: GitHunkActionRequest): Promise<GitStatusSnapshot>;
  stage(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  unstage(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  discard(repositoryPath: string, paths: string[]): Promise<GitStatusSnapshot>;
  commit(repositoryPath: string, message: string): Promise<GitRepositorySnapshot>;
  createBranch(repositoryPath: string, name: string, startPoint?: string): Promise<GitRepositorySnapshot>;
  checkout(repositoryPath: string, name: string): Promise<GitRepositorySnapshot>;
  deleteBranch(repositoryPath: string, name: string): Promise<GitRepositorySnapshot>;
  renameBranch(repositoryPath: string, oldName: string, newName: string): Promise<GitRepositorySnapshot>;
  merge(repositoryPath: string, source: string): Promise<GitRepositorySnapshot>;
  rebase(repositoryPath: string, target: string): Promise<GitRepositorySnapshot>;
  getConflict(repositoryPath: string, path: string): Promise<GitConflictFile>;
  resolveConflict(repositoryPath: string, path: string, resolution: GitConflictResolution): Promise<GitStatusSnapshot>;
  abortConflict(repositoryPath: string): Promise<GitRepositorySnapshot>;
  getFileContent(repositoryPath: string, path: string): Promise<GitFileContent>;
  getFileHistory(repositoryPath: string, path: string, ref?: string): Promise<GitFileHistoryEntry[]>;
  getBlame(repositoryPath: string, path: string, ref?: string): Promise<GitBlameLine[]>;
  cherryPick(repositoryPath: string, commit: string): Promise<GitRepositorySnapshot>;
  revert(repositoryPath: string, commit: string): Promise<GitRepositorySnapshot>;
  stash(repositoryPath: string, message?: string): Promise<GitRepositorySnapshot>;
  popStash(repositoryPath: string): Promise<GitRepositorySnapshot>;
  pull(repositoryPath: string): Promise<GitRepositorySnapshot>;
  fetch(repositoryPath: string): Promise<GitRepositorySnapshot>;
  push(repositoryPath: string): Promise<GitRepositorySnapshot>;
}

// ── Task Designer ────────────────────────────────────────────────────────────

/** How a dropped issue relates to the main dropped issue (drives connector direction). */
export type TaskDesignerRelatedIssueRelation = 'dependsOn' | 'subTask';

export interface TaskDesignerResolvedIssueRelation {
  relation: TaskDesignerRelatedIssueRelation;
  sourceIssueKey: string;
  targetIssueKey: string;
}

/** Node payload without position/type — what the backend returns for one issue. */
export type TaskDesignerIssueNodePayload = Omit<TaskDesignerTicketNode, 'id' | 'x' | 'y' | 'type'>;

/**
 * Result of dropping an issue key onto the canvas: the main issue plus every
 * resolvable dependsOn/subTask neighbour, with the directed relations the
 * renderer turns into connectors.
 */
export interface TaskDesignerResolvedDroppedIssue {
  mainIssue: TaskDesignerIssueNodePayload;
  relatedIssues: Array<TaskDesignerIssueNodePayload & { relation: TaskDesignerRelatedIssueRelation }>;
  relations: TaskDesignerResolvedIssueRelation[];
}

/**
 * Outcome of persisting a canvas state. `ok:false` means the stored state did
 * NOT change to what was sent — `state` carries the corrective state the
 * renderer must adopt (normalization repair, or the previously persisted state
 * on a graph validation failure).
 */
export interface TaskDesignerSetStateResult {
  ok: boolean;
  warning?: string;
  state: TaskDesignerPersistedState;
}

/** Board-flow recommendation: the seeded nodes plus the gateway's ordering. */
export interface TaskDesignerBoardFlowRecommendation {
  boardName: string;
  nodes: TaskDesignerRecommendationNode[];
  recommendation: TaskDesignerFlowRecommendation;
}

/** Where the generated master-plan artifacts landed. */
export interface TaskDesignerMasterPlanResult {
  outputPath: string;
  generatedFeaturesPath: string;
  generatedFeatureCount: number;
  generatedStoryCount: number;
  fingerprint: string;
}

/**
 * Task Designer slice: canvas persistence plus the host-owned operations
 * (issue resolution for drops, AI flow recommendations, master-plan file
 * generation). Canvas state is scoped per connection+board. Operational
 * failures reject the promise (the renderer shows the message); only
 * `setState` uses a result envelope because it also carries corrective state.
 */
export interface TaskDesignerIpc {
  /** Loads the persisted canvas state (normalized + repaired on the way out). */
  getState(boardId: string, connectionId?: string): Promise<TaskDesignerPersistedState>;
  /** Persists a canvas state; rejects invalid payloads with corrective state. */
  setState(
    boardId: string,
    connectionId: string | undefined,
    state: TaskDesignerPersistedState
  ): Promise<TaskDesignerSetStateResult>;
  /** Resolves an issue key (drop target) plus its dependsOn/subTask neighbours. */
  resolveIssue(issueKey: string, connectionId?: string): Promise<TaskDesignerResolvedDroppedIssue>;
  /** AI flow recommendation over the current canvas ticket nodes. */
  recommendFlow(
    nodes: TaskDesignerRecommendationNode[],
    connectors: TaskDesignerRecommendationConnector[]
  ): Promise<TaskDesignerFlowRecommendation>;
  /** AI flow recommendation seeded from every issue on a board. */
  recommendBoardFlow(board: Board): Promise<TaskDesignerBoardFlowRecommendation>;
  /** Writes plans/master-plan.md + generated feature/story files under the working directory. */
  generateMasterPlan(
    boardId: string,
    connectionId: string | undefined,
    state: TaskDesignerPersistedState
  ): Promise<TaskDesignerMasterPlanResult>;
}
