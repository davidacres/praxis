import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AiProvider,
  AiProviderStatus,
  CustomProviderConfig,
  LocalRuntimeDetection,
  ProviderPreset,
  ProviderProbeResult,
  ProviderProbeStepId
} from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';

/**
 * Settings → AI Providers → Add provider (FX-BF-044): one dialog with two
 * pages — the catalog, and the form an OpenAI-compatible endpoint is created
 * or edited with (connection test beside it). Built from the existing modal,
 * button and ChipSelect primitives — no new control types.
 */

/** A built-in provider as the catalog shows it. */
export interface BuiltInCatalogEntry {
  id: AiProvider;
  kind: 'api' | 'cli-agent';
  label: string;
}

/** An existing endpoint opened for editing from its provider page. */
export interface EndpointEditTarget {
  config: CustomProviderConfig;
  defaultModel: string;
  keySaved: boolean;
}

/**
 * Local copies of core's `isInsecureRemoteUrl` / `normalizeApiPath`: the
 * renderer may import only types from core (root AGENTS.md). Main validates
 * again on save, so these only drive what the form shows.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
function normalizeApiPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** "http://localhost:11434" + "/v1" → "localhost:11434/v1" — what a provider's subline shows. */
export function endpointDisplayUrl(config: Pick<CustomProviderConfig, 'baseUrl' | 'apiPath'>): string {
  return `${config.baseUrl.replace(/^https?:\/\//, '')}${config.apiPath}`;
}

export const PROBE_STEP_LABELS: Record<ProviderProbeStepId, string> = {
  models: 'Reachable, key accepted',
  chat: 'Chat',
  streaming: 'Streaming with token usage',
  tools: 'Tool calling'
};

/** One line under each built-in in the catalog. */
const BUILT_IN_NOTES: Partial<Record<string, string>> = {
  openai: 'GPT models with your OpenAI key',
  anthropic: 'Claude models with your Anthropic key',
  gemini: 'Gemini models with your Google AI key',
  'z-ai': 'GLM models · coding plan or pay-as-you-go',
  'vercel-gateway': 'One key for many vendors · routing and spend controls',
  'claude-code-cli': 'The Claude Code agent installed on this computer',
  'codex-cli': 'The OpenAI Codex agent installed on this computer',
  'copilot-cli': 'GitHub Copilot with your GitHub login',
  'antigravity-cli': 'The Antigravity agent installed on this computer',
  'cursor-cli': 'The Cursor CLI agent installed on this computer'
};

type CatalogCategory = 'suggested' | 'all' | 'local-agents' | 'cloud' | 'gateways' | 'compatible' | 'this-mac' | 'added';

const CATEGORIES: Array<{ id: CatalogCategory; label: string; heading?: string }> = [
  { id: 'suggested', label: 'Suggested' },
  { id: 'all', label: 'All' },
  { id: 'local-agents', label: 'Local agents', heading: 'By kind' },
  { id: 'cloud', label: 'Cloud APIs' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'compatible', label: 'OpenAI-compatible' },
  { id: 'this-mac', label: 'Run on this Mac' },
  { id: 'added', label: 'Added', heading: 'Yours' }
];

interface CatalogEntry {
  /** `add-provider-tile-<key>`: a built-in id, or `preset-<id>`. */
  key: string;
  logo: string;
  kind: 'api' | 'cli-agent';
  label: string;
  note: string;
  /** Where it sits — drives the category list and search. */
  category: Exclude<CatalogCategory, 'suggested' | 'all' | 'added'>;
  added: boolean;
  /** CLI agents only: the command resolves on this computer. */
  detected?: boolean;
  disabled?: boolean;
  onPick: () => void;
}

const POPULAR_LIMIT = 8;

