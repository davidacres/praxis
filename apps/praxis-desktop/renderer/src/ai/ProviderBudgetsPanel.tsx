import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSessionRecord,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotsResult,
  ProviderUsageWindow
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from './ProviderBrandLogo';
import { providerLabel } from './modelProviders';
import { formatCost, formatTokenCompact, summariseSpend } from './sessionNav';

/**
 * Per-provider account budgets on the Overview dashboard (FX-BF-050).
 *
 * Adopts the symmetrical, polished card design system from the AI Usage & Spend
 * fleet dashboard: unboxed vector brand logos, clear type classifications,
 * live countdown pills, clean quota progress tracks, and a balanced two-column
 * footer with rate limits and MTD spend.
 */

/** Snapshots are point-in-time; re-read this often enough to stay useful, rarely enough not to spawn CLIs. */
const REFRESH_MS = 5 * 60 * 1000;

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** "2h 14m" or "4d 18h" — the shape people read a countdown in. */
function countdown(resetsAt: string, now: number): string {
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return 'resetting now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** A provider-reported quota percentage is the only thing drawn as a bar. */
function isQuota(window: ProviderUsageWindow): boolean {
  if (typeof window.usedPercent === 'number') return true;
  const used = window.usedTokens ?? window.usedCost;
  const limit = window.tokenLimit ?? window.costLimit;
  return typeof used === 'number' && typeof limit === 'number' && limit > 0;
}

function getProviderCategory(providerId: string): { typeCategory: 'cli' | 'api' | 'gateway' | 'local'; typeLabel: string } {
  if (providerId.endsWith('-cli')) {
    return { typeCategory: 'cli', typeLabel: 'CLI Autonomous Agent' };
  }
  if (providerId === 'ollama' || providerId === 'lmstudio') {
    return { typeCategory: 'local', typeLabel: 'Local LLM Host' };
  }
  if (providerId === 'bifrost' || providerId === 'openrouter') {
    return { typeCategory: 'gateway', typeLabel: 'Cloud Gateway' };
  }
  return { typeCategory: 'api', typeLabel: 'Cloud Model API' };
}


function QuotaWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
  const percent = typeof window.usedPercent === 'number'
    ? window.usedPercent
    : Math.round(((window.usedTokens ?? window.usedCost ?? 0) / (window.tokenLimit ?? window.costLimit ?? 1)) * 100);
  const clamped = Math.max(0, Math.min(100, percent));
  const isLimit = clamped >= 100;
  const isWarn = clamped >= 80;
  const fillClass = isLimit ? 'is-limit' : isWarn ? 'is-warn' : '';

  return (
    <div className="ai-quota-row overview-budget-window" data-testid={`${testIdPrefix}-window-${window.period}`}>
      <div className="ai-quota-row-head overview-budget-window-head">
        <div className="ai-quota-row-label-group">
          <span className="ai-quota-row-label overview-budget-window-label">
            {window.label ?? `${window.period} window`}
          </span>
          {window.resetsAt && (
            <span className="ai-quota-reset-pill" data-testid={`${testIdPrefix}-reset-${window.period}`}>
              ⏱ {countdown(window.resetsAt, now)}
            </span>
          )}
        </div>
        <div className="ai-quota-row-value-group">
          <span
            className={`ai-quota-row-percent overview-budget-window-percent ${fillClass}`}
            data-testid={`${testIdPrefix}-percent-${window.period}`}
          >
            {clamped}%
          </span>
          <span className="ai-quota-row-used-text">used</span>
        </div>
      </div>
      <div
        className="ai-quota-progress-track overview-budget-bar"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label ?? window.period} window`}
      >
        <div
          className={`ai-quota-progress-fill overview-budget-bar-fill ${fillClass}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {!window.resetsAt && (
        <small className="overview-budget-window-meta">No reset time reported</small>
      )}
    </div>
  );
}

function ConsumptionWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
  const usageText = typeof window.usedTokens === 'number'
    ? `${formatTokenCompact(window.usedTokens)} tokens`
    : typeof window.usedCost === 'number'
      ? `${window.usedCost.toFixed(2)} ${window.currency ?? 'USD'}`
      : 'Usage reported';

  return (
    <div className="ai-quota-row overview-budget-window" data-testid={`${testIdPrefix}-window-${window.period}`}>
      <div className="ai-quota-row-head overview-budget-window-head">
        <div className="ai-quota-row-label-group">
          <span className="ai-quota-row-label overview-budget-window-label">
            {window.label ?? `Last ${window.period}`}
          </span>
          {window.resetsAt && (
            <span className="ai-quota-reset-pill" data-testid={`${testIdPrefix}-reset-${window.period}`}>
              ⏱ {countdown(window.resetsAt, now)}
            </span>
          )}
        </div>
        <div className="ai-quota-row-value-group">
          <span className="ai-quota-row-percent" style={{ fontSize: '13px', fontWeight: 650 }}>
            {usageText}
          </span>
        </div>
      </div>
      {!window.resetsAt && (
        <small className="overview-budget-window-meta">No reset time reported</small>
      )}
    </div>
  );
}

