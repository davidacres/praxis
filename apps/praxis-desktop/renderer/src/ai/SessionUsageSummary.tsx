import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, AiProvider, AiUsageEvent, ProviderUsageSnapshot, ProviderUsageWindow } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';
import { providerLabel } from './modelProviders';
import { formatCost, formatTokenCompact, sessionLimitNotice } from './sessionNav';
import { countdown, isQuota, windowPercent } from './ProviderUsageWindows';
import { sessionUsageData } from './sessionUsageData';
import './sessionUsageSummary.css';

function formatAccountCost(amount: number, currency: string) {
  // A zero balance is meaningful; the session cost badge formatter deliberately hides it.
  return formatCost({ amount, currency }) ?? `${amount.toFixed(2)} ${currency}`;
}

function windowLabel(window: ProviderUsageWindow) {
  if (window.period === 'week') return 'Wk';
  if (window.period === 'month') return 'Mo';
  if (window.period === 'day') return 'Day';
  if (window.windowDurationMinutes) return window.windowDurationMinutes % 60 === 0
    ? `${window.windowDurationMinutes / 60}h` : `${window.windowDurationMinutes}m`;
  // Older adapters supplied a label before duration was added to the contract.
  if (window.period === 'hour' && /5[- ]?hour/i.test(window.label ?? '')) return '5h';
  return 'Hour';
}

