import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AgentSessionRecord,
  AiProviderConfig,
  AiProviderStatus,
  AppSettings,
  AppSettingsPatch,
  CustomProviderConfig,
  ProviderPreset
} from '@praxis/core';
import { ChipSelect } from '../../ui/ChipSelect';
import { Icon } from '../../ui/Icon';
import { ProviderBrandLogo } from '../../ui/ProviderBrandLogo';
import { useDialogs } from '../../ui/dialogs';
import { hasModelCatalog } from '../../ai/modelProviders';
import { summariseSpend } from '../../ai/sessionNav';
import { DebouncedTextField } from '../settingsFields';
import { endpointDisplayUrl } from '../AiProviderCatalog';
import {
  CAPABILITY_LABELS,
  endpointKind,
  providerHealth,
  shortLabel,
  type AiProviderMeta,
  type ProviderHealth
} from './providerMeta';
import { MODEL_TIER_NAMES } from './ModelTiers';

const Z_AI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const Z_AI_GENERAL = 'https://api.z.ai/api/paas/v4';

/** The one line under a provider's name in the detail header — also what the specs read. */
export function providerStatusText(status: AiProviderStatus | undefined, meta: AiProviderMeta, custom?: CustomProviderConfig): string {
  if (!status) return 'Checking…';
  if (meta.kind === 'cli-agent') {
    // No API key concept — `configured` is a real, free check that the command
    // resolves to a spawnable executable (no ACP handshake, no LLM call).
    return status.configured
      ? `Ready${status.preflight?.providerVersion ? ` · v${status.preflight.providerVersion}` : ''} · uses its own sign-in`
      : 'Not installed — Praxis could not find it to run';
  }
  if (status.custom) {
    const where = custom ? endpointDisplayUrl(custom) : status.gatewayUrl;
    const key = status.needsKey === false ? 'no key' : status.configured ? 'key in the OS keychain' : 'add an API key';
    const tested = status.capabilities
      ? status.capabilities.tools ? '' : ' · chat only — not offered for agent sessions or workflows'
      : ' · not tested yet';
    return `${where} · ${key}${tested}`;
  }
  return status.configured
    ? status.keySource === 'secret'
      ? 'Connected · API key in the OS keychain'
      : 'Connected · API key from the environment'
    : 'Not configured — add an API key to use it';
}

const HEALTH_DOT: Record<ProviderHealth, string> = {
  checking: 'is-checking',
  ready: 'is-ok',
  'chat-only': 'is-ok',
  setup: 'is-warn',
  off: 'is-off'
};

export function HealthDot({ health }: { health: ProviderHealth }) {
  return <span className={`aip-dot ${HEALTH_DOT[health]}`} aria-hidden />;
}

/** A provider's brand mark, with a terminal badge on local agents — Codex and OpenAI share a logo, as do Claude Code and Anthropic. */
export function ProviderMark({ id, kind, size }: { id: string; kind: 'api' | 'cli-agent'; size: number }) {
  return (
    <span className="aip-mark" style={{ width: size, height: size }}>
      <ProviderBrandLogo provider={id} size={size} decorative />
      {kind === 'cli-agent' && <span className="aip-mark-badge" aria-hidden>›_</span>}
    </span>
  );
}

function Card({ title, aside, children, testId }: { title: string; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="aip-card" aria-label={title} data-testid={testId}>
      <h4 className="aip-card-title">
        <span>{title}</span>
        {aside && <span className="aip-card-aside">{aside}</span>}
      </h4>
      {children}
    </section>
  );
}

function Row({ label, children, actions, stacked }: { label: string; children: ReactNode; actions?: ReactNode; stacked?: boolean }) {
  return (
    <div className={`aip-row${stacked ? ' is-stacked' : ''}`}>
      <span className="aip-row-label">{label}</span>
      <div className="aip-row-value">{children}</div>
      {actions && <div className="aip-row-actions">{actions}</div>}
    </div>
  );
}

