import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, AppSettingsPatch, BoardsSidebarMode, Connection } from '@ticket-manager/core';
import {
  DEFAULT_APP_SETTINGS,
  normalizePriorityColor,
  PRIORITY_NAMES
} from './settingsDefaults';
import { Icon, type IconName } from './Icon';
import { useSettings } from './useSettings';

type SettingsCategory =
  | 'overview'
  | 'connections'
  | 'jira'
  | 'performance'
  | 'delivery'
  | 'mcp'
  | 'preview'
  | 'appearance';

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
    icon: 'star',
    description: 'Colors used by ticket cards to indicate priority.'
  }
];

interface SettingsPageProps {
  connections: Connection[];
  onOpenConnections: () => void;
}

export function SettingsPage({ connections, onOpenConnections }: SettingsPageProps) {
  const [active, setActive] = useState<SettingsCategory>('overview');
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
        {active === 'performance' && <PerformanceSection settings={settings} update={update} />}
        {active === 'delivery' && <DeliverySection settings={settings} update={update} />}
        {active === 'mcp' && <McpSection settings={settings} update={update} />}
        {active === 'preview' && <PreviewSection settings={settings} update={update} />}
        {active === 'appearance' && <AppearanceSection settings={settings} update={update} />}
      </div>
    </div>
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
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
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
