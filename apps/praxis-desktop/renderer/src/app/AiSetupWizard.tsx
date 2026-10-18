import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { AiProvider, AiProviderStatus } from '@praxis/core';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';
import { isProviderUsable } from '../ai/providerAvailability';
import '../settings/aiProviders/aiProviders.css';

/** Set once the wizard has been completed (or an existing profile already had a usable provider). */
export const AI_ONBOARDED_KEY = 'praxis-ai-onboarded';

/** Whether a profile already has a provider that is set up and turned on. */
export function hasUsableProvider(statuses: readonly AiProviderStatus[]): boolean {
  return statuses.some(isProviderUsable);
}

interface SetupProvider {
  id: AiProvider;
  kind: 'api' | 'cli-agent';
  title: string;
  description: string;
  detail: string;
  keyLabel?: string;
  /** CLI agents: the command Praxis looks for, and the package it may install. */
  command?: string;
  installPackage?: string;
  /** Shown when a CLI cannot be found and cannot be installed from here. */
  hint?: string;
  tone: string;
  recommended?: boolean;
}

/**
 * A short list, not the whole catalogue: the providers most people start with.
 * Others (and any OpenAI-compatible endpoint) are added from Settings → AI Providers.
 * Mirrors `AI_PROVIDERS` in SettingsPage.tsx — kept local for the same reason.
 */
const SETUP_PROVIDERS: SetupProvider[] = [
  { id: 'claude-code-cli', kind: 'cli-agent', title: 'Claude Code', description: 'Run the Claude Code agent installed on this computer.', detail: 'Local agent · uses its own sign-in', command: 'claude-agent-acp', installPackage: '@agentclientprotocol/claude-agent-acp', tone: 'var(--tone-claude)', recommended: true },
  { id: 'codex-cli', kind: 'cli-agent', title: 'OpenAI Codex', description: 'Run the OpenAI Codex agent installed on this computer.', detail: 'Local agent · uses its own sign-in', command: 'codex-acp', installPackage: '@agentclientprotocol/codex-acp', tone: 'var(--tone-codex)' },
  { id: 'cursor-cli', kind: 'cli-agent', title: 'Cursor', description: 'Run the Cursor CLI agent installed on this computer.', detail: 'Local agent · uses its own sign-in', command: 'agent', hint: 'Install the Cursor CLI (agent) and sign in, then check again.', tone: 'var(--tone-cursor)' },
  { id: 'copilot-cli', kind: 'cli-agent', title: 'GitHub Copilot', description: 'Run the GitHub Copilot CLI with your GitHub login.', detail: 'Local agent · GitHub sign-in', command: 'copilot', hint: 'Install the GitHub Copilot CLI and sign in (gh auth login or GITHUB_TOKEN), then check again.', tone: 'var(--accent)' },
  { id: 'anthropic', kind: 'api', title: 'Anthropic', description: 'Connect with an Anthropic API key to use Claude models directly.', detail: 'API key · pay per use', keyLabel: 'Anthropic API key', tone: 'var(--tone-claude)' },
  { id: 'openai', kind: 'api', title: 'OpenAI', description: 'Connect with an OpenAI API key to use GPT models.', detail: 'API key · pay per use', keyLabel: 'OpenAI API key', tone: 'var(--tone-openai)' },
  { id: 'gemini', kind: 'api', title: 'Google Gemini', description: 'Connect with a Gemini API key to use Google models.', detail: 'API key · pay per use', keyLabel: 'Gemini API key', tone: 'var(--accent)' },
  { id: 'vercel-gateway', kind: 'api', title: 'Vercel AI Gateway', description: 'One key that reaches models from many providers.', detail: 'API key · many models', keyLabel: 'Vercel AI Gateway API key', tone: 'var(--accent)' },
  { id: 'z-ai', kind: 'api', title: 'Z.ai', description: 'Connect with a Z.ai key to use GLM models.', detail: 'API key · coding plan', keyLabel: 'Z.ai API key', tone: 'var(--accent)' }
];

const STEP_COPY = [
  { title: 'Which AI should Praxis work with?', detail: 'Use an agent you already have on this computer, or connect a cloud API with your own key. Pick one or more — you can add others any time in Settings.' },
  { title: 'Connect your providers', detail: 'Keys are stored in your operating system keychain. Local agents are found on this computer.' },
  { title: 'Review and finish', detail: 'Choose the provider new sessions start with. You can add or change providers any time in Settings.' }
] as const;

