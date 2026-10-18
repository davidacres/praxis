import { formatLargeTokenCount } from '../ai/usageTokenFormat';
import { useEffect, useRef, useState } from 'react';
import type { AiProvider, ProviderUsageHistory } from '@praxis/core';
import { providerLabel } from '../ai/modelProviders';

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'claude-code-cli', 'codex-cli'];
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function HistoryRow({ provider }: { provider: AiProvider }) {
  const [history, setHistory] = useState<ProviderUsageHistory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const api = provider === 'openai' || provider === 'anthropic';
  async function load() {
    setBusy(true);
    setError(undefined);
    setHistory(undefined);
    try {
      const result = await window.praxis.aiUsage.providerHistory(provider);
      if (mounted.current) setHistory(result);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="provider-history-row" data-testid={`provider-history-${provider}`}>
      <div className="provider-history-heading">
        <h4>{providerLabel(provider)}</h4>
        <button className="btn btn-quiet" type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Fetching history…' : history ? 'Refresh history' : 'Fetch history'}</button>
      </div>
      <p className="settings-section-description">{api ? `Organization API history. Configure its Admin API key in Settings → AI Providers → ${providerLabel(provider)}. Subscription usage is separate.` : provider === 'claude-code-cli' ? 'Local Claude Code statistics on this device.' : 'Cumulative summary, when supported by the installed Codex CLI.'}</p>
      <div aria-live="polite">
        {error && <p className="error-banner">{error}</p>}
        {history && <>
          {history.unavailableReason ? <p>{history.unavailableReason}</p> : <p><strong data-testid={`provider-history-total-${provider}`}>{history.totalTokens === undefined ? '—' : formatLargeTokenCount(history.totalTokens) ?? `${history.totalTokens.toLocaleString()} tokens`}</strong></p>}
          {history.requestedFrom && history.requestedTo && <p className="settings-section-description">Queried {date(history.requestedFrom)} – {date(history.requestedTo)} (UTC).{history.firstUsageAt ? ` First returned usage: ${date(history.firstUsageAt)}.` : ' No usage returned in this range.'}</p>}
          <p className="settings-section-description">{history.note}</p>
          <small>Checked {new Date(history.fetchedAt).toLocaleString()}</small>
        </>}
      </div>
    </div>
  );
}

export function ProviderUsageHistorySection() {
  return <section className="provider-history-section" data-testid="provider-history-section" aria-label="Provider account history">
    <h3>Provider account history</h3>
    <p className="settings-section-description">Fetch older token usage directly from supported providers. These totals stay separate from usage recorded by Praxis and may include other apps. Provider retention can limit coverage; they are not guaranteed totals since account creation.</p>
    <div className="provider-history-grid">{PROVIDERS.map(provider => <HistoryRow key={provider} provider={provider} />)}</div>
    <p className="settings-section-description">Other providers do not yet have a historical usage integration in Praxis.</p>
  </section>;
}