export interface ProviderDetailProps {
  meta: AiProviderMeta;
  status?: AiProviderStatus;
  settings: AppSettings;
  update: (patch: AppSettingsPatch) => Promise<void>;
  custom?: CustomProviderConfig;
  presets: readonly ProviderPreset[];
  isDefault: boolean;
  /** False when this is the only provider on the list — one must remain. */
  canRemove: boolean;
  /** This provider's sessions from the last 30 days, for the Usage card. */
  recentSessions: readonly AgentSessionRecord[];
  /** Set when a switch or Add provider asked to start setup: focus the first setup field. */
  focusSetup: boolean;
  onSetupFocused: () => void;
  reloadStatuses: () => void;
  onToggleEnabled: () => void;
  onMakeDefault: () => void;
  onRemove: () => void;
  onManageModels: () => void;
  onEditEndpoint: () => void;
  onOpenUsage?: () => void;
}

export function ProviderDetail(props: ProviderDetailProps) {
  const { meta, status, settings, update, custom, presets, isDefault, canRemove, focusSetup, onSetupFocused } = props;
  const { confirm } = useDialogs();
  const config: AiProviderConfig = settings.ai.providers[meta.id] ?? {};
  const enabled = config.enabled !== false;
  const configured = status?.configured === true;
  const health = providerHealth(status, enabled);
  const on = configured && enabled;
  const isVercel = meta.id === 'vercel-gateway';

  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const [installing, setInstalling] = useState(false);
  const [latest, setLatest] = useState<{ version?: string; loading: boolean }>({ loading: false });
  const [pathOpen, setPathOpen] = useState(Boolean(config.cliPath?.trim()));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusSetup || !status) return;
    const field = rootRef.current?.querySelector<HTMLElement>('[data-setup-focus] input, input[data-setup-focus]');
    if (field) {
      field.focus();
      onSetupFocused();
    }
  }, [focusSetup, status, onSetupFocused]);

  useEffect(() => {
    if (meta.kind !== 'cli-agent' || !meta.installPackage) return;
    let cancelled = false;
    setLatest({ loading: true });
    window.praxis.ai.getLatestCliProviderVersion(meta.id)
      .then(result => { if (!cancelled) setLatest({ version: result.version, loading: false }); })
      .catch(() => { if (!cancelled) setLatest({ loading: false }); });
    return () => { cancelled = true; };
  }, [meta.id, meta.kind, meta.installPackage]);

  const saveKey = async (value: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await window.praxis.ai.setProviderApiKey(meta.id, value);
      props.reloadStatuses();
      setKeyDraft('');
      if (value.trim()) {
        try {
          const result = await window.praxis.ai.testProviderApiKey(meta.id);
          setNotice({ tone: 'ok', text: `Key saved. ${result.message}` });
        } catch (testErr) {
          setNotice({ tone: 'error', text: `Key saved, but connection test failed: ${testErr instanceof Error ? testErr.message : String(testErr)}` });
        }
      }
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setNotice(undefined);
    try {
      if (keyDraft.trim()) {
        await window.praxis.ai.setProviderApiKey(meta.id, keyDraft.trim());
        props.reloadStatuses();
        setKeyDraft('');
      }
      const result = await window.praxis.ai.testProviderApiKey(meta.id);
      setNotice({ tone: 'ok', text: result.message });
    } catch (err) {
      setNotice({ tone: 'error', text: `Connection test failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  const installCli = async (updating = false) => {
    if (!meta.installPackage) return;
    if (!(await confirm({
      title: `${updating ? 'Update' : 'Install'} ${meta.label} ACP?`,
      message: `Praxis will use an available package manager to ${updating ? 'update' : 'install'} ${meta.installPackage} globally. The package is fixed by this provider and is not editable here.`,
      confirmLabel: updating ? 'Update ACP' : 'Install ACP'
    }))) return;
    setInstalling(true);
    setNotice(undefined);
    try {
      const result = await window.praxis.ai.installCliProvider(meta.id);
      setNotice({ tone: 'ok', text: result.message });
      props.reloadStatuses();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstalling(false);
    }
  };

  const commitConfig = (patch: Partial<AiProviderConfig>) =>
    update({ ai: { providers: { [meta.id]: { ...config, ...patch } } } });
  const urlValue = isVercel ? settings.ai.gatewayUrl : config.baseUrl ?? '';
  const modelValue = isVercel ? settings.ai.defaultModel : config.defaultModel ?? '';
  const commitUrl = (value: string) => isVercel ? update({ ai: { gatewayUrl: value } }) : commitConfig({ baseUrl: value || undefined });
  const commitModel = (value: string) => isVercel ? update({ ai: { defaultModel: value } }) : commitConfig({ defaultModel: value || undefined });

  const switchTitle = !status
    ? 'Checking…'
    : !configured
      ? meta.kind === 'cli-agent'
        ? 'Not installed yet — opens its setup (install the CLI or set its path)'
        : 'Not set up yet — opens its setup (add an API key)'
      : isDefault
        ? 'This is the default provider — choose another default to turn it off'
        : on ? 'Turn off' : 'Turn on';

  const kindTag = custom ? endpointKind(custom, presets) : meta.kind === 'cli-agent' ? 'Local agent' : 'Cloud API';
  const label = shortLabel(meta);

  return (
    <div className="aip-detail" ref={rootRef} data-testid={`ai-provider-body-${meta.id}`}>
      <header className="aip-detail-head">
        <ProviderMark id={meta.id} kind={meta.kind} size={40} />
        <div className="aip-detail-titles">
          <h3>
            <span>{label}</span>
            <span className="chip aip-kind">{kindTag}</span>
            {isDefault && <span className="chip aip-default-chip"><Icon name="star" size={10} />Default</span>}
          </h3>
          <div className="aip-detail-status">
            <HealthDot health={health} />
            <span data-testid="ai-provider-status">{enabled ? '' : 'Turned off. '}{providerStatusText(status, meta, custom)}</span>
          </div>
        </div>
        <div className="aip-detail-actions">
          {configured && meta.kind === 'api' && !custom && (
            <button type="button" className="btn" data-testid="ai-api-key-test" disabled={busy || testing} onClick={() => void testKey()}>
              <Icon name="refresh" size={12} />
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          )}
          {meta.kind === 'cli-agent' && (
            <button type="button" className="btn-icon" aria-label={`Check ${label} again`} onClick={props.reloadStatuses}>
              <Icon name="refresh" size={13} />
            </button>
          )}
          {!isDefault && enabled && configured && (
            <button
              type="button"
              className="btn"
              data-testid={`ai-provider-set-active-${meta.id}`}
              aria-label={`Use ${meta.label} for new sessions`}
              onClick={props.onMakeDefault}
            >
              Make default
            </button>
          )}
          <label className="aip-switch-label" title={switchTitle}>
            <span>{on ? 'On' : 'Off'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${meta.label} enabled`}
              title={switchTitle}
              className="switch"
              data-testid={`ai-provider-enabled-${meta.id}`}
              disabled={!status || (configured && isDefault)}
              onClick={event => {
                event.preventDefault();
                props.onToggleEnabled();
              }}
            />
          </label>
        </div>
      </header>

      {notice && (
        <div className={`aip-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid={notice.tone === 'ok' ? 'ai-api-key-success' : 'ai-provider-error'}>
          <Icon name={notice.tone === 'ok' ? 'check' : 'warning'} size={13} />
          <span>{notice.text}</span>
        </div>
      )}

      {custom ? (
        <EndpointConnection custom={custom} status={status} onEdit={props.onEditEndpoint} />
      ) : meta.kind === 'api' ? (
        configured ? (
          <Card title="Connection">
            <Row label="API key">
              <KeyControls
                meta={meta}
                status={status}
                keyDraft={keyDraft}
                setKeyDraft={setKeyDraft}
                busy={busy || testing}
                onSave={() => void saveKey(keyDraft)}
                onClear={() => void saveKey('')}
              />
            </Row>
            <Row label={isVercel ? 'Gateway URL' : 'Endpoint'}>
              <DebouncedTextField
                ariaLabel={isVercel ? 'AI gateway URL' : `${meta.label} base URL`}
                value={urlValue}
                onCommit={commitUrl}
                placeholder={status?.gatewayUrl ?? meta.urlPlaceholder}
              />
            </Row>
            {meta.id === 'z-ai' && <ZaiPlanRow baseUrl={config.baseUrl} onChange={value => void commitUrl(value)} />}
          </Card>
        ) : (
          <ApiSetup
            meta={meta}
            status={status}
            keyDraft={keyDraft}
            setKeyDraft={setKeyDraft}
            busy={busy}
            onConnect={() => void saveKey(keyDraft)}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen(open => !open)}
            advanced={
              <>
                <Row label={isVercel ? 'Gateway URL' : 'Endpoint'}>
                  <DebouncedTextField
                    ariaLabel={isVercel ? 'AI gateway URL' : `${meta.label} base URL`}
                    value={urlValue}
                    onCommit={commitUrl}
                    placeholder={status?.gatewayUrl ?? meta.urlPlaceholder}
                  />
                </Row>
                {meta.id === 'z-ai' && <ZaiPlanRow baseUrl={config.baseUrl} onChange={value => void commitUrl(value)} />}
              </>
            }
          />
        )
      ) : configured ? (
        <Card title="Runtime">
          <Row
            label="Executable"
            actions={!pathOpen && (
              <button type="button" className="btn btn-compact" onClick={() => setPathOpen(true)}>Use a different path</button>
            )}
          >
            <span className="aip-mono aip-ellipsis aip-grow" title={status?.gatewayUrl}>{status?.gatewayUrl}</span>
            <span className="chip">{config.cliPath?.trim() ? 'custom path' : meta.defaultCommand ? 'found on PATH' : 'bundled'}</span>
          </Row>
          {pathOpen && <CliPathRow meta={meta} value={config.cliPath ?? ''} onCommit={value => commitConfig({ cliPath: value || undefined })} />}
          {meta.installPackage && !config.cliPath?.trim() && (
            <AcpVersionRow meta={meta} status={status} latest={latest} installing={installing} onUpdate={() => void installCli(true)} />
          )}
          {meta.signIn && <SignInRow signIn={meta.signIn} />}
          {status?.preflight && status.preflight.status !== 'ready' && (
            <Row label="Last check"><span className="aip-muted">{status.preflight.message}</span></Row>
          )}
        </Card>
      ) : (
        <CliSetup
          meta={meta}
          status={status}
          cliPath={config.cliPath ?? ''}
          installing={installing}
          onInstall={() => void installCli(false)}
          onCommitPath={value => commitConfig({ cliPath: value || undefined })}
          onRecheck={props.reloadStatuses}
        />
      )}

      {(configured || custom) && (hasModelCatalog(meta.id) || custom || meta.kind === 'api') && (
        <ModelsCard
          meta={meta}
          config={config}
          tiers={settings.ai.modelTiers?.[meta.id] ?? {}}
          modelValue={modelValue}
          commitModel={commitModel}
          hasCatalog={hasModelCatalog(meta.id)}
          onManageModels={props.onManageModels}
          showDefaultField={!custom}
        />
      )}

      {configured && (
        <UsageCard
          meta={meta}
          sessions={props.recentSessions}
          spendLimit={settings.ai.spendLimit}
          onOpenUsage={props.onOpenUsage}
        />
      )}

      <div className="aip-remove-row">
        <span className="aip-muted">
          {custom
            ? 'Removing an endpoint deletes it and its saved key.'
            : 'Removing keeps its saved key and settings, so adding it back is one click.'}
        </span>
        <button
          type="button"
          className="btn btn-compact aip-remove"
          data-testid={`ai-provider-remove-${meta.id}`}
          aria-label={`Remove ${meta.label}`}
          disabled={!canRemove}
          title={canRemove ? `Remove ${meta.label}` : 'Keep at least one AI provider'}
          onClick={props.onRemove}
        >
          <Icon name="trash" size={12} />
          Remove {label}…
        </button>
      </div>
    </div>
  );
}

function KeyControls({ meta, status, keyDraft, setKeyDraft, busy, onSave, onClear, setupFocus }: {
  meta: AiProviderMeta;
  status?: AiProviderStatus;
  keyDraft: string;
  setKeyDraft: (value: string) => void;
  busy: boolean;
  onSave: () => void;
  onClear?: () => void;
  setupFocus?: boolean;
}) {
  const saved = status?.configured === true;
  // Wraps instead of squeezing: in a narrow row the buttons used to wrap their own labels and push
  // Test/Clear past the edge (`aiProviderCatalog.spec.ts` measures it).
  return (
    <div className="ai-key-controls" data-setup-focus={setupFocus || undefined}>
      <input
        type="password"
        className="input aip-mono"
        autoComplete="off"
        spellCheck={false}
        data-testid="ai-api-key-input"
        aria-label={meta.keyLabel}
        placeholder={saved
          ? status?.keySource === 'secret' ? 'Saved in the keychain — paste a new key to replace it' : 'Set in the environment — paste a key to override it'
          : 'Paste API key'}
        value={keyDraft}
        onChange={event => setKeyDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && keyDraft.trim() && !busy) onSave(); }}
      />
      <button type="button" className={`btn${saved ? '' : ' btn-primary'}`} data-testid="ai-api-key-save" disabled={busy || !keyDraft.trim()} onClick={onSave}>
        {saved ? 'Replace key' : busy ? 'Connecting…' : 'Connect'}
      </button>
      {onClear && (
        <button
          type="button"
          className="btn"
          data-testid="ai-api-key-clear"
          disabled={busy || !status || status.keySource !== 'secret'}
          title={status?.keySource === 'secret' ? 'Delete the saved key' : 'No saved key — this one comes from the environment'}
          onClick={onClear}
        >
          Clear
        </button>
      )}
    </div>
  );
}

function ApiSetup({ meta, status, keyDraft, setKeyDraft, busy, onConnect, advancedOpen, onToggleAdvanced, advanced }: {
  meta: AiProviderMeta;
  status?: AiProviderStatus;
  keyDraft: string;
  setKeyDraft: (value: string) => void;
  busy: boolean;
  onConnect: () => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  advanced: ReactNode;
}) {
  const label = shortLabel(meta);
  return (
    <section className="aip-card aip-setup" aria-label={`Connect ${label}`}>
      <ol className="aip-steps">
        <li className="aip-step is-now">
          <span className="aip-step-n">1</span>
          <div className="aip-step-body">
            <strong>Paste {/^[aeiou]/i.test(label) ? 'an' : 'a'} {label} API key</strong>
            <p className="aip-hint" data-testid={`ai-provider-setup-hint-${meta.id}`}>
              Add an API key to turn this provider on — it switches on as soon as the key is saved.
              {' '}It goes straight to the OS keychain and is never shown again.
              {meta.keyUrl && <> Create one at <a className="aip-link" href={meta.keyUrl} target="_blank" rel="noreferrer">{meta.keyUrl.replace(/^https:\/\//, '')}</a>.</>}
            </p>
            <KeyControls meta={meta} status={status} keyDraft={keyDraft} setKeyDraft={setKeyDraft} busy={busy} onSave={onConnect} setupFocus />
            <p className="aip-hint">Connect saves the key and checks it in one step.</p>
          </div>
        </li>
        <li className="aip-step is-todo">
          <span className="aip-step-n">2</span>
          <div className="aip-step-body">
            <strong>Check the connection</strong>
            <p className="aip-hint">Praxis sends one small request to confirm the key works.</p>
          </div>
        </li>
        <li className="aip-step is-todo">
          <span className="aip-step-n">3</span>
          <div className="aip-step-body">
            <strong>Choose its models</strong>
            <p className="aip-hint">Pick what fast, standard and strong mean here, and what the composer offers.</p>
          </div>
        </li>
      </ol>
      <footer className="aip-card-foot">
        <button type="button" className="aip-disclosure" aria-expanded={advancedOpen} onClick={onToggleAdvanced}>
          <Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          Advanced
        </button>
        <span className="aip-muted">· base URL{meta.id === 'z-ai' ? ', plan type' : ''}</span>
      </footer>
      {advancedOpen && <div className="aip-advanced">{advanced}</div>}
    </section>
  );
}

function CliSetup({ meta, status, cliPath, installing, onInstall, onCommitPath, onRecheck }: {
  meta: AiProviderMeta;
  status?: AiProviderStatus;
  cliPath: string;
  installing: boolean;
  onInstall: () => void;
  onCommitPath: (value: string) => void;
  onRecheck: () => void;
}) {
  const canInstall = Boolean(meta.installPackage) && !cliPath.trim();
  return (
    <section className="aip-card aip-setup" aria-label={`Set up ${shortLabel(meta)}`}>
      <h4 className="aip-card-title"><span>Step 1 · Install</span></h4>
      <p className="aip-hint" data-testid={`ai-provider-setup-hint-${meta.id}`}>
        Install the CLI, or set its path below, to turn this provider on. It switches on as soon as it is found.
      </p>
      <div className={`aip-options${canInstall ? '' : ' is-single'}`}>
        {canInstall && (
          <div className="aip-option">
            <div className="aip-option-head"><strong>Install the ACP adapter</strong><span className="chip aip-default-chip">Recommended</span></div>
            <code className="aip-cmd">npm i -g {meta.installPackage}</code>
            <p className="aip-hint">Uses npm, pnpm, yarn or bun — whichever is available. Praxis asks before installing; the package name is fixed.</p>
            <div className="aip-option-foot">
              <button type="button" className="btn btn-primary" data-testid={`ai-provider-install-${meta.id}`} disabled={installing} onClick={onInstall}>
                {installing ? 'Installing…' : `Install ${meta.defaultCommand ?? 'ACP'}`}
              </button>
            </div>
          </div>
        )}
        <div className="aip-option" data-setup-focus>
          <div className="aip-option-head"><strong>{canInstall ? 'Already installed elsewhere' : 'Point Praxis at the executable'}</strong></div>
          <p className="aip-hint">{meta.cliPathDescription ?? `Use an absolute path if "${meta.defaultCommand}" isn't on your PATH — a custom build or a version manager.`}</p>
          <DebouncedTextField ariaLabel={`${meta.label} CLI path`} value={cliPath} onCommit={onCommitPath} placeholder={meta.defaultCommand ? `/path/to/${meta.defaultCommand}` : 'Absolute path'} />
          <div className="aip-option-foot">
            <button type="button" className="btn" onClick={onRecheck}>Check again</button>
          </div>
        </div>
      </div>
      {meta.signIn && (
        <>
          <h4 className="aip-card-title aip-card-title--spaced"><span>Step 2 · Sign in once</span></h4>
          <SignInLine signIn={meta.signIn} />
        </>
      )}
      <footer className="aip-card-foot">
        <span className="aip-muted">Last check · {status ? (meta.notInstalledHint ?? `Not found: "${status.gatewayUrl}".`) : 'Checking…'}</span>
      </footer>
    </section>
  );
}

function CliPathRow({ meta, value, onCommit }: { meta: AiProviderMeta; value: string; onCommit: (value: string) => void }) {
  return (
    <Row label="Path override">
      <DebouncedTextField ariaLabel={`${meta.label} CLI path`} value={value} onCommit={onCommit} placeholder={meta.defaultCommand ?? 'Absolute path'} />
    </Row>
  );
}

function AcpVersionRow({ meta, status, latest, installing, onUpdate }: {
  meta: AiProviderMeta;
  status?: AiProviderStatus;
  latest: { version?: string; loading: boolean };
  installing: boolean;
  onUpdate: () => void;
}) {
  const current = status?.preflight?.providerVersion;
  const upToDate = Boolean(current && latest.version && current === latest.version);
  return (
    <section className="aip-row" aria-label={`${meta.label} ACP versions`} data-testid={`ai-provider-acp-versions-${meta.id}`}>
      <span className="aip-row-label">ACP package</span>
      <div className="aip-row-value">
        <span className="aip-mono" data-testid={`ai-provider-acp-current-${meta.id}`}>{current ? `v${current}` : 'Version unavailable'}</span>
        <span className="aip-muted" aria-hidden>→</span>
        <span className="aip-mono" data-testid={`ai-provider-acp-latest-${meta.id}`}>
          {latest.loading ? 'Checking…' : latest.version ? `v${latest.version}` : 'Could not check'}
        </span>
        {!latest.loading && latest.version && !upToDate && <span className="chip aip-info-chip">Update available</span>}
      </div>
      <div className="aip-row-actions">
        <button
          type="button"
          className={`btn btn-compact${!upToDate && latest.version ? ' btn-primary' : ''}`}
          data-testid={`ai-provider-update-${meta.id}`}
          disabled={installing || !latest.version || upToDate}
          onClick={onUpdate}
        >
          {installing ? 'Updating…' : upToDate ? 'Up to date' : 'Update ACP'}
        </button>
      </div>
    </section>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-compact"
      aria-label={`Copy ${command}`}
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function SignInLine({ signIn }: { signIn: NonNullable<AiProviderMeta['signIn']> }) {
  return (
    <div className="aip-signin">
      {signIn.command && <code className="aip-kbd">{signIn.command}</code>}
      <span className="aip-muted">{signIn.text}</span>
      {signIn.command && <CopyCommand command={signIn.command} />}
    </div>
  );
}

function SignInRow({ signIn }: { signIn: NonNullable<AiProviderMeta['signIn']> }) {
  return (
    <Row label="Sign-in" actions={signIn.command && <CopyCommand command={signIn.command} />}>
      {signIn.command && <code className="aip-kbd">{signIn.command}</code>}
      <span className="aip-muted">{signIn.text}</span>
    </Row>
  );
}

function ZaiPlanRow({ baseUrl, onChange }: { baseUrl?: string; onChange: (value: string) => void }) {
  const value = baseUrl === Z_AI_GENERAL ? 'general' : baseUrl === Z_AI_CODING || !baseUrl ? 'coding' : 'custom';
  return (
    <Row label="Plan type">
      <ChipSelect
        block
        ariaLabel="Z.ai plan type"
        data-testid="ai-z-ai-plan-select"
        value={value}
        onChange={next => {
          if (next === 'coding') onChange(Z_AI_CODING);
          else if (next === 'general') onChange(Z_AI_GENERAL);
        }}
        options={[
          { value: 'coding', label: 'GLM Coding Plan', description: Z_AI_CODING, meta: 'Recommended' },
          { value: 'general', label: 'General API / Pay-as-you-go', description: Z_AI_GENERAL },
          { value: 'custom', label: 'Custom base URL', description: 'Set in Endpoint' }
        ]}
      />
    </Row>
  );
}

function EndpointConnection({ custom, status, onEdit }: { custom: CustomProviderConfig; status?: AiProviderStatus; onEdit: () => void }) {
  const auth = custom.auth.kind === 'none' ? 'No key' : custom.auth.kind === 'header' ? `Key in “${custom.auth.name}” header` : 'Bearer key';
  return (
    <Card
      title="Connection"
      aside={<button type="button" className="btn btn-compact" data-testid={`ai-provider-edit-${custom.id}`} onClick={onEdit}>Edit connection…</button>}
    >
      <Row label="Endpoint"><span className="aip-mono aip-ellipsis">{custom.baseUrl}{custom.apiPath}</span></Row>
      <Row label="Authentication">
        <span>{auth}</span>
        {custom.auth.kind !== 'none' && (
          <span className="chip">{status?.configured ? 'key in the OS keychain' : 'no key saved'}</span>
        )}
      </Row>
      <Row label="Last test">
        {custom.capabilities ? (
          <div className="aip-caps" data-testid={`ai-provider-caps-${custom.id}`}>
            {(['models', 'chat', 'streamUsage', 'tools'] as const).map(capability => (
              <span
                key={capability}
                className={`aip-cap${custom.capabilities![capability] ? '' : ' is-missing'}`}
                data-capability={capability}
                data-ok={custom.capabilities![capability] ? 'true' : 'false'}
              >
                <Icon name={custom.capabilities![capability] ? 'check' : 'close'} size={10} />
                {CAPABILITY_LABELS[capability]}
              </span>
            ))}
          </div>
        ) : (
          <span className="aip-muted">Not tested yet — Edit connection runs the test.</span>
        )}
      </Row>
      {custom.capabilities && !custom.capabilities.tools && (
        <div className="aip-notice is-warn">
          <Icon name="warning" size={13} />
          <span>Chat only: without tool calling it answers quick recommendations but can’t run sessions, reviews or workflow stages.</span>
        </div>
      )}
    </Card>
  );
}

function ModelsCard({ meta, config, tiers, modelValue, commitModel, hasCatalog, onManageModels, showDefaultField }: {
  meta: AiProviderMeta;
  config: AiProviderConfig;
  tiers: { fast?: string; standard?: string; strong?: string };
  modelValue: string;
  commitModel: (value: string) => Promise<void>;
  hasCatalog: boolean;
  onManageModels: () => void;
  showDefaultField: boolean;
}) {
  const curated = config.enabledModelIds;
  return (
    <Card title="Models">
      {showDefaultField && meta.kind === 'api' && (
        <Row label="Default model">
          <DebouncedTextField
            ariaLabel={meta.id === 'vercel-gateway' ? 'AI default model' : `${meta.label} default model`}
            value={modelValue}
            onCommit={commitModel}
            placeholder={meta.modelPlaceholder ? `Service default — ${meta.modelPlaceholder}` : 'Service default'}
          />
        </Row>
      )}
      {hasCatalog && (
        <Row
          label="Offered in picker"
          actions={
            <button type="button" className="btn btn-compact" data-testid="ai-manage-models-btn" onClick={onManageModels}>
              Manage models <Icon name="arrow-right" size={11} />
            </button>
          }
        >
          {curated ? <span><strong>{curated.length}</strong> chosen from the catalog</span> : <span>Every model in the catalog</span>}
        </Row>
      )}
      <Row
        label="Workflow tiers"
        actions={hasCatalog && (
          <button type="button" className="btn btn-compact" onClick={onManageModels}>Edit tiers</button>
        )}
      >
        <span className="aip-tiers">
          {MODEL_TIER_NAMES.map(tier => (
            <span key={tier} className={`aip-tier${tiers[tier] ? '' : ' is-unset'}`} title={tiers[tier] ?? "Unset — uses the run's model"}>
              <i>{tier}</i>
              <span className="aip-ellipsis">{tiers[tier] ?? 'run’s model'}</span>
            </span>
          ))}
        </span>
      </Row>
    </Card>
  );
}

function UsageCard({ meta, sessions, spendLimit, onOpenUsage }: {
  meta: AiProviderMeta;
  sessions: readonly AgentSessionRecord[];
  spendLimit: number;
  onOpenUsage?: () => void;
}) {
  const spend = summariseSpend(sessions);
  const tokens = sessions.reduce((total, session) => total + (session.tokenUsage?.totalTokens ?? 0), 0);
  const money = spend.byCurrency.map(entry => new Intl.NumberFormat(undefined, { style: 'currency', currency: entry.currency }).format(entry.amount)).join(' + ');
  return (
    <Card
      title="Usage · last 30 days"
      testId={`ai-provider-usage-${meta.id}`}
      aside={onOpenUsage && <button type="button" className="aip-link-button" onClick={onOpenUsage}>AI Usage &amp; Spend <Icon name="arrow-right" size={11} /></button>}
    >
      <Row label="Sessions">
        <span><strong>{sessions.length}</strong>{tokens > 0 && <span className="aip-muted"> · {new Intl.NumberFormat(undefined, { notation: 'compact' }).format(tokens)} tokens</span>}</span>
      </Row>
      <Row label="Reported cost">
        {money
          ? <span><strong>{money}</strong></span>
          : <span className="aip-muted">{meta.kind === 'api' ? 'None reported — API providers report tokens, not cost.' : 'None reported yet.'}</span>}
      </Row>
      {(meta.id === 'openai' || meta.id === 'anthropic') && (
        <Row label="Account history" stacked>
          <p className="aip-hint">Optional organization Admin API key for {meta.label} account history in AI Usage. Separate from the model API key; stored in the OS keychain and never used for model requests.</p>
          <UsageAdminKeyField provider={meta.id} />
        </Row>
      )}
      {spendLimit > 0 && (
        <Row label="Spend limit"><span className="aip-muted">{spendLimit} across all providers — set in AI Usage &amp; Spend</span></Row>
      )}
    </Card>
  );
}

function UsageAdminKeyField({ provider }: { provider: AiProviderMeta['id'] }) {
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await window.praxis.aiUsage.setProviderUsageKey(provider, value);
      setDraft('');
      setSaved(Boolean(value.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the usage Admin API key.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-usage-admin-key">
      <div className="ai-key-controls">
        <input
          type="password"
          autoComplete="off"
          disabled={busy}
          className="input"
          data-testid="ai-usage-admin-key-input"
          aria-label="Usage Admin API key"
          placeholder={saved ? '••••••••  (saved)' : 'Optional admin key'}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <button type="button" className="btn btn-primary" data-testid="ai-usage-admin-key-save" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
          Save
        </button>
        <button type="button" className="btn" data-testid="ai-usage-admin-key-clear" disabled={busy} onClick={() => void save('')}>
          Clear
        </button>
      </div>
      <div aria-live="polite">
        {error && <p className="error-banner">{error}</p>}
        {!error && saved && <p className="settings-hint">Usage Admin API key saved.</p>}
      </div>
    </div>
  );
}