function Limit({ window, provider, now, expanded = false }: {
  window: ProviderUsageWindow; provider: AiProvider; now: number; expanded?: boolean;
}) {
  const quota = isQuota(window);
  const percent = quota ? windowPercent(window) : undefined;
  const consumptionCost = window.usedCost !== undefined
    ? window.currency ? formatAccountCost(window.usedCost, window.currency) : window.usedCost.toFixed(2)
    : undefined;
  const value = percent !== undefined ? `${Math.round(percent)}%`
    : window.usedTokens !== undefined ? `${formatTokenCompact(window.usedTokens)} tok`
      : consumptionCost ?? 'Not reported';
  const reset = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? countdown(window.resetsAt, now) : undefined;
  const label = expanded ? window.label ?? windowLabel(window) : windowLabel(window);
  const title = `${providerLabel(provider)} · ${window.label ?? label}: ${value}${quota ? ' used' : ' consumption; limit not reported'}${reset ? ` · resets in ${reset}` : ' · reset not reported'}`;
  return <span className={`composer-usage-limit${percent !== undefined && percent >= 100 ? ' is-limit' : percent !== undefined && percent >= 80 ? ' is-warn' : ''}`}
    title={title} aria-label={title} data-provider={provider} data-period={window.period} data-testid={`session-usage-meter-${window.period}`}>
    <span className="composer-usage-limit-value"><span className="composer-usage-muted">{label}</span> <strong>{value}</strong>
      {quota && <span className="composer-usage-limit-track" role="progressbar" aria-label={`${providerLabel(provider)} ${window.label ?? label} used`}
        aria-valuenow={Math.max(0, Math.min(100, percent!))} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(0, Math.min(100, percent!))}%` }} />
      </span>}
    </span>
    {expanded && <small>{reset ? `↻ ${reset}` : 'Reset not reported'}</small>}
  </span>;
}

export function SessionUsageSummary({ session, sessions, usageSessions, spendLimit, onHide, draftProvider, draftModel, activityLabel }: {
  session?: AgentSessionRecord;
  sessions: AgentSessionRecord[];
  /** Several runtime sessions can belong to one assistant conversation. */
  usageSessions?: AgentSessionRecord[];
  spendLimit: number;
  onHide?: () => void;
  draftProvider?: AiProvider;
  draftModel?: string;
  activityLabel?: string;
}) {
  const speaker = session?.conversation?.state === 'running'
    ? session.conversation.participants.find(item => item.id === session.conversation?.currentSpeakerId) : undefined;
  const selectedProvider = speaker?.provider ?? draftProvider ?? session?.provider;
  const selectedModel = speaker ? speaker.model : draftProvider !== undefined ? draftModel : session?.model;
  const records = useMemo(() => [...new Map([...(usageSessions ?? []), ...(session ? [session] : [])]
    .map(record => [record.sessionId, record])).values()], [session, usageSessions]);
  const recordsKey = JSON.stringify(records.map(record => [record.sessionId, record.cost, record.tokenUsage, record.runtimeEpochs]));
  const [ledger, setLedger] = useState<{ key: string; events: AiUsageEvent[] }>();
  const data = sessionUsageData(records, selectedProvider, selectedModel, ledger?.key === recordsKey ? ledger.events : []);
  const providerKey = JSON.stringify(data.providers.map(item => item.provider));
  const [accounts, setAccounts] = useState<{ key: string; snapshots: ProviderUsageSnapshot[] }>();
  const accountsLoaded = accounts?.key === providerKey;
  const snapshots = accountsLoaded ? accounts.snapshots : [];
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (records.length) void window.praxis.aiUsage.listEvents().then(events => {
      if (!cancelled) setLedger({ key: recordsKey, events });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [recordsKey]);

  useEffect(() => {
    let cancelled = false;
    const providers: AiProvider[] = JSON.parse(providerKey);
    const refresh = () => {
      if (!providers.length) return;
      void window.praxis.aiUsage.providerSnapshots(providers).then(result => {
        if (!cancelled) { setAccounts({ key: providerKey, snapshots: result.snapshots }); setNow(Date.now()); }
      }).catch(() => {
        if (!cancelled) setAccounts({ key: providerKey, snapshots: providers.map(provider => ({ provider, fetchedAt: new Date().toISOString(), windows: [], unavailableReason: 'Account usage could not be refreshed.' })) });
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [providerKey]);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (detailsRef.current?.contains(document.activeElement)) detailsRef.current.querySelector('summary')?.focus();
        setOpen(false);
      }
    };
    document.addEventListener('click', pointer);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', pointer); document.removeEventListener('keydown', key); };
  }, [open]);

  const tokens = (value: { tokens?: number; partial: boolean }) => value.tokens === undefined ? 'Not reported' : `${formatTokenCompact(value.tokens)}${value.partial ? '+' : ''} tok`;
  const tokenTitle = (value: { tokens?: number; partial: boolean }) => value.tokens === undefined ? 'Session tokens not reported'
    : `${Math.round(value.tokens).toLocaleString()} session tokens${value.partial ? ' reported; some runtime usage is unavailable' : ''}`;
  const costs = (value: { costs: NonNullable<AgentSessionRecord['cost']>[] }) => value.costs.map(formatCost).join(' + ');
  const account = (provider: AiProvider) => snapshots.find(item => item.provider === provider);
  const allWindows = data.providers.flatMap(item => (account(item.provider)?.windows ?? []).map(window => ({ provider: item.provider, window })))
    .sort((a, b) => ['hour', 'day', 'week', 'month'].indexOf(a.window.period) - ['hour', 'day', 'week', 'month'].indexOf(b.window.period));
  const spendRatio = spendLimit > 0 ? sessions.reduce((sum, item) => sum + (item.cost?.amount ?? 0), 0) / spendLimit : 0;
  const limitNotice = session && (session.providerLimitReached || sessionLimitNotice(session));

  return <details className="session-usage-summary composer-usage-compact" ref={detailsRef} open={open} onToggle={event => setOpen(event.currentTarget.open)} data-testid="session-usage-summary">
    <summary title="Expand or collapse session usage" onClick={event => { event.preventDefault(); setOpen(value => !value); }}>
      <span className="composer-usage-current" title={`${selectedProvider ? providerLabel(selectedProvider) : 'AI'} · ${selectedModel ?? 'Default model'}`}>
        {selectedProvider ? <ProviderBrandLogo provider={selectedProvider} size={18} decorative /> : <Icon name="graph" size={16} />}
        {open && selectedProvider && <span className="composer-usage-current-provider">{providerLabel(selectedProvider)} ·</span>}
        <strong data-testid="session-usage-current">{selectedModel ?? 'Default model'}</strong>
      </span>
      {limitNotice && <span className="composer-usage-limit-alert" role="img" aria-label="Provider limit reached" title={session?.lastError ?? 'Provider limit reached'}><Icon name="warning" size={13} /></span>}
      {open ? <span className="composer-usage-expanded-current" title={data.current && tokenTitle(data.current)}>
        <strong>{data.current ? tokens(data.current) : 'Not reported'}{data.current && costs(data.current) ? ` · ${costs(data.current)}` : ''}</strong>
        <small>Current model in session</small>
      </span> : <span className="composer-usage-inline" data-testid="session-usage-inline">
        <span className="composer-usage-pair composer-usage-provider-icons" aria-label="Providers in order">
          {data.providers.map(item => <span key={item.provider} title={providerLabel(item.provider)} aria-label={providerLabel(item.provider)}><ProviderBrandLogo provider={item.provider} size={16} decorative /></span>)}
        </span>
        <span className="composer-usage-pair composer-usage-token-pair">
          {data.providers.map(item => <span key={item.provider} title={`${providerLabel(item.provider)} · ${tokenTitle(item)}`} aria-label={`${providerLabel(item.provider)} ${tokenTitle(item)}`} data-testid={`session-usage-tokens-${item.provider}`}>{tokens(item)}</span>)}
        </span>
        {allWindows.map(({ provider, window }, index) => <Limit key={`${provider}-${index}`} window={window} provider={provider} now={now} />)}
        {data.providers.filter(item => !account(item.provider)?.windows.length).map(item => <span className="composer-usage-unreported" key={item.provider} title={`${providerLabel(item.provider)}: ${account(item.provider)?.unavailableReason ?? (accountsLoaded ? 'Provider returned no account limits' : 'Account limits are loading')}`}>{accountsLoaded ? 'Limits not reported' : 'Limits loading…'}</span>)}
      </span>}
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      {onHide && <button type="button" className="icon-btn icon-btn-sm session-usage-hide-btn" aria-label="Hide usage bar" title="Hide usage bar" data-testid="session-usage-hide-btn"
        onClick={event => { event.preventDefault(); event.stopPropagation(); onHide(); }}><Icon name="close" size={12} /></button>}
    </summary>
    {open && <div className="composer-usage-expanded" data-testid="session-usage-expanded">
      {(activityLabel || records.length === 0) && <small className="composer-usage-muted">{activityLabel ?? 'No usage recorded for this session yet'}</small>}
      <div className="composer-usage-provider-list" role="group" aria-label="Provider account limits across all sessions">
        {data.providers.map(item => {
          const snapshot = account(item.provider);
          return <div className="composer-usage-provider-row" key={item.provider} data-testid={`session-usage-provider-${item.provider}`}>
            <span className="composer-usage-provider-name"><ProviderBrandLogo provider={item.provider} size={20} decorative /><strong>{providerLabel(item.provider)}</strong></span>
            <span className="composer-usage-provider-tokens" title={`${tokenTitle(item)}${costs(item) ? ` · ${costs(item)}` : ''}`}>{tokens(item)}</span>
            <span className="composer-usage-provider-limits">
              {snapshot?.windows.map((window, index) => <Limit key={index} window={window} provider={item.provider} now={now} expanded />)}
              {!snapshot?.windows.length && <span className="composer-usage-unreported" title={snapshot?.unavailableReason}>{snapshot ? 'Limits not reported' : 'Loading limits…'}</span>}
              {snapshot?.credits && <span className="composer-usage-credit">{formatAccountCost(snapshot.credits.remaining, snapshot.credits.currency)}<small>Credit balance</small></span>}
            </span>
          </div>;
        })}
      </div>
      <details className="composer-usage-history" data-testid="session-usage-models">
        <summary title="Tokens are session usage. Limits are shared account usage, shown as percentages used. + means partial reporting."><span>Session total <span className="composer-usage-muted">· {data.providers.length} provider{data.providers.length === 1 ? '' : 's'} · {data.models.length} model{data.models.length === 1 ? '' : 's'}</span></span><span title={tokenTitle(data.total)}>{tokens(data.total)}{costs(data.total) ? ` · ${costs(data.total)}` : ''} <Icon name="chevron-down" size={12} /></span></summary>
        <div className="composer-usage-model-list">{data.models.map(item => <div className="composer-usage-model-row" key={JSON.stringify([item.provider, item.model])}>
          <span className="composer-usage-model-name"><ProviderBrandLogo provider={item.provider} size={16} decorative /><span title={providerLabel(item.provider)}>{item.model ?? 'Default model'}{item.provider === selectedProvider && item.model === selectedModel && <small>Current</small>}</span></span>
          <span title={tokenTitle(item)}>{tokens(item)}{costs(item) ? ` · ${costs(item)}` : ''}</span>
        </div>)}</div>
      </details>
      {limitNotice && <div className="session-usage-warning-banner is-critical"><Icon name="warning" size={13} />{session?.lastError ?? 'Provider limit reached'}</div>}
      {spendRatio >= 0.8 && <div className={`session-usage-warning-banner${spendRatio >= 1 ? ' is-critical' : ''}`}><Icon name="warning" size={13} />{spendRatio >= 1 ? 'Your Praxis spend limit has been exceeded.' : 'You are approaching your Praxis spend limit.'}</div>}
    </div>}
  </details>;
}
