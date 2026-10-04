import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSessionRecord, AiProvider, UsageBucket, ProviderUsageSnapshot } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { providerLabel } from './modelProviders';
import { formatCost, sessionLimitNotice } from './sessionNav';

export function SessionUsageSummary({
  session,
  sessions,
  spendLimit,
  onHide,
  draftProvider,
  draftModel,
  activityLabel
}: {
  session?: AgentSessionRecord;
  sessions: AgentSessionRecord[];
  spendLimit: number;
  onHide?: () => void;
  draftProvider?: AiProvider;
  draftModel?: string;
  activityLabel?: string;
}) {
  const selectedProvider = session?.provider ?? draftProvider;
  const selectedModel = session?.model ?? draftModel;
  const [open, setOpen] = useState(false);
  const [detailsClosing, setDetailsClosing] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [windows, setWindows] = useState<Record<string, UsageBucket | undefined>>({});
  const [provider, setProvider] = useState<ProviderUsageSnapshot | undefined>();

  const closeDetails = useCallback(() => {
    if (!open || detailsClosing) return;
    setDetailsClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setDetailsClosing(false);
    }, 240);
  }, [open, detailsClosing]);

  useEffect(() => {
    if (!open || detailsClosing) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || !detailsRef.current) return;
      if (!detailsRef.current.contains(target)) {
        closeDetails();
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDetails();
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [open, detailsClosing, closeDetails]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.praxis.aiUsage.series('hour', 1),
      window.praxis.aiUsage.series('day', 1),
      window.praxis.aiUsage.series('week', 1),
      window.praxis.aiUsage.series('month', 1),
      selectedProvider ? window.praxis.aiUsage.providerSnapshot(selectedProvider) : Promise.resolve(undefined)
    ]).then(([hour, day, week, month, snapshot]) => {
      if (cancelled) return;
      setWindows({ hour: hour[0], day: day[0], week: week[0], month: month[0] });
      setProvider(snapshot);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedProvider, session?.sessionId, session?.tokenUsage?.totalTokens, session?.cost?.amount]);

  const modelTotals = new Map<string, { tokens: number; costs: Array<{ amount: number; currency: string }> }>();
  for (const item of sessions) {
    const key = item.model || 'Unknown model';
    const row = modelTotals.get(key) ?? { tokens: 0, costs: [] };
    row.tokens += item.tokenUsage?.totalTokens ?? 0;
    if (item.cost) row.costs.push(item.cost);
    modelTotals.set(key, row);
  }
  const localCost = sessions.reduce((total, item) => total + (item.cost?.amount ?? 0), 0);
  const localCurrency = sessions.find(item => item.cost?.currency)?.cost?.currency;
  const sessionTokens = session?.tokenUsage?.totalTokens;
  const isLimit = Boolean(session?.providerLimitReached || sessionLimitNotice(session));
  const providerWarning = provider?.windows.find(window => {
    if (typeof window.usedPercent === 'number') return window.usedPercent >= 80;
    const used = window.usedTokens ?? window.usedCost;
    const limit = window.tokenLimit ?? window.costLimit;
    return typeof used === 'number' && typeof limit === 'number' && limit > 0 && used / limit >= 0.8;
  }) || (isLimit ? { period: 'hour' as const, label: 'Limit reached', usedPercent: 100 } : undefined);
  const formatWindow = (bucket: UsageBucket | undefined) => bucket ? `${Math.round(bucket.totalTokens).toLocaleString()} tokens` : '—';
  const spendRatio = spendLimit > 0 ? localCost / spendLimit : undefined;

  return (
    <details
      ref={detailsRef}
      className="session-usage-summary"
      open={open || detailsClosing}
      onToggle={event => {
        if (!detailsClosing) {
          setOpen(event.currentTarget.open);
        }
      }}
      data-testid="session-usage-summary"
    >
      <summary
        onClick={event => {
          if (open && !detailsClosing) {
            event.preventDefault();
            closeDetails();
          }
        }}
      >
        <Icon name="graph" size={14} />
        <span>Usage</span>
        <span className="session-usage-summary-meta">
          {selectedModel ? `${selectedModel} · ` : ''}
          {sessionTokens ? `${Math.round(sessionTokens).toLocaleString()} tokens` : session ? 'No token data' : activityLabel ?? 'Not started'}
          {session?.cost ? ` · ${formatCost(session?.cost)}` : ''}
        </span>
        {providerWarning && (
          <span className={`session-usage-warning${isLimit || providerWarning.usedPercent === 100 ? ' is-limit' : ''}`}>
            {isLimit || providerWarning.usedPercent === 100 ? (providerWarning.label && providerWarning.label !== 'Limit reached' ? providerWarning.label : 'Provider limit reached') : 'Approaching provider limit'}
          </span>
        )}
        {onHide && (
          <button
            type="button"
            className="icon-btn icon-btn-sm session-usage-hide-btn"
            aria-label="Hide usage bar"
            title="Hide usage bar"
            data-testid="session-usage-hide-btn"
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              onHide();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </summary>
      {(open || detailsClosing) && (
        <div className={`session-usage-details-content${detailsClosing ? ' is-closing' : ''}`}>
          <div className="session-usage-grid">
            <div className="session-usage-card">
              <span className="session-usage-label">This session</span>
              <strong>
                {selectedModel ? `${selectedModel} · ` : ''}
                {sessionTokens ? `${Math.round(sessionTokens).toLocaleString()} tokens` : !session ? activityLabel ?? 'Not started' : isLimit ? 'Limit reached' : 'Not reported'}
              </strong>
              <small>{isLimit ? (session?.lastError ?? 'Provider limit reached') : session?.cost ? formatCost(session.cost) : !session ? activityLabel ? 'Chat token and cost totals are not available' : 'No usage recorded for this session yet' : 'Cost not reported by provider'}</small>
            </div>
            {(['hour', 'day', 'week', 'month'] as const).map(period => (
              <div className="session-usage-card" key={period}>
                <span className="session-usage-label">Last {period}</span>
                <strong>{formatWindow(windows[period])}</strong>
                <small>{windows[period]?.costByCurrency.map(cost => `${cost.amount.toFixed(2)} ${cost.currency}`).join(', ') || 'Cost unavailable'}</small>
              </div>
            ))}
          </div>
          {spendRatio !== undefined && spendRatio >= 0.8 && (
            <div className={`session-usage-warning-banner${spendRatio >= 1 ? ' is-critical' : ''}`}>
              <Icon name={spendRatio >= 1 ? 'warning' : 'zap'} size={13} />
              {spendRatio >= 1 ? 'Your Praxis spend limit has been exceeded.' : 'You are approaching your Praxis spend limit.'}
            </div>
          )}
          <div className="session-usage-models">
            <span className="session-usage-label">By model</span>
            {[...modelTotals.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6).map(([model, row]) => (
              <div className="session-usage-model-row" key={model}>
                <span>{model}</span>
                <span>{row.tokens ? `${Math.round(row.tokens).toLocaleString()} tokens` : '—'}{row.costs.length > 0 ? ` · ${row.costs.map(cost => formatCost(cost)).join(', ')}` : ''}</span>
              </div>
            ))}
          </div>
          <div className="session-usage-provider">
            <span className="session-usage-label">{selectedProvider ? `${providerLabel(selectedProvider)} account` : 'Provider account'}</span>
            {provider?.totalTokens ? <span>{Math.round(provider.totalTokens).toLocaleString()} cumulative tokens</span> : provider?.credits ? <span>{provider.credits.remaining.toFixed(2)} {provider.credits.currency} remaining</span> : <span>{provider?.unavailableReason ?? 'Credits and account limits are not exposed by this provider.'}</span>}
          </div>
          {provider && provider.windows.length > 0 && (
            <div className="session-usage-provider-windows">
              {provider.windows.map(window => (
                <div className="session-usage-card" key={`${window.period}-${window.label ?? ''}`}>
                  <span className="session-usage-label">{window.label ?? `Provider ${window.period}`}</span>
                  <strong>{typeof window.usedPercent === 'number' ? `${window.usedPercent}% used` : 'Usage reported'}</strong>
                  <small>{window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : 'Reset time unavailable'}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