function ProviderCard({
  snapshot,
  now,
  spendFormatted,
  testIdPrefix
}: {
  snapshot: ProviderUsageSnapshot;
  now: number;
  spendFormatted?: string;
  testIdPrefix: string;
}) {
  const label = providerLabel(snapshot.provider);
  const quotaWindows = snapshot.windows.filter(isQuota);
  const consumptionWindows = snapshot.windows.filter(window => !isQuota(window));
  const { typeLabel } = getProviderCategory(snapshot.provider);
  const code = snapshot.unavailableReasonCode ?? (snapshot.unavailableReason ? 'fetch-failed' : undefined);

  const maxUsed = Math.max(
    0,
    ...snapshot.windows.map(w => {
      if (typeof w.usedPercent === 'number') return w.usedPercent;
      const u = w.usedTokens ?? w.usedCost ?? 0;
      const l = w.tokenLimit ?? w.costLimit ?? 1;
      return Math.round((u / l) * 100);
    })
  );

  // Derived from the reason *code*, never from the message text: an optional
  // key that was never added is not the same as a failed read, and calling both
  // "Offline" is what made this badge wrong.
  const status: 'active' | 'warn' | 'offline' | 'nodata' = !code ? (maxUsed >= 80 ? 'warn' : 'active') : code === 'fetch-failed' ? 'offline' : 'nodata';

  // Only ever a real provider-reported figure. Invented "Tier 2 • 300 RPM"
  // strings were showing on every card and read as if we had measured them.
  const rateLimitPill = snapshot.credits
    ? `${snapshot.credits.remaining.toFixed(2)} ${snapshot.credits.currency}`
    : null;

  // A hardcoded per-provider dollar figure (OpenAI $2.15, Anthropic $3.80) is a
  // fabrication. If we have no measured spend, say nothing.
  const displaySpend = spendFormatted && spendFormatted !== '$0.00' ? spendFormatted : null;

  return (
    <div
      className="overview-budget-card ai-provider-card"
      data-testid={`${testIdPrefix}-card-${snapshot.provider}`}
    >
      <div className="ai-provider-card-head overview-budget-card-head">
        <div className="ai-provider-card-identity">
          <div className="ai-provider-card-logo">
            <ProviderBrandLogo provider={snapshot.provider} size={32} />
          </div>
          <div className="ai-provider-card-names">
            <div className="ai-provider-card-title overview-budget-card-name">{label}</div>
            <div className="ai-provider-card-type">{typeLabel}</div>
          </div>
        </div>
        <div className={`ai-provider-card-status is-${status}`} data-testid={`overview-budgets-status-${snapshot.provider}`}>
          <span className="ai-provider-status-dot" />
          <span>
            {status === 'warn' ? (
              <span className="overview-budget-card-flag" style={{ background: 'transparent', padding: 0 }}>
                <Icon name="warning" size={11} /> Near limit
              </span>
            ) : status === 'offline' ? (
              'Offline'
            ) : status === 'nodata' ? (
              code === 'not-configured' ? 'Setup' : 'No data'
            ) : (
              'Active'
            )}
          </span>
        </div>
      </div>

      {snapshot.unavailableReason ? (
        <div
          className="ai-provider-card-nodata overview-budget-nodata"
          data-testid={`${testIdPrefix}-nodata-${snapshot.provider}`}
        >
          <strong>No data</strong>
          <small>{snapshot.unavailableReason}</small>
        </div>
      ) : (
        <>
          {quotaWindows.map(window => (
            <QuotaWindow
              key={`${window.period}-${window.label ?? ''}`}
              window={window}
              now={now}
              testIdPrefix={testIdPrefix}
            />
          ))}

          {quotaWindows.length === 0 && consumptionWindows.length > 0 && (
            <>
              <div className="overview-budget-consumption">
                {consumptionWindows.map(window => (
                  <ConsumptionWindow
                    key={`${window.period}-${window.label ?? ''}`}
                    window={window}
                    now={now}
                    testIdPrefix={testIdPrefix}
                  />
                ))}
              </div>
              <small className="overview-budget-note" style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginTop: 2 }}>
                {consumptionWindows.some(w => w.resetsAt)
                  ? 'Usage tracked across rolling and periodic reset windows.'
                  : 'Consumption only — this provider reports no limit or reset time.'}
              </small>
            </>
          )}

          {quotaWindows.length === 0 && consumptionWindows.length === 0 && (
            <div
              className="ai-provider-card-nodata overview-budget-nodata"
              data-testid={`${testIdPrefix}-nodata-${snapshot.provider}`}
            >
              <strong>No data</strong>
              <small>This provider did not report account usage.</small>
            </div>
          )}
        </>
      )}

      {/* Symmetrical Two-Column Footer matching AI Usage page */}
      {(rateLimitPill || displaySpend) && (
        <div className="ai-provider-card-footer">
          {rateLimitPill && (
            <div className="ai-provider-card-footer-col">
              <span className="ai-provider-card-footer-label">
                {snapshot.credits ? 'Balance:' : 'Rate Limit:'}
              </span>
              <span className="ai-rate-limit-pill">{rateLimitPill}</span>
            </div>
          )}
          {displaySpend && (
            <div className="ai-provider-card-footer-col">
              <span className="ai-provider-card-footer-label">MTD Spend:</span>
              <span className="ai-provider-card-footer-spend">{displaySpend}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ProviderBudgetsProps {
  testIdPrefix?: string;
}

export function ProviderBudgets({ testIdPrefix = 'overview-budgets' }: ProviderBudgetsProps) {
  const [result, setResult] = useState<ProviderUsageSnapshotsResult>();
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await window.praxis.aiUsage.providerSnapshots();
      if (mounted.current) {
        setResult(next);
        setError(undefined);
        setNow(Date.now());
      }
    } catch (err: unknown) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    window.praxis.ai.listSessions()
      .then(s => { if (!cancelled) setSessions(s); })
      .catch(() => undefined);
    const unsub = window.praxis.ai.onSessionChanged(record => {
      setSessions(curr => [record, ...curr.filter(s => s.issueKey !== record.issueKey)]);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const computeProviderMtd = useCallback((providerId: string): string => {
    const nowTs = new Date();
    const startOfMonth = new Date(nowTs.getFullYear(), nowTs.getMonth(), 1).getTime();
    const matching = sessions.filter(s => {
      const p = (s.provider ?? '').toLowerCase();
      const target = providerId.toLowerCase();
      const match = p === target || p.includes(target) || target.includes(p);
      if (!match) return false;
      const startedAt = new Date(s.startedAt).getTime();
      return Number.isFinite(startedAt) && startedAt >= startOfMonth;
    });

    let totalUsd = 0;
    let hasCost = false;
    for (const s of matching) {
      if (s.cost && typeof s.cost.amount === 'number') {
        totalUsd += s.cost.amount;
        hasCost = true;
      }
    }
    if (hasCost && totalUsd > 0) {
      return `$${totalUsd.toFixed(2)}`;
    }
    return '$0.00';
  }, [sessions]);

  if (error) {
    return (
      <section className="overview-budgets" data-testid={`${testIdPrefix}-error`} aria-label="Provider budgets">
        <div className="overview-budgets-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="server" size={16} />
            <h3>Provider budgets</h3>
          </div>
        </div>
        <div className="ai-provider-card-nodata overview-budget-nodata">
          <strong>No data</strong>
          <small>{error}</small>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="overview-budgets" aria-label="Provider budgets">
        <div className="overview-budgets-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="server" size={16} />
            <h3>Provider budgets</h3>
          </div>
        </div>
        <div className="ai-provider-card-nodata overview-budget-nodata">
          <small>Checking provider accounts…</small>
        </div>
      </section>
    );
  }

  if (result.snapshots.length === 0) {
    return (
      <section className="overview-budgets" data-testid={`${testIdPrefix}-empty`} aria-label="Provider budgets">
        <div className="overview-budgets-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="server" size={16} />
            <h3>Provider budgets</h3>
          </div>
        </div>
        <div className="ai-provider-card-nodata overview-budget-nodata">
          <strong>No providers enabled</strong>
          <small>Add a provider in Settings → AI Provider to see its account budget here.</small>
        </div>
      </section>
    );
  }

  return (
    <section className="overview-budgets" data-testid={`${testIdPrefix}-section`} aria-label="Provider budgets">
      <div className="overview-budgets-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="server" size={16} />
          <h3>Provider budgets</h3>
        </div>
        <span className="overview-budgets-checked">Checked {relativeTime(result.checkedAt, now)}</span>
        <button className="btn btn-quiet" type="button" data-testid={`${testIdPrefix}-refresh`} onClick={() => void load()}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>
      <div className="overview-budgets-grid">
        {result.snapshots.map(snapshot => (
          <ProviderCard
            key={snapshot.provider}
            snapshot={snapshot}
            now={now}
            spendFormatted={computeProviderMtd(snapshot.provider)}
            testIdPrefix={testIdPrefix}
          />
        ))}
      </div>
      <p className="overview-usage-note">Limits and reset times come from each provider's own account API. A provider that does not expose one is shown as no data rather than a zero.</p>
    </section>
  );
}
