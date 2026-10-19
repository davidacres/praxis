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

const severity = (percent: number) => percent >= 100 ? ' is-limit' : percent >= 80 ? ' is-warn' : '';

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
      : consumptionCost ?? '–';
  const reset = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? countdown(window.resetsAt, now) : undefined;
  const label = expanded ? window.label ?? windowLabel(window) : windowLabel(window);
  const title = `${providerLabel(provider)} · ${window.label ?? label}: ${value}${quota ? ' used' : value === '–' ? ' (not available)' : ' consumption; no limit shared'}${reset ? ` · resets in ${reset}` : ''}`;
  return <span className={`composer-usage-limit${percent !== undefined ? severity(percent) : ''}`}
    title={title} aria-label={title} data-provider={provider} data-period={window.period} data-testid={`session-usage-meter-${window.period}`}>
    <span className="composer-usage-limit-value"><span className="composer-usage-muted">{label}</span> <strong>{value}</strong>
      {quota && <span className="composer-usage-limit-track" role="progressbar" aria-label={`${providerLabel(provider)} ${window.label ?? label} used`}
        aria-valuenow={Math.max(0, Math.min(100, percent!))} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(0, Math.min(100, percent!))}%` }} />
      </span>}
    </span>
    {expanded && reset && <small>↻ {reset}</small>}
  </span>;
}

// The collapsed strip always shows these two rows per provider, so every provider reads the same way.
const CHART_SLOTS: Array<{ period: 'hour' | 'week'; name: string; pick: (windows: ProviderUsageWindow[]) => ProviderUsageWindow | undefined }> = [
  { period: 'hour', name: '5-hour window', pick: windows => windows.find(window => window.period === 'hour' && window.windowDurationMinutes === 300) ?? windows.find(window => window.period === 'hour') },
  { period: 'week', name: 'Weekly', pick: windows => windows.find(window => window.period === 'week') }
];

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A percentage that eases from its last value to `target`: from 0 when the data first lands,
 * from the old figure on a later refresh. Bar width and label both read it, so they stay in step.
 */
function useAnimatedPercent(target: number, durationMs = 600): number {
  const [value, setValue] = useState(() => reducedMotion() ? target : 0);
  const shown = useRef(value);
  useEffect(() => {
    if (reducedMotion()) { shown.current = target; setValue(target); return; }
    const from = shown.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      shown.current = from + (target - from) * (1 - (1 - t) ** 3);
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return value;
}

/** One reported row: colour, tooltip and accessible value use the real figure; only the drawing animates. */
function ChartRow({ provider, period, name, line, percent }: { provider: AiProvider; period: string; name: string; line: string; percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const shown = useAnimatedPercent(clamped);
  return <span className={`composer-usage-limit composer-usage-chart-row${severity(percent)}`}
    aria-label={`${providerLabel(provider)} · ${line}`} data-provider={provider} data-period={period} data-reported="true" data-testid={`session-usage-meter-${period}`}>
    <span className="composer-usage-limit-track" role="progressbar" aria-label={`${providerLabel(provider)} ${name} used`}
      aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${shown}%` }} />
    </span>
    <strong>{Math.round(percent > 100 ? shown * percent / 100 : shown)}%</strong>
  </span>;
}

/**
 * One provider's limits as a two-row bar chart: 5-hour on top, weekly below. Replaces a
 * `5h 32% ▬ Wk 61% ▬` pair per provider; the window names move to the tooltip and accessible
 * labels, where the reset times already were. A window the provider does not report keeps its
 * row as an empty grey bar, so a gap is visible rather than silently missing. Other windows
 * (daily spend, monthly) appear only in the expanded panel.
 */