export function AiSetupWizard({ activeProvider, onSetDefault, onDone }: {
  activeProvider: AiProvider;
  onSetDefault: (provider: AiProvider) => Promise<void>;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<AiProvider[]>([]);
  const [statuses, setStatuses] = useState<AiProviderStatus[]>([]);
  const [verified, setVerified] = useState<Set<AiProvider>>(() => new Set());
  const [defaultId, setDefaultId] = useState<AiProvider>();
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => window.praxis.ai.listProviderStatuses().then(setStatuses).catch(() => undefined), []);
  useEffect(() => { void reload(); }, [reload]);

  const statusOf = (id: AiProvider) => statuses.find(status => status.provider === id);
  /** A CLI agent counts once its command resolves; an API key once its connection test passed. */
  const isReady = (provider: SetupProvider) => {
    const status = statusOf(provider.id);
    if (!status || !isProviderUsable(status)) return false;
    return provider.kind === 'cli-agent' || verified.has(provider.id);
  };
  const chosen = SETUP_PROVIDERS.filter(provider => selected.includes(provider.id));
  const ready = chosen.filter(isReady);
  const chosenDefault = ready.find(provider => provider.id === defaultId) ?? ready.find(provider => provider.id === activeProvider) ?? ready[0];

  // A "connect one" error is answered the moment one connects.
  useEffect(() => { if (ready.length > 0) setError(undefined); }, [ready.length]);

  const toggle = (id: AiProvider) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  /** Everything chosen is already usable (a found local agent needs nothing more), so Connect has no work to do. */
  const nothingToConnect = chosen.length > 0 && chosen.every(isReady);
  const next = () => {
    setError(undefined);
    if (step === 0 && selected.length === 0) { setError('Choose at least one AI provider to continue.'); return; }
    if (step === 1 && ready.length === 0) { setError('Connect at least one provider to continue.'); return; }
    setStep(value => Math.min(STEP_COPY.length - 1, step === 0 && nothingToConnect ? 2 : value + 1));
  };
  const back = () => {
    setError(undefined);
    setStep(value => (value === 2 && nothingToConnect ? 0 : value - 1));
  };
  const footerNote = step === 0 && chosen.length > 0
    ? nothingToConnect
      ? `${chosen.map(provider => provider.title).join(', ')} ${chosen.length === 1 ? 'is' : 'are'} ready — nothing to connect, so Continue goes straight to the review.`
      : `${chosen.length} selected · Continue to connect ${chosen.filter(provider => !isReady(provider)).map(provider => provider.title).join(', ')}`
    : ready.length > 0 ? `${ready.length} provider${ready.length === 1 ? '' : 's'} connected` : 'No provider connected yet';
  const finish = async () => {
    if (!chosenDefault || finishing) return;
    setFinishing(true);
    setError(undefined);
    try {
      await onSetDefault(chosenDefault.id);
      try { localStorage.setItem(AI_ONBOARDED_KEY, '1'); } catch { /* private mode */ }
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setFinishing(false);
    }
  };

  return <div className="project-onboarding-frame" data-testid="ai-setup-onboarding">
    <div className="project-wizard project-wizard-onboarding ai-setup-wizard" data-testid="ai-setup-wizard">
      <header className="project-wizard-header">
        <div className="project-dialog-heading"><span className="project-dialog-brand">PRAXIS<i /></span><div><h1>Set up AI</h1><p>Connect at least one provider before you start.</p></div></div>
        <div className="project-dialog-header-actions">
          <ol className="ai-setup-stepper" aria-label={`Step ${step + 1} of ${STEP_COPY.length}`}>
            {['Choose', 'Connect', 'Review'].map((name, index) => (
              <li key={name} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>{index + 1} {name}</li>
            ))}
          </ol>
        </div>
      </header>
      <div className="wizard-progress" style={{ gridTemplateColumns: `repeat(${STEP_COPY.length}, 1fr)` }} aria-label={`Step ${step + 1} of ${STEP_COPY.length}`}>{STEP_COPY.map((_, index) => <span key={index} className={index <= step ? 'active' : ''} />)}</div>
      <div className="project-wizard-body">
        <div className="wizard-step-intro"><div><h2>{STEP_COPY[step].title}</h2><p>{STEP_COPY[step].detail}</p></div></div>
        {step === 0 && <ProviderChoices selected={selected} statuses={statuses} onToggle={toggle} />}
        {step === 1 && <div className="ai-setup-connect-list">{chosen.map(provider => <ConnectCard key={provider.id} provider={provider} status={statusOf(provider.id)} ready={isReady(provider)} reload={reload} onVerified={() => setVerified(current => new Set(current).add(provider.id))} />)}</div>}
        {step === 2 && <ReviewStep providers={ready} defaultId={chosenDefault?.id} onDefault={setDefaultId} />}
        {error && <div className="form-error" role="alert" data-testid="ai-setup-error">{error}</div>}
      </div>
      <footer className="project-wizard-footer">
        <span className="ai-setup-footer-note" data-testid="ai-setup-footer-note">
          {chosen.length > 0 && step === 0 && <span className={`aip-dot ${nothingToConnect ? 'is-ok' : 'is-warn'}`} aria-hidden />}
          {footerNote}
        </span>
        <div className="footer-actions">
          {step > 0 && <button className="btn" type="button" onClick={back}>Back</button>}
          {step < STEP_COPY.length - 1
            ? <button className="btn btn-primary" type="button" data-testid="ai-setup-continue" onClick={next}>Continue</button>
            : <button className="btn btn-primary" type="button" data-testid="ai-setup-finish" disabled={!chosenDefault || finishing} onClick={() => void finish()}>{finishing ? 'Finishing…' : 'Start using Praxis'}</button>}
        </div>
      </footer>
    </div>
  </div>;
}

