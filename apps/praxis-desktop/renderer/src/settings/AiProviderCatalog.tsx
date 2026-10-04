import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiProvider,
  AiProviderStatus,
  CustomProviderConfig,
  ProviderPreset,
  ProviderProbeResult,
  ProviderProbeStepId
} from '@praxis/core';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon, type IconName } from '../ui/Icon';
import { ProviderBrandLogo } from '../ai/ProviderBrandLogo';

/**
 * Settings → AI Provider → Add provider (FX-BF-044): the catalog dialog, and
 * the form a user-added OpenAI-compatible endpoint is created and edited with.
 * Built from the existing modal, settings-row, button and ChipSelect
 * primitives — no new control types.
 */

/** A built-in provider as the catalog shows it. */
export interface BuiltInCatalogEntry {
  id: AiProvider;
  kind: 'api' | 'cli-agent';
  label: string;
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

/** "http://localhost:11434" + "/v1" → "localhost:11434/v1" — what a row's meta line shows. */
export function endpointDisplayUrl(config: Pick<CustomProviderConfig, 'baseUrl' | 'apiPath'>): string {
  return `${config.baseUrl.replace(/^https?:\/\//, '')}${config.apiPath}`;
}

export const PROBE_STEP_LABELS: Record<ProviderProbeStepId, string> = {
  models: 'Reachable, key accepted',
  chat: 'Chat',
  streaming: 'Streaming with token usage',
  tools: 'Tool calling'
};

const GROUP_TITLES: Array<{ group: 'builtin-api' | 'cloud' | 'gateway' | 'local' | 'builtin-cli' | 'custom'; title: string; note: string }> = [
  { group: 'builtin-api', title: 'Built-in', note: 'dedicated integrations' },
  { group: 'gateway', title: 'AI gateways', note: 'connect to multiple model providers' },
  { group: 'cloud', title: 'Cloud', note: 'OpenAI-compatible' },
  { group: 'local', title: 'Local runtimes', note: 'on this machine or your network' },
  { group: 'builtin-cli', title: 'CLI agents', note: 'run a coding agent installed on this machine' },
  { group: 'custom', title: 'Custom', note: '' }
];

interface CatalogTile {
  key: string;
  group: (typeof GROUP_TITLES)[number]['group'];
  label: string;
  state: string;
  stateTone?: 'ok';
  icon: IconName;
  disabled?: boolean;
  onPick: () => void;
}

export function AddProviderDialog({
  builtIns,
  listed,
  statuses,
  presets,
  customProviders,
  onClose,
  onPickBuiltIn,
  onPickPreset
}: {
  builtIns: BuiltInCatalogEntry[];
  /** Providers already on the Providers tab. */
  listed: ReadonlySet<string>;
  statuses: AiProviderStatus[];
  presets: ProviderPreset[];
  customProviders: readonly CustomProviderConfig[];
  onClose: () => void;
  onPickBuiltIn: (id: AiProvider) => void;
  onPickPreset: (preset: ProviderPreset) => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);

  const tiles = useMemo<CatalogTile[]>(() => {
    const out: CatalogTile[] = [];
    for (const entry of builtIns) {
      const status = statuses.find(candidate => candidate.provider === entry.id);
      const added = listed.has(entry.id);
      const state = added
        ? 'Added'
        : entry.kind === 'cli-agent'
          ? status?.configured ? 'Detected on PATH' : 'Not found on PATH'
          : 'API key required';
      out.push({
        key: entry.id,
        group: entry.id === 'vercel-gateway' ? 'gateway' : entry.kind === 'api' ? 'builtin-api' : 'builtin-cli',
        label: entry.label,
        state,
        stateTone: !added && status?.configured ? 'ok' : undefined,
        icon: entry.kind === 'api' ? 'globe' : 'terminal',
        disabled: added,
        onPick: () => onPickBuiltIn(entry.id)
      });
    }
    for (const preset of presets) {
      const count = customProviders.filter(provider => provider.presetId === preset.id).length;
      out.push({
        key: `preset-${preset.id}`,
        group: preset.group,
        label: preset.label,
        state: count > 0 && preset.group !== 'custom' ? 'Added · add another' : preset.group === 'cloud' ? 'API key required' : preset.note,
        icon: preset.group === 'local' ? 'server' : preset.group === 'custom' ? 'link' : 'globe',
        onPick: () => onPickPreset(preset)
      });
    }
    return out;
  }, [builtIns, statuses, listed, presets, customProviders, onPickBuiltIn, onPickPreset]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? tiles.filter(tile => `${tile.label} ${tile.state} ${GROUP_TITLES.find(g => g.group === tile.group)?.title ?? ''} ${GROUP_TITLES.find(g => g.group === tile.group)?.note ?? ''}`.toLowerCase().includes(needle))
    : tiles;

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card add-provider-card"
        role="dialog"
        aria-modal="true"
        aria-label="Add provider"
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
        <div className="modal-header">
          <div className="add-provider-heading">
            <h3>Add provider</h3>
            <p className="settings-hint">
              Pick one to set up. OpenAI-compatible entries create an endpoint — add the same one twice for two hosts or two keys.
            </p>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="add-provider-search">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            className="input"
            type="search"
            aria-label="Search providers"
            placeholder="Search providers, e.g. “groq” or “local”"
            data-testid="add-provider-search"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <div className="modal-body add-provider-body">
          {GROUP_TITLES.map(({ group, title, note }) => {
            const inGroup = visible.filter(tile => tile.group === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} className="add-provider-group" aria-label={title}>
                <h4 className="add-provider-group-title">
                  {title}
                  {note && <span>— {note}</span>}
                </h4>
                <div className={`add-provider-grid${group === 'custom' ? ' is-wide' : ''}`}>
                  {inGroup.map(tile => (
                    <button
                      key={tile.key}
                      type="button"
                      className="add-provider-tile"
                      data-testid={`add-provider-tile-${tile.key}`}
                      disabled={tile.disabled}
                      onClick={tile.onPick}
                    >
                      <div className="add-provider-tile-head">
                        <div className="add-provider-tile-logo">
                          <ProviderBrandLogo provider={tile.key.replace('preset-', '')} size={30} />
                        </div>
                        <span className={`add-provider-tile-badge${tile.disabled ? ' is-added' : tile.stateTone === 'ok' ? ' is-ok' : ''}`}>
                          {tile.disabled ? (
                            'Added'
                          ) : tile.stateTone === 'ok' ? (
                            <>
                              <span className="ai-provider-status-dot" />
                              Detected
                            </>
                          ) : (
                            tile.group === 'builtin-cli' ? 'CLI Agent' : tile.group === 'gateway' ? 'Gateway' : tile.group === 'local' ? 'Local' : 'Cloud API'
                          )}
                        </span>
                      </div>
                      <div className="add-provider-tile-text">
                        <span className="add-provider-tile-name">{tile.label}</span>
                        <span className={`add-provider-tile-state${tile.stateTone === 'ok' ? ' is-ok' : ''}`}>{tile.state}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {visible.length === 0 && <p className="settings-hint">Nothing matches “{query}”. Use Custom OpenAI-compatible endpoint for any other server.</p>}
        </div>
        <div className="modal-footer">
          <span className="add-provider-footnote">Presets fill in the URL and auth; you can change either before saving.</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FormRow({ label, description, stacked, children }: { label: string; description?: string; stacked?: boolean; children: React.ReactNode }) {
  return (
    <div className={`settings-field-row${stacked ? ' settings-field-row--stacked' : ''}`}>
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control settings-field-control--field">{children}</div>
    </div>
  );
}

type AuthChoice = 'bearer' | 'none' | 'header';

/**
 * Creates (no `initial`) or edits a custom endpoint. Nothing is written until
 * Save: Test probes the unsaved draft with the typed key, and Save stores the
 * endpoint, its key and default model in one call.
 */
export function CustomEndpointForm({
  initial,
  preset,
  defaultModel: initialModel,
  keySaved,
  onSaved,
  onCancel,
  onRemove
}: {
  initial?: CustomProviderConfig;
  preset?: ProviderPreset;
  defaultModel?: string;
  /** A key is already stored for this endpoint. */
  keySaved?: boolean;
  onSaved: (config: CustomProviderConfig) => void;
  onCancel?: () => void;
  onRemove?: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? (preset && preset.id !== 'custom' ? preset.label : ''));
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? preset?.baseUrl ?? '');
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
  const [advancedOpen, setAdvancedOpen] = useState(!initial && preset?.id === 'custom');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProviderProbeResult>();
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

  const runTest = async () => {
    setTesting(true);
    setError(undefined);
    try {
      const probe = await window.praxis.ai.testCustomProvider(draft(), {
        ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {})
      });
      testedKey.current = targetKey;
      setResult(probe);
      if (!model.trim() && probe.capabilities.model) setModel(probe.capabilities.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

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
  const isBifrost = (initial?.presetId ?? preset?.id) === 'bifrost';
  const selectedPresetId = initial?.presetId ?? preset?.id;
  const isMiniMax = selectedPresetId === 'minimax';
  const isOpenRouter = selectedPresetId === 'openrouter';

  return (
    <div className="custom-endpoint-form" data-testid={testId}>
      {isBifrost && (
        <FormRow label="Bifrost gateway" stacked>
          <div data-testid="bifrost-setup-help">
            Connect to a Bifrost gateway running locally or remotely. Praxis does not install or start the gateway. Enter its URL and virtual key below. Models can use provider prefixes such as <code>openai/gpt-4o-mini</code>, or aliases configured in Bifrost.
            {' '}Manage budgets, rate limits, routing and pricing overrides in Bifrost. Praxis shows token usage and local cost estimates for recognized models; these can differ from gateway costs after caching, fallbacks or custom pricing.
            {' '}<a style={{ color: 'var(--accent)' }} href="https://docs.getbifrost.ai/features/governance/budget-and-limits" target="_blank" rel="noreferrer">Budget documentation</a>
            {' · '}<a style={{ color: 'var(--accent)' }} href="https://docs.getbifrost.ai/providers/custom-pricing" target="_blank" rel="noreferrer">Pricing documentation</a>
          </div>
        </FormRow>
      )}
      {isMiniMax && (
        <FormRow label="MiniMax API" stacked>
          <div data-testid="minimax-setup-help">
            Connects to MiniMax’s OpenAI-compatible chat API. Praxis can discover available models and checks chat, streaming, and tool calling. Model prices and plan eligibility vary; check MiniMax’s current billing details before use.
            {' '}<a style={{ color: 'var(--accent)' }} href="https://platform.minimax.io/docs/guides/models-intro" target="_blank" rel="noreferrer">Models</a>
            {' · '}<a style={{ color: 'var(--accent)' }} href="https://platform.minimax.io/docs/pricing/overview" target="_blank" rel="noreferrer">Pricing and billing</a>
          </div>
        </FormRow>
      )}
      {isOpenRouter && (
        <FormRow label="OpenRouter API" stacked>
          <div data-testid="openrouter-setup-help">
            Use an OpenRouter model ID from the live catalog (for example, <code>provider/model</code>). OpenRouter’s model catalog includes per-model pricing, and supports streaming and tool use where the selected model supports them. Charges and routing follow your OpenRouter account settings.
            {' '}<a style={{ color: 'var(--accent)' }} href="https://openrouter.ai/docs/quickstart" target="_blank" rel="noreferrer">API guide</a>
            {' · '}<a style={{ color: 'var(--accent)' }} href="https://openrouter.ai/models" target="_blank" rel="noreferrer">Models and pricing</a>
          </div>
        </FormRow>
      )}
      <FormRow label="Name" description="How this endpoint appears in pickers and usage reports.">
        <input className="input" aria-label="Endpoint name" data-testid="custom-endpoint-name" value={label} onChange={event => setLabel(event.target.value)} />
      </FormRow>
      <FormRow label="Base URL" description="The server root. Praxis calls <URL><API path>/chat/completions.">
        <div className="custom-endpoint-stack">
          <input
            className="input custom-endpoint-mono"
            aria-label="Base URL"
            data-testid="custom-endpoint-url"
            placeholder="https://api.example.com"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
          />
          {insecure && (
            <div className="custom-endpoint-warning" role="note" data-testid="custom-endpoint-insecure">
              <Icon name="warning" size={13} />
              <span>Plain HTTP to a host that isn’t this machine: the API key will cross the network unencrypted. Use https:// if the server supports it.</span>
            </div>
          )}
        </div>
      </FormRow>
      <FormRow label="Authentication" description="Most hosted APIs use a bearer key; local runtimes usually need none.">
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
        <FormRow label="Key header" description="The header the server reads the key from.">
          <input className="input custom-endpoint-mono" aria-label="Key header name" value={headerName} onChange={event => setHeaderName(event.target.value)} />
        </FormRow>
      )}
      {authKind !== 'none' && (
        <FormRow label="API key" description="Stored encrypted in the OS keychain; never shown again after saving." stacked>
          <div className="ai-key-controls">
            <input
              type="password"
              className="input"
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
      <FormRow label="Default model" description="Listed by the server’s /models once tested. No list? Type the id.">
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

      <button
        type="button"
        className="custom-endpoint-advanced-toggle"
        aria-expanded={advancedOpen}
        data-testid="custom-endpoint-advanced"
        onClick={() => setAdvancedOpen(open => !open)}
      >
        <Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
        Advanced
      </button>
      {advancedOpen && (
        <>
          <FormRow label="API path" description="Appended to the base URL exactly as given — no guessing.">
            <input className="input custom-endpoint-mono" aria-label="API path" data-testid="custom-endpoint-path" value={apiPath} onChange={event => setApiPath(event.target.value)} />
          </FormRow>
          <FormRow label="Extra headers" description="Non-secret only. Anything that looks like a token belongs in the API key field." stacked>
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
            <input className="input custom-endpoint-mono" aria-label="Extra model ids" value={extraModels} onChange={event => setExtraModels(event.target.value)} />
          </FormRow>
        </>
      )}

      <FormRow label="Connection test" description="Checks what this server supports, using at most three tiny requests.">
        <div className="ai-key-controls ai-key-controls--end">
          <button type="button" className="btn" data-testid="custom-endpoint-test" disabled={testing || saving || !canSubmit} onClick={() => void runTest()}>
            {testing ? 'Testing…' : result ? 'Run again' : 'Test connection'}
          </button>
        </div>
      </FormRow>
      {result && (
        <ul className="custom-endpoint-probe" aria-label="Connection test results" data-testid="custom-endpoint-probe">
          {result.steps.map(step => (
            <li key={step.id} className={`custom-endpoint-probe-step is-${step.status}`} data-testid={`custom-endpoint-probe-${step.id}`} data-status={step.status}>
              <span className="custom-endpoint-probe-dot" aria-hidden>
                <Icon name={step.status === 'pass' ? 'check' : step.status === 'fail' ? 'close' : 'dot'} size={10} />
              </span>
              <span>
                <strong>{PROBE_STEP_LABELS[step.id]}</strong>
                <span className="custom-endpoint-probe-detail"> — {step.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="error-banner" data-testid="custom-endpoint-error">
          <span>{error}</span>
        </div>
      )}
      <div className="custom-endpoint-actions">
        {onRemove && (
          <button type="button" className="btn btn-danger" data-testid="custom-endpoint-remove" disabled={saving} onClick={onRemove}>
            Remove endpoint
          </button>
        )}
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-primary" data-testid="custom-endpoint-save" disabled={saving || testing || !canSubmit} onClick={() => void save()}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Save endpoint'}
        </button>
      </div>
    </div>
  );
}