function LimitChart({ windows, provider, now, unavailable, loading = false }: {
  windows: ProviderUsageWindow[]; provider: AiProvider; now: number; unavailable?: string; loading?: boolean;
}) {
  // Loading: both rows sweep back and forth instead of sitting empty, and show no numbers yet.
  if (loading) return <span className="composer-usage-chart is-loading" role="group" aria-label={`${providerLabel(provider)} account limits loading`}
    aria-busy="true" title={`${providerLabel(provider)}\nAccount limits are loading`} data-provider={provider} data-testid="session-usage-chart">
    {CHART_SLOTS.map(slot => <span key={slot.period} className="composer-usage-limit composer-usage-chart-row is-loading"
      data-provider={provider} data-period={slot.period} data-testid={`session-usage-meter-${slot.period}`}>
      <span className="composer-usage-limit-track"><span /></span>
      {/* Invisible, so the chart is already the size it will be once figures land: no jump. */}
      <strong aria-hidden="true" className="composer-usage-chart-placeholder">0%</strong>
    </span>)}
  </span>;
  const quotas = windows.filter(isQuota);
  const rows = CHART_SLOTS.map(slot => {
    const window = slot.pick(quotas);
    if (!window) return { slot, name: slot.name, line: `${slot.name}: not available` };
    const percent = windowPercent(window);
    const name = window.label ?? slot.name;
    const reset = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? countdown(window.resetsAt, now) : undefined;
    return { slot, name, percent, line: `${name}: ${Math.round(percent)}% used${reset ? ` · resets in ${reset}` : ''}` };
  });
  const title = [providerLabel(provider), ...rows.map(row => row.line), ...(unavailable ? [unavailable] : [])].join('\n');
  return <span className="composer-usage-chart" role="group" aria-label={`${providerLabel(provider)} account limits`} title={title}
    data-provider={provider} data-testid="session-usage-chart">
    {rows.map(({ slot, name, percent, line }) => percent === undefined
      ? <span key={slot.period} className="composer-usage-limit composer-usage-chart-row is-unreported" aria-label={`${providerLabel(provider)} · ${line}`}
        data-provider={provider} data-period={slot.period} data-reported="false" data-testid={`session-usage-meter-${slot.period}`}>
        <span className="composer-usage-limit-track" />
        <strong aria-hidden="true">–</strong>
      </span>
      : <ChartRow key={slot.period} provider={provider} period={slot.period} name={name} line={line} percent={percent} />)}
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

  // Before the first turn there is no session record: it has used nothing, which is not the same as unreported.
  const notStarted = records.length === 0;
  const tokens = (value: { tokens?: number; partial: boolean }) => value.tokens === undefined ? (notStarted ? '0 tok' : '–') : `${formatTokenCompact(value.tokens)}${value.partial ? '+' : ''} tok`;
  const tokenTitle = (value: { tokens?: number; partial: boolean }) => value.tokens === undefined ? (notStarted ? 'No tokens used in this session yet' : 'Token count not available from this provider')
    : `${Math.round(value.tokens).toLocaleString()} session tokens${value.partial ? ' reported; some runtime usage is unavailable' : ''}`;
  const costs = (value: { costs: NonNullable<AgentSessionRecord['cost']>[] }) => value.costs.map(formatCost).join(' + ');
  const account = (provider: AiProvider) => snapshots.find(item => item.provider === provider);
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
        <strong>{data.current ? tokens(data.current) : notStarted ? '0 tok' : '–'}{data.current && costs(data.current) ? ` · ${costs(data.current)}` : ''}</strong>
        <small>Current model in session</small>
      </span> : <span className="composer-usage-inline" data-testid="session-usage-inline">
        {data.providers.map(item => {
          const snapshot = account(item.provider);
          const unavailable = snapshot?.windows.length ? undefined
            : snapshot?.unavailableReason ?? (accountsLoaded ? 'Provider returned no account limits' : 'Account limits are loading');
          // One group per provider, so a chart is read beside its own icon and the strip wraps between providers.
          return <span className="composer-usage-provider-group" key={item.provider} data-provider={item.provider} data-testid={`session-usage-group-${item.provider}`}>
            <span className="composer-usage-group-logo" title={providerLabel(item.provider)} aria-label={providerLabel(item.provider)}><ProviderBrandLogo provider={item.provider} size={16} decorative /></span>
            <span title={`${providerLabel(item.provider)} · ${tokenTitle(item)}`} aria-label={`${providerLabel(item.provider)} ${tokenTitle(item)}`} data-testid={`session-usage-tokens-${item.provider}`}>{tokens(item)}</span>
            <LimitChart windows={snapshot?.windows ?? []} provider={item.provider} now={now} unavailable={unavailable} loading={!accountsLoaded} />
          </span>;
        })}
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
              {!snapshot?.windows.length && <span className="composer-usage-unreported" title={snapshot ? snapshot.unavailableReason ?? 'No account limits available for this provider' : 'Account limits are loading'}>{snapshot ? '–' : 'Loading limits…'}</span>}
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