/**
 * Step 1: local agents this computer already has come first (one click, nothing to set up), then the
 * cloud APIs. A local agent that isn't installed stays choosable — step 2 can install it.
 */
function ProviderChoices({ selected, statuses, onToggle }: { selected: AiProvider[]; statuses: AiProviderStatus[]; onToggle: (id: AiProvider) => void }) {
  const found = (provider: SetupProvider) => provider.kind === 'cli-agent' && statuses.some(status => status.provider === provider.id && status.configured);
  const local = SETUP_PROVIDERS.filter(provider => provider.kind === 'cli-agent');
  const foundAgents = local.filter(found);
  const missingAgents = local.filter(provider => !found(provider));
  const apis = SETUP_PROVIDERS.filter(provider => provider.kind === 'api');
  const choice = (provider: SetupProvider, variant: 'found' | 'compact') => {
    const isSelected = selected.includes(provider.id);
    const isFound = found(provider);
    return <button key={provider.id} type="button" data-testid={`ai-setup-choice-${provider.id}`} className={`ai-setup-option is-${variant}${isSelected ? ' selected' : ''}`} style={{ '--provider-tone': provider.tone } as CSSProperties} aria-pressed={isSelected} onClick={() => onToggle(provider.id)}>
      <span className="ai-setup-option-mark">
        <ProviderBrandLogo provider={provider.id} size={variant === 'found' ? 34 : 24} decorative />
        {provider.kind === 'cli-agent' && <span className="aip-mark-badge" aria-hidden>›_</span>}
      </span>
      <span className="ai-setup-option-text">
        <strong>{provider.title}{provider.recommended && variant === 'found' && <span className="chip aip-default-chip">Recommended</span>}</strong>
        {variant === 'found'
          ? <><span className="ai-setup-option-status"><span className="aip-dot is-ok" aria-hidden />Found on this computer</span><small>{provider.description}</small></>
          : <small>{provider.kind === 'api' ? provider.detail : isFound ? 'Found on this computer' : provider.installPackage ? 'Not found · Praxis can install it next' : 'Not found · install it, then check again'}</small>}
      </span>
      <span className={`ai-setup-option-check${isSelected ? ' on' : ''}`} aria-hidden>{isSelected ? '✓' : ''}</span>
    </button>;
  };
  return <div className="ai-setup-choices">
    {foundAgents.length > 0 && <section aria-label="Found on this computer">
      <h3 className="aip-card-title"><span>Found on this computer</span></h3>
      <div className="ai-setup-found">{foundAgents.map(provider => choice(provider, 'found'))}</div>
    </section>}
    <section aria-label="Use an API key">
      <h3 className="aip-card-title"><span>{foundAgents.length > 0 ? 'Or use an API key' : 'Use an API key'}</span></h3>
      <div className="ai-setup-compact">{apis.map(provider => choice(provider, 'compact'))}</div>
    </section>
    {missingAgents.length > 0 && <section aria-label="Other local agents">
      <h3 className="aip-card-title"><span>Other local agents</span></h3>
      <div className="ai-setup-compact">{missingAgents.map(provider => choice(provider, 'compact'))}</div>
    </section>}
    <p className="ai-setup-more">20+ more — OpenRouter, Groq, Ollama, LM Studio, any OpenAI-compatible server — in Settings → AI Providers.</p>
    <div className="ai-setup-trust">
      <div><strong>Keys stay on this computer</strong><span>API keys go to the OS keychain and are never shown again.</span></div>
      <div><strong>You choose per session</strong><span>Each session runs on the provider you pick for it, and can switch in the composer.</span></div>
      <div><strong>Change any time</strong><span>Add, switch or remove providers in Settings → AI Providers.</span></div>
    </div>
  </div>;
}