export function AddProviderDialog({
  builtIns,
  listed,
  statuses,
  presets,
  customProviders,
  detected,
  editing,
  onClose,
  onPickBuiltIn,
  onEndpointSaved
}: {
  builtIns: BuiltInCatalogEntry[];
  /** Providers already on the Providers tab. */
  listed: ReadonlySet<string>;
  statuses: AiProviderStatus[];
  presets: ProviderPreset[];
  customProviders: readonly CustomProviderConfig[];
  /** Local runtimes answering right now; undefined while the probe runs. */
  detected?: readonly LocalRuntimeDetection[];
  /** Open straight on the endpoint form, editing this endpoint. */
  editing?: EndpointEditTarget;
  onClose: () => void;
  onPickBuiltIn: (id: AiProvider) => void;
  onEndpointSaved: (config: CustomProviderConfig) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CatalogCategory>('suggested');
  const [endpoint, setEndpoint] = useState<{ preset: ProviderPreset; baseUrl?: string; autoTest?: boolean }>();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing && !endpoint) searchRef.current?.focus();
  }, [editing, endpoint]);

  const entries = useMemo<CatalogEntry[]>(() => {
    const out: CatalogEntry[] = [];
    for (const entry of builtIns) {
      const status = statuses.find(candidate => candidate.provider === entry.id);
      const added = listed.has(entry.id);
      const detectedCli = entry.kind === 'cli-agent' && status?.configured === true;
      out.push({
        key: entry.id,
        logo: entry.id,
        kind: entry.kind,
        label: entry.label.replace(/\s*\(local\)$/, ''),
        note: added
          ? 'Added'
          : entry.kind === 'cli-agent'
            ? detectedCli ? 'Detected on PATH' : 'Not found on PATH'
            : BUILT_IN_NOTES[entry.id] ?? 'API key required',
        category: entry.id === 'vercel-gateway' ? 'gateways' : entry.kind === 'api' ? 'cloud' : 'local-agents',
        added,
        detected: detectedCli,
        disabled: added,
        onPick: () => onPickBuiltIn(entry.id)
      });
    }
    for (const preset of presets) {
      if (preset.group === 'custom') continue;
      const count = customProviders.filter(provider => provider.presetId === preset.id).length;
      out.push({
        key: `preset-${preset.id}`,
        logo: preset.id,
        kind: 'api',
        label: preset.label,
        note: count > 0 ? `Added · add another for a second host or key` : preset.note,
        category: preset.group === 'gateway' ? 'gateways' : preset.group === 'local' ? 'this-mac' : 'compatible',
        added: count > 0,
        onPick: () => setEndpoint({ preset })
      });
    }
    return out;
  }, [builtIns, statuses, listed, presets, customProviders, onPickBuiltIn]);

  const customPreset = presets.find(preset => preset.id === 'custom');
  const editingPreset = editing ? presets.find(preset => preset.id === editing.config.presetId) : undefined;

  if (editing || endpoint) {
    return (
      <DialogShell label={editing ? `Edit ${editing.config.label}` : 'Connect an OpenAI-compatible server'} onClose={onClose} wide>
        <CustomEndpointForm
          key={editing?.config.id ?? endpoint?.preset.id}
          initial={editing?.config}
          preset={editing ? editingPreset : endpoint?.preset}
          baseUrlOverride={endpoint?.baseUrl}
          autoTest={endpoint?.autoTest}
          defaultModel={editing?.defaultModel}
          keySaved={editing?.keySaved}
          onBack={editing ? undefined : () => setEndpoint(undefined)}
          onCancel={onClose}
          onSaved={onEndpointSaved}
        />
      </DialogShell>
    );
  }

  const needle = query.trim().toLowerCase();
  const categoryLabel = (entry: CatalogEntry) => CATEGORIES.find(item => item.id === entry.category)?.label ?? '';
  const matches = (entry: CatalogEntry) =>
    `${entry.label} ${entry.note} ${categoryLabel(entry)} ${entry.category === 'this-mac' ? 'local runtime' : ''} ${entry.kind === 'cli-agent' ? 'cli agent local' : ''}`
      .toLowerCase().includes(needle);
  const byAddedLast = (a: CatalogEntry, b: CatalogEntry) => Number(a.added) - Number(b.added);
  const inCategory = (id: CatalogCategory) => entries.filter(entry =>
    id === 'all' ? true : id === 'added' ? entry.added : entry.category === id
  ).sort(byAddedLast);
  const count = (id: CatalogCategory) => inCategory(id).length;

  const foundCli = entries.filter(entry => entry.kind === 'cli-agent' && entry.detected && !entry.added);
  const foundServers = (detected ?? []).filter(item => !customProviders.some(provider => provider.presetId === item.presetId));
  const popular = [
    ...entries.filter(entry => entry.category === 'cloud' && !entry.added),
    ...entries.filter(entry => entry.category === 'compatible' && !entry.added)
  ].slice(0, POPULAR_LIMIT);
  const popularTotal = entries.filter(entry => (entry.category === 'cloud' || entry.category === 'compatible') && !entry.added).length;
  const gateways = inCategory('gateways');

  return (
    <DialogShell label="Add provider" onClose={onClose} wide>
      <div className="modal-header aip-dialog-head">
        <div className="aip-dialog-heading">
          <h3>Add a provider</h3>
          <p className="aip-muted">Connect a cloud API, a local agent, or any OpenAI-compatible server.</p>
          <label className="aip-catalog-search">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              className="input"
              type="search"
              aria-label="Search providers"
              placeholder={`Search ${entries.length} providers — try “groq” or “local”`}
              data-testid="add-provider-search"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        </div>
        <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="aip-catalog">
        <nav className="aip-catalog-nav" aria-label="Provider categories">
          {CATEGORIES.map(item => (
            <div key={item.id}>
              {item.heading && <div className="aip-catalog-nav-heading">{item.heading}</div>}
              <button
                type="button"
                className={`aip-catalog-nav-item${!needle && category === item.id ? ' is-active' : ''}`}
                aria-current={!needle && category === item.id ? 'true' : undefined}
                data-testid={`add-provider-category-${item.id}`}
                onClick={() => { setQuery(''); setCategory(item.id); }}
              >
                <span>{item.label}</span>
                {item.id !== 'suggested' && <span className="aip-muted">{count(item.id)}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="aip-catalog-body">
          {needle ? (
            <CatalogGroup title={`Matching “${query.trim()}”`} entries={entries.filter(matches).sort(byAddedLast)}>
              {entries.filter(matches).length === 0 && <p className="aip-hint">Nothing matches. Any server that speaks the OpenAI API works as a custom endpoint.</p>}
            </CatalogGroup>
          ) : category === 'suggested' ? (
            <>
              <section className="aip-catalog-group" aria-label="Found on this Mac">
                <h4 className="aip-card-title"><span>Found on this Mac</span>{!detected && <span className="aip-card-aside aip-muted">Looking…</span>}</h4>
                {foundCli.length + foundServers.length === 0 ? (
                  <p className="aip-hint">{detected ? 'No local agent or model server found that isn’t already added. Install one and it shows up here.' : 'Checking for local agents and model servers…'}</p>
                ) : (
                  <div className="aip-found-grid">
                    {foundCli.map(entry => (
                      <div key={entry.key} className="aip-found" data-testid={`add-provider-found-${entry.key}`}>
                        <CatalogMark entry={entry} size={30} />
                        <div className="aip-found-text"><strong>{entry.label}</strong><span className="aip-muted">Installed · uses its own sign-in</span></div>
                        <button type="button" className="btn btn-compact aip-accent-btn" data-testid={`add-provider-tile-${entry.key}`} onClick={entry.onPick}>
                          <Icon name="plus" size={11} />Add
                        </button>
                      </div>
                    ))}
                    {foundServers.map(item => {
                      const preset = presets.find(candidate => candidate.id === item.presetId);
                      return (
                        <div key={item.presetId} className="aip-found" data-testid={`add-provider-found-preset-${item.presetId}`}>
                          <span className="aip-mark"><ProviderBrandLogo provider={item.presetId} size={30} decorative /></span>
                          <div className="aip-found-text">
                            <strong>{item.label}</strong>
                            <span className="aip-muted">{item.baseUrl.replace(/^https?:\/\//, '')} · {item.modelCount} model{item.modelCount === 1 ? '' : 's'}</span>
                          </div>
                          <button
                            type="button"
                            className="btn btn-compact aip-accent-btn"
                            data-testid={`add-provider-detected-${item.presetId}`}
                            disabled={!preset}
                            onClick={() => preset && setEndpoint({ preset, baseUrl: item.baseUrl, autoTest: true })}
                          >
                            <Icon name="plus" size={11} />Add
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
              <CatalogGroup
                title="Popular cloud APIs"
                aside={<>Each needs its own API key · <button type="button" className="aip-link-button" onClick={() => setCategory('all')}>See all {popularTotal} →</button></>}
                entries={popular}
              />
              <CatalogGroup title="Gateways" aside="One key, many model vendors" entries={gateways} />
            </>
          ) : (
            <CatalogGroup title={CATEGORIES.find(item => item.id === category)?.label ?? ''} entries={inCategory(category)}>
              {inCategory(category).length === 0 && <p className="aip-hint">Nothing here yet.</p>}
            </CatalogGroup>
          )}
        </div>
      </div>
      <div className="modal-footer aip-dialog-foot">
        <span className="aip-muted">Not listed? Any server that speaks the OpenAI API works.</span>
        {customPreset && (
          <button type="button" className="btn" data-testid="add-provider-tile-preset-custom" onClick={() => setEndpoint({ preset: customPreset })}>
            <Icon name="plus" size={12} />
            Custom endpoint…
          </button>
        )}
        <span className="aip-spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </DialogShell>
  );
}

function DialogShell({ label, onClose, wide, children }: { label: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-card aip-dialog${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid="add-provider-dialog"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            // Close only this dialog — Settings underneath also closes on Escape (App's document listener).
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

function CatalogMark({ entry, size }: { entry: CatalogEntry; size: number }) {
  return (
    <span className="aip-mark" style={{ width: size, height: size }}>
      <ProviderBrandLogo provider={entry.logo} size={size} decorative />
      {entry.kind === 'cli-agent' && <span className="aip-mark-badge" aria-hidden>›_</span>}
    </span>
  );
}

function CatalogGroup({ title, aside, entries, children }: { title: string; aside?: ReactNode; entries: CatalogEntry[]; children?: ReactNode }) {
  return (
    <section className="aip-catalog-group" aria-label={title}>
      <h4 className="aip-card-title"><span>{title}</span>{aside && <span className="aip-card-aside aip-muted">{aside}</span>}</h4>
      {children}
      <div className="aip-catalog-grid">
        {entries.map(entry => (
          <button
            key={entry.key}
            type="button"
            className={`aip-catalog-row${entry.added ? ' is-added' : ''}`}
            data-testid={`add-provider-tile-${entry.key}`}
            disabled={entry.disabled}
            onClick={entry.onPick}
          >
            <CatalogMark entry={entry} size={28} />
            <span className="aip-catalog-text">
              <strong>{entry.label}</strong>
              <span className={`aip-catalog-note${entry.detected ? ' is-ok' : ''}`}>{entry.note}</span>
            </span>
            {entry.disabled
              ? <span className="chip aip-ok-chip"><Icon name="check" size={10} />Added</span>
              : <span className="aip-catalog-add" aria-hidden>Add <Icon name="arrow-right" size={11} /></span>}
          </button>
        ))}
      </div>
    </section>
  );
}

function FormRow({ label, description, children }: { label: string; description?: ReactNode; stacked?: boolean; children: ReactNode }) {
  return (
    <div className="aip-field">
      <span className="aip-field-label">{label}</span>
      {children}
      {description && <span className="aip-hint">{description}</span>}
    </div>
  );
}

/**
 * Coding Plan quota comes from the Alibaba Cloud console, which only answers a
 * signed-in console session — the plan's chat key is refused. Main hosts that
 * sign-in in its own window and partition; this row only starts it and shows
 * whether a session is held.
 */
function AlibabaConsoleSignIn({ providerId }: { providerId?: AiProvider }) {
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!providerId) return;
    let live = true;
    void window.praxis.aiUsage.alibabaConsoleStatus(providerId).then(result => {
      if (live) setSignedIn(result.signedIn);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [providerId]);

  const run = async (action: () => Promise<{ signedIn: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      setSignedIn((await action()).signedIn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormRow label="Plan usage" description="5-hour, weekly and monthly request quota, read from your Alibaba Cloud console sign-in." stacked>
      <div className="ai-key-controls" data-testid="alibaba-console-signin">
        {!providerId ? (
          <span className="settings-hint">Save this endpoint, then sign in to Alibaba Cloud to show plan quota.</span>
        ) : (
          <>
            <span className="settings-hint" data-testid="alibaba-console-status">
              {signedIn === undefined ? 'Checking…' : signedIn ? 'Signed in to the Alibaba Cloud console' : 'Not signed in'}
            </span>
            <button
              type="button"
              className="btn"
              data-testid="alibaba-console-signin-button"
              disabled={busy}
              onClick={() => void run(() => window.praxis.aiUsage.alibabaConsoleSignIn(providerId))}
            >
              {busy ? 'Waiting for sign-in…' : signedIn ? 'Sign in again' : 'Sign in to Alibaba Cloud'}
            </button>
            {signedIn && (
              <button
                type="button"
                className="btn"
                data-testid="alibaba-console-signout-button"
                disabled={busy}
                onClick={() => void run(() => window.praxis.aiUsage.alibabaConsoleSignOut())}
              >
                Sign out
              </button>
            )}
          </>
        )}
        {error && <span className="settings-hint" role="alert">{error}</span>}
      </div>
    </FormRow>
  );
}

type AuthChoice = 'bearer' | 'none' | 'header';

/**
 * Creates (no `initial`) or edits a custom endpoint. Nothing is written until
 * Save: Test probes the unsaved draft with the typed key, and Save stores the
 * endpoint, its key and default model in one call. The test results sit beside
 * the form so what the server supports is visible while you fill it in.
 */
export function CustomEndpointForm({
  initial,
  preset,
  baseUrlOverride,
  autoTest,
  defaultModel: initialModel,
  keySaved,
  onSaved,
  onBack,
  onCancel
}: {
  initial?: CustomProviderConfig;
  preset?: ProviderPreset;
  /** A detected local runtime answered here rather than at the preset's default. */
  baseUrlOverride?: string;
  /** Run the connection test once on open — a detected runtime needs no key, so there is nothing to fill in first. */
  autoTest?: boolean;
  defaultModel?: string;
  /** A key is already stored for this endpoint. */
  keySaved?: boolean;
  onSaved: (config: CustomProviderConfig) => void;
  onBack?: () => void;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? (preset && preset.id !== 'custom' ? preset.label : ''));
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? baseUrlOverride ?? preset?.baseUrl ?? '');
  const [apiPath, setApiPath] = useState(initial?.apiPath ?? preset?.apiPath ?? '/v1');
  const initialAuth = initial?.auth ?? preset?.auth ?? { kind: 'bearer' as const };
  const [authKind, setAuthKind] = useState<AuthChoice>(initialAuth.kind);
  const [headerName, setHeaderName] = useState(initialAuth.kind === 'header' ? initialAuth.name : 'api-key');
  const [keyDraft, setKeyDraft] = useState('');
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>(
    Object.entries(initial?.headers ?? {}).map(([name, value]) => ({ name, value }))
  );
  const [extraModels, setExtraModels] = useState((initial?.manualModels ?? []).join(', '));
  const [model, setModel] = useState(initialModel ?? '');
  const [retryModel, setRetryModel] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(!initial && preset?.id === 'custom');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProviderProbeResult>();
  const [testedAt, setTestedAt] = useState<number>();
  const [error, setError] = useState<string>();

  const manualModels = extraModels.split(',').map(value => value.trim()).filter(Boolean);
  const draft = (): CustomProviderConfig => ({
    id: initial?.id ?? 'custom:draft',
    label: label.trim() || preset?.label || 'Endpoint',
    ...(initial?.presetId ?? preset?.id ? { presetId: initial?.presetId ?? preset?.id } : {}),
    protocol: 'openai-chat',
    baseUrl: baseUrl.trim(),
    apiPath: normalizeApiPath(apiPath),
    auth: authKind === 'header' ? { kind: 'header', name: headerName.trim() } : { kind: authKind },
    ...(headers.some(row => row.name.trim())
      ? { headers: Object.fromEntries(headers.filter(row => row.name.trim()).map(row => [row.name.trim(), row.value])) }
      : {}),
    ...(manualModels.length > 0 ? { manualModels } : {}),
    ...(initial?.streamUsage === false ? { streamUsage: false } : {})
  });

  // A test result describes one exact target; editing the target invalidates it.
  const targetKey = `${baseUrl}|${apiPath}|${authKind}|${headerName}|${keyDraft}`;
  const testedKey = useRef<string>();
  useEffect(() => {
    if (result && testedKey.current !== targetKey) setResult(undefined);
  }, [targetKey, result]);

  const runTest = async (withModel?: string) => {
    setTesting(true);
    setError(undefined);
    const chosen = (withModel ?? model).trim();
    try {
      const probe = await window.praxis.ai.testCustomProvider(draft(), {
        ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
        ...(chosen ? { model: chosen } : {})
      });
      testedKey.current = targetKey;
      setResult(probe);
      setTestedAt(Date.now());
      if (withModel) setModel(withModel);
      else if (!chosen && probe.capabilities.model) setModel(probe.capabilities.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const autoTested = useRef(false);
  useEffect(() => {
    if (!autoTest || autoTested.current) return;
    autoTested.current = true;
    void runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTest]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const config = draft();
      const { id: _draftId, ...rest } = config;
      const capabilities = result?.capabilities;
      // A previous test result only still describes this endpoint if what it points at is unchanged.
      const sameTarget = initial !== undefined
        && initial.baseUrl === config.baseUrl
        && initial.apiPath === config.apiPath
        && JSON.stringify(initial.auth) === JSON.stringify(config.auth)
        && !keyDraft.trim();
      const saved = await window.praxis.ai.saveCustomProvider({
        config: {
          ...rest,
          ...(initial ? { id: initial.id } : {}),
          ...(capabilities ? { capabilities } : sameTarget && initial?.capabilities ? { capabilities: initial.capabilities } : {}),
          ...(capabilities && capabilities.streaming && !capabilities.streamUsage ? { streamUsage: false } : {})
        },
        ...(authKind !== 'none' && keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
        defaultModel: model.trim()
      });
      setKeyDraft('');
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const listedModels = [...new Set([...(result?.models ?? []), ...manualModels, ...(model.trim() ? [model.trim()] : [])])];
  const insecure = authKind !== 'none' && isInsecureRemoteUrl(baseUrl);
  const canSubmit = Boolean(baseUrl.trim()) && Boolean(label.trim()) && (authKind !== 'header' || Boolean(headerName.trim()));
  const testId = initial ? `custom-endpoint-form-${initial.id}` : 'custom-endpoint-form-new';
  const selectedPresetId = initial?.presetId ?? preset?.id;
  const isBifrost = selectedPresetId === 'bifrost';
  const isMiniMax = selectedPresetId === 'minimax';
  const isOpenRouter = selectedPresetId === 'openrouter';
  const isAlibabaCodingPlan = selectedPresetId === 'alibaba-coding-plan';
  const isAlibaba = isAlibabaCodingPlan || selectedPresetId === 'alibaba-model-studio' || selectedPresetId === 'alibaba-token-plan';
  const chatOnly = result ? !result.capabilities.tools : initial?.capabilities ? !initial.capabilities.tools : false;
  const requestUrl = baseUrl.trim() ? `${baseUrl.trim().replace(/\/+$/, '')}${normalizeApiPath(apiPath)}/chat/completions` : undefined;
  const title = initial ? `Edit ${initial.label}` : preset && preset.id !== 'custom' ? `Connect ${preset.label}` : 'Connect an OpenAI-compatible server';
  const otherModels = listedModels.filter(id => id !== model.trim());

  return (
    <div className="custom-endpoint-form aip-endpoint" data-testid={testId}>
      <div className="modal-header aip-dialog-head">
        {onBack && (
          <button type="button" className="btn-icon" aria-label="Back to the catalog" onClick={onBack}>
            <Icon name="arrow-left" size={13} />
          </button>
        )}
        <div className="aip-dialog-heading">
          <h3>{title}</h3>
          <p className="aip-muted">Any server with <code>/chat/completions</code> — a hosted API, a team proxy, or something running on this Mac.</p>
        </div>
        {onCancel && (
          <button type="button" className="btn-icon" aria-label="Close" onClick={onCancel}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="aip-endpoint-body">
        <div className="aip-endpoint-form">
          {isBifrost && (
            <div className="aip-preset-help" data-testid="bifrost-setup-help">
              Connect to a Bifrost gateway running locally or remotely. Praxis does not install or start the gateway. Enter its URL and virtual key below. Models can use provider prefixes such as <code>openai/gpt-4o-mini</code>, or aliases configured in Bifrost.
              {' '}Manage budgets, rate limits, routing and pricing overrides in Bifrost. Praxis shows token usage and local cost estimates for recognized models; these can differ from gateway costs after caching, fallbacks or custom pricing.
              {' '}<a className="aip-link" href="https://docs.getbifrost.ai/features/governance/budget-and-limits" target="_blank" rel="noreferrer">Budget documentation</a>
              {' · '}<a className="aip-link" href="https://docs.getbifrost.ai/providers/custom-pricing" target="_blank" rel="noreferrer">Pricing documentation</a>
            </div>
          )}
          {isMiniMax && (
            <div className="aip-preset-help" data-testid="minimax-setup-help">
              Connects to MiniMax’s OpenAI-compatible chat API. Praxis can discover available models and checks chat, streaming, and tool calling. Model prices and plan eligibility vary; check MiniMax’s current billing details before use.
              {' '}<a className="aip-link" href="https://platform.minimax.io/docs/guides/models-intro" target="_blank" rel="noreferrer">Models</a>
              {' · '}<a className="aip-link" href="https://platform.minimax.io/docs/pricing/overview" target="_blank" rel="noreferrer">Pricing and billing</a>
            </div>
          )}
          {isOpenRouter && (
            <div className="aip-preset-help" data-testid="openrouter-setup-help">
              Use an OpenRouter model ID from the live catalog (for example, <code>provider/model</code>). OpenRouter’s model catalog includes per-model pricing, and supports streaming and tool use where the selected model supports them. Charges and routing follow your OpenRouter account settings.
              {' '}<a className="aip-link" href="https://openrouter.ai/docs/quickstart" target="_blank" rel="noreferrer">API guide</a>
              {' · '}<a className="aip-link" href="https://openrouter.ai/models" target="_blank" rel="noreferrer">Models and pricing</a>
            </div>
          )}
          {isAlibaba && (
            <div className="aip-preset-help" data-testid="alibaba-setup-help">
              {isAlibabaCodingPlan
                ? <>Uses your Coding Plan key (it starts with <code>sk-sp-</code>), shown on the console’s Coding Plan page. Plan quota is read through your Alibaba Cloud console sign-in, not the key.</>
                : selectedPresetId === 'alibaba-token-plan'
                  ? <>Uses your Token Plan subscription key (it starts with <code>sk-sp-</code>), generated on the plan’s My Subscription page.</>
                  : <>Uses a pay-as-you-go Model Studio key (it starts with <code>sk-</code>).</>}
              {' '}Keys and base URLs are paired: a plan key on the pay-as-you-go URL is rejected or billed pay-as-you-go, so keep this preset’s URL with its key. The URL shown is Singapore; if your key belongs to another region, use the API Host shown beside it in the console.
              {' '}<a className="aip-link" href="https://docs.modelstudio.console.alibabacloud.com/en/model-studio/get-api-key" target="_blank" rel="noreferrer">Getting an API key</a>
            </div>
          )}
          <FormRow label="Name" description="Shown in pickers and usage reports.">
            <input className="input" aria-label="Endpoint name" data-testid="custom-endpoint-name" value={label} onChange={event => setLabel(event.target.value)} />
          </FormRow>
          <FormRow
            label="Base URL"
            description={requestUrl ? <>Requests go to <code>{requestUrl}</code></> : 'The server root. Praxis calls <URL><API path>/chat/completions.'}
          >
            <input
              className="input aip-mono"
              aria-label="Base URL"
              data-testid="custom-endpoint-url"
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
            />
            {insecure && (
              <div className="aip-notice is-warn" role="note" data-testid="custom-endpoint-insecure">
                <Icon name="warning" size={13} />
                <span>Plain HTTP to a host that isn’t this machine: the API key will cross the network unencrypted. Use https:// if the server supports it.</span>
              </div>
            )}
          </FormRow>
          <div className="aip-field-pair">
            <FormRow label="Authentication">
              <ChipSelect
                block
                ariaLabel="Authentication"
                data-testid="custom-endpoint-auth"
                value={authKind}
                onChange={value => setAuthKind(value as AuthChoice)}
                options={[
                  { value: 'bearer', label: 'Bearer key', description: 'Authorization: Bearer <key>' },
                  { value: 'none', label: 'No key', description: 'For local runtimes such as Ollama or LM Studio' },
                  { value: 'header', label: 'Custom header', description: 'The key sent raw under a header you name, e.g. api-key' }
                ]}
              />
            </FormRow>
            {authKind === 'header' && (
              <FormRow label="Key header">
                <input className="input aip-mono" aria-label="Key header name" value={headerName} onChange={event => setHeaderName(event.target.value)} />
              </FormRow>
            )}
            {authKind !== 'none' && (
              <FormRow label="API key">
                <div className="ai-key-controls">
                  <input
                    type="password"
                    className="input aip-mono"
                    autoComplete="off"
                    aria-label="Endpoint API key"
                    data-testid="custom-endpoint-key"
                    placeholder={keySaved ? '••••••••  (saved)' : 'Paste API key'}
                    value={keyDraft}
                    onChange={event => setKeyDraft(event.target.value)}
                  />
                  {preset?.keyUrl && (
                    <a className="btn" href={preset.keyUrl} target="_blank" rel="noreferrer">
                      Get a key
                    </a>
                  )}
                </div>
              </FormRow>
            )}
          </div>
          {isAlibabaCodingPlan && <AlibabaConsoleSignIn providerId={initial?.id} />}
          <FormRow label="Default model" description={result ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} listed by the server’s /models.` : 'Listed by the server’s /models once tested. No list? Type the id.'}>
            <ChipSelect
              block
              searchable
              allowCustom
              ariaLabel="Default model"
              data-testid="custom-endpoint-model"
              value={model}
              placeholder="Run the test to list models, or type an id"
              onChange={setModel}
              options={listedModels.map(id => ({ value: id, label: id }))}
            />
          </FormRow>

          <div className="aip-advanced-box">
            <button
              type="button"
              className="aip-disclosure custom-endpoint-advanced-toggle"
              aria-expanded={advancedOpen}
              data-testid="custom-endpoint-advanced"
              onClick={() => setAdvancedOpen(open => !open)}
            >
              <Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              Advanced
              {!advancedOpen && (
                <span className="aip-muted">
                  · API path <code>{normalizeApiPath(apiPath) || '/'}</code> · {headers.filter(row => row.name.trim()).length || 'no'} extra header{headers.filter(row => row.name.trim()).length === 1 ? '' : 's'}
                </span>
              )}
            </button>
            {advancedOpen && (
              <div className="aip-advanced">
                <FormRow label="API path" description="Appended to the base URL exactly as given — no guessing.">
                  <input className="input aip-mono" aria-label="API path" data-testid="custom-endpoint-path" value={apiPath} onChange={event => setApiPath(event.target.value)} />
                </FormRow>
                <FormRow label="Extra headers" description="Non-secret only. Anything that looks like a token belongs in the API key field.">
                  <div className="custom-endpoint-headers">
                    {headers.map((row, index) => (
                      <div key={index} className="custom-endpoint-header-row">
                        <input
                          className="input"
                          aria-label={`Header ${index + 1} name`}
                          placeholder="Header"
                          value={row.name}
                          onChange={event => setHeaders(rows => rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))}
                        />
                        <input
                          className="input"
                          aria-label={`Header ${index + 1} value`}
                          placeholder="Value"
                          value={row.value}
                          onChange={event => setHeaders(rows => rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))}
                        />
                        <button type="button" className="btn-icon" aria-label={`Remove header ${index + 1}`} onClick={() => setHeaders(rows => rows.filter((_, i) => i !== index))}>
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-compact custom-endpoint-add-header" onClick={() => setHeaders(rows => [...rows, { name: '', value: '' }])}>
                      <Icon name="plus" size={12} />
                      Add header
                    </button>
                  </div>
                </FormRow>
                <FormRow label="Extra model ids" description="Offered even when the server doesn’t list them. Comma-separated.">
                  <input className="input aip-mono" aria-label="Extra model ids" value={extraModels} onChange={event => setExtraModels(event.target.value)} />
                </FormRow>
              </div>
            )}
          </div>
        </div>

        <aside className="aip-endpoint-test" aria-label="Connection test">
          <h4 className="aip-card-title">
            <span>Connection test</span>
            {testedAt && result && <span className="aip-card-aside aip-muted">ran at {new Date(testedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>}
          </h4>
          {!result && !testing && (
            <p className="aip-hint">Checks what this server supports — reachable, key accepted, chat, streaming usage and tool calling — using at most three tiny requests.</p>
          )}
          {testing && <p className="aip-hint" role="status">Testing…</p>}
          {result && (
            <ul className="custom-endpoint-probe aip-probe" aria-label="Connection test results" data-testid="custom-endpoint-probe">
              {result.steps.map(step => (
                <li key={step.id} className={`custom-endpoint-probe-step is-${step.status}`} data-testid={`custom-endpoint-probe-${step.id}`} data-status={step.status}>
                  <span className="custom-endpoint-probe-dot" aria-hidden>
                    <Icon name={step.status === 'pass' ? 'check' : step.status === 'fail' ? 'close' : 'dot'} size={10} />
                  </span>
                  <span className="aip-probe-text">
                    <strong>{PROBE_STEP_LABELS[step.id]}</strong>
                    <span className="custom-endpoint-probe-detail">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result && chatOnly && (
            <div className="aip-notice is-warn aip-chat-only" data-testid="custom-endpoint-chat-only">
              <Icon name="warning" size={13} />
              <div>
                <strong>Chat-only so far.</strong> Without tool calling it can answer quick recommendations but can’t run sessions, reviews or workflow stages. Support often differs by model —
                {otherModels.length > 0 && (
                  <div className="aip-retry">
                    <ChipSelect
                      block
                      searchable
                      ariaLabel="Model to test"
                      value={retryModel || otherModels[0]!}
                      onChange={setRetryModel}
                      options={otherModels.map(id => ({ value: id, label: id }))}
                    />
                    <button type="button" className="btn btn-compact" disabled={testing} onClick={() => void runTest(retryModel || otherModels[0])}>
                      Test this model
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="error-banner" data-testid="custom-endpoint-error">
              <span>{error}</span>
            </div>
          )}
        </aside>
      </div>
      <div className="modal-footer aip-dialog-foot custom-endpoint-actions">
        <span className="aip-muted aip-foot-note">{authKind === 'none' ? 'No key is sent.' : 'The key goes to the OS keychain.'} Nothing is saved until you choose {initial ? 'Save' : 'Add'}.</span>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        <button type="button" className="btn" data-testid="custom-endpoint-test" disabled={testing || saving || !canSubmit} onClick={() => void runTest()}>
          <Icon name="refresh" size={12} />
          {testing ? 'Testing…' : result ? 'Test again' : 'Test connection'}
        </button>
        <button type="button" className="btn btn-primary" data-testid="custom-endpoint-save" disabled={saving || testing || !canSubmit} onClick={() => void save()}>
          {saving ? 'Saving…' : initial ? (chatOnly ? 'Save as chat-only' : 'Save changes') : (chatOnly ? 'Add as chat-only' : 'Add endpoint')}
        </button>
      </div>
    </div>
  );
}