function ConnectCard({ provider, status, ready, reload, onVerified }: { provider: SetupProvider; status?: AiProviderStatus; ready: boolean; reload: () => Promise<unknown>; onVerified: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const cli = provider.kind === 'cli-agent';

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const text = await action();
      if (text) setMessage({ tone: 'ok', text });
    } catch (reason) {
      setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  };
  const connect = () => run(async () => {
    await window.praxis.ai.setProviderApiKey(provider.id, key.trim());
    setKey('');
    await reload();
    try {
      const result = await window.praxis.ai.testProviderApiKey(provider.id);
      onVerified();
      return result.message;
    } catch (reason) {
      throw new Error(`Key saved, but the connection test failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  });
  const install = () => run(async () => {
    const result = await window.praxis.ai.installCliProvider(provider.id);
    await reload();
    return result.message;
  });
  const recheck = () => run(async () => {
    await reload();
  });

  return <section className={`ai-setup-card${ready ? ' ready' : ''}`} data-testid={`ai-setup-card-${provider.id}`} style={{ '--provider-tone': provider.tone } as CSSProperties}>
    <span className="ai-setup-card-mark"><ProviderBrandLogo provider={provider.id} size={30} /></span>
    <div className="ai-setup-card-body">
      <header><strong>{provider.title}</strong><span className={`ai-setup-state${ready ? ' ready' : ''}`}>{ready ? '✓ Connected' : cli ? (status?.configured ? 'Found' : 'Not found') : 'Needs a key'}</span></header>
      {cli ? <>
        <p>{status?.configured
          ? `Praxis will run "${status.gatewayUrl}". Sign in with the CLI's own auth if it asks.`
          : provider.installPackage
            ? `"${provider.command}" was not found on this computer. Praxis can install ${provider.installPackage} globally with your package manager.`
            : provider.hint}</p>
        <div className="ai-key-controls">
          {!status?.configured && provider.installPackage && <button type="button" className="btn btn-primary" disabled={busy} data-testid={`ai-setup-install-${provider.id}`} onClick={() => void install()}>{busy ? 'Installing…' : 'Install'}</button>}
          {!ready && <button type="button" className="btn" disabled={busy} data-testid={`ai-setup-recheck-${provider.id}`} onClick={() => void recheck()}>Check again</button>}
        </div>
      </> : <>
        <label className="field"><span>{provider.keyLabel}</span>
          <div className="ai-key-controls">
            <input className="input" type="password" autoComplete="off" spellCheck={false} data-testid={`ai-setup-key-${provider.id}`} aria-label={provider.keyLabel} placeholder={ready ? '•••••••• (saved)' : 'Paste your key'} value={key} onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && key.trim() && !busy) void connect(); }} />
            <button type="button" className="btn btn-primary" disabled={busy || !key.trim()} data-testid={`ai-setup-connect-${provider.id}`} onClick={() => void connect()}>{busy ? 'Testing…' : 'Save & test'}</button>
          </div>
        </label>
      </>}
      {message && <div className={`ai-setup-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    </div>
  </section>;
}

function ReviewStep({ providers, defaultId, onDefault }: { providers: SetupProvider[]; defaultId?: AiProvider; onDefault: (id: AiProvider) => void }) {
  return <div className="review-summary ai-setup-review">
    <header className="review-summary-heading"><span>Ready</span><div><h2>{providers.length} provider{providers.length === 1 ? '' : 's'} connected</h2></div><p>New sessions start with your default. You can switch provider and model per session, and manage everything in Settings → AI Providers.</p></header>
    <div className="ai-setup-default-list" role="radiogroup" aria-label="Default provider">{providers.map(provider => <button key={provider.id} type="button" role="radio" aria-checked={provider.id === defaultId} data-testid={`ai-setup-default-${provider.id}`} className={`start-choice ai-setup-default${provider.id === defaultId ? ' selected' : ''}`} style={{ '--provider-tone': provider.tone } as CSSProperties} onClick={() => onDefault(provider.id)}>
      <span className="radio-dot" />
      <span><strong><ProviderBrandLogo provider={provider.id} size={14} className="ai-setup-default-logo" /> {provider.title}</strong><small>{provider.id === defaultId ? 'Default for new sessions' : provider.detail}</small></span>
    </button>)}</div>
    <p className="review-summary-note"><span>✓</span>Nothing runs until you start a session.</p>
  </div>;
}
