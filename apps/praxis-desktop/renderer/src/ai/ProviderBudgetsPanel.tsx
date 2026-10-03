import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderUsageSnapshot, ProviderUsageSnapshotsResult, ProviderUsageWindow } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { providerLabel } from './modelProviders';
import { formatTokenCompact } from './sessionNav';

/**
 * Per-provider account budgets on the Overview dashboard (FX-BF-050).
 *
 * The hard part of this — a provider-neutral snapshot contract and one batched
 * read — already exists; this renders it. It deliberately shows three
 * different states, because providers are not equally forthcoming and a panel
 * that flattens them into one shape would lie:
 *
 * - **Quota** — a provider that reports a real limit and a real reset time
 *   (Codex CLI, MiniMax). A progress bar, the percentage, and a live countdown.
 * - **Consumption** — tokens or cost with no limit and no reset (OpenAI). The
 *   hour/day/week/month there are windows the usage is sliced by, *not* reset
 *   boundaries, so it gets a consumption list rather than a budget bar. Drawing
 *   a bar here would imply a quota that does not exist.
 * - **No data** — no adapter, or the read failed. Always says why, because
 *   "the Codex CLI isn't installed" and "this provider has no usage API" call
 *   for completely different fixes.
 */

/** Snapshots are point-in-time; re-read this often enough to stay useful, rarely enough not to spawn CLIs. */
const REFRESH_MS = 5 * 60 * 1000;

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** "2h 14m" — the shape people read a countdown in. */
function countdown(resetsAt: string, now: number): string {
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return 'resetting now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** A provider-reported quota percentage is the only thing drawn as a bar. */
function isQuota(window: ProviderUsageWindow): boolean {
  if (typeof window.usedPercent === 'number') return true;
  const used = window.usedTokens ?? window.usedCost;
  const limit = window.tokenLimit ?? window.costLimit;
  return typeof used === 'number' && typeof limit === 'number' && limit > 0;
}

function QuotaWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
  const percent = typeof window.usedPercent === 'number'
    ? window.usedPercent
    : Math.round(((window.usedTokens ?? window.usedCost ?? 0) / (window.tokenLimit ?? window.costLimit ?? 1)) * 100);
  const clamped = Math.max(0, Math.min(100, percent));
  const state = clamped >= 100 ? 'is-limit' : clamped >= 80 ? 'is-warn' : '';
  return (
    <div className="overview-budget-window" data-testid={`${testIdPrefix}-window-${window.period}`}>
      <div className="overview-budget-window-head">
        <span className="overview-budget-window-label">{window.label ?? `${window.period} window`}</span>
        <span className={`overview-budget-window-percent${state}`} data-testid={`${testIdPrefix}-percent-${window.period}`}>{clamped}%</span>
      </div>
      <div className="overview-budget-bar" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100} aria-label={`${window.label ?? window.period} window`}>
        <span className={`overview-budget-bar-fill${state}`} style={{ width: `${clamped}%` }} />
      </div>
      <small className="overview-budget-window-meta">
        {window.resetsAt
          ? <>Resets in <span data-testid={`${testIdPrefix}-reset-${window.period}`}>{countdown(window.resetsAt, now)}</span></>
          : 'No reset time reported'}
      </small>
    </div>
  );
}

function ConsumptionWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
  return (
    <div className="overview-budget-window" data-testid={`${testIdPrefix}-window-${window.period}`}>
      <div className="overview-budget-window-head">
        <span className="overview-budget-window-label">{window.label ?? `Last ${window.period}`}</span>
        <strong>
          {typeof window.usedTokens === 'number'
            ? `${formatTokenCompact(window.usedTokens)} tokens`
            : typeof window.usedCost === 'number'
              ? `${window.usedCost.toFixed(2)} ${window.currency ?? 'USD'}`
              : 'Usage reported'}
        </strong>
      </div>
      <small className="overview-budget-window-meta">
        {window.resetsAt
          ? <>Resets in <span data-testid={`${testIdPrefix}-reset-${window.period}`}>{countdown(window.resetsAt, now)}</span></>
          : 'No reset time reported'}
      </small>
    </div>
  );
}

function ProviderCard({ snapshot, now, testIdPrefix }: { snapshot: ProviderUsageSnapshot; now: number; testIdPrefix: string }) {
  const label = providerLabel(snapshot.provider);
  const quotaWindows = snapshot.windows.filter(isQuota);
  const consumptionWindows = snapshot.windows.filter(window => !isQuota(window));

  return (
    <div className="overview-budget-card" data-testid={`${testIdPrefix}-card-${snapshot.provider}`}>
      <div className="overview-budget-card-head">
        <span className="overview-budget-card-name">{label}</span>
        {quotaWindows.some(window => (window.usedPercent ?? 0) >= 80) && (
          <span className="overview-budget-card-flag"><Icon name="warning" size={11} /> Near limit</span>
        )}
      </div>

      {quotaWindows.map(window => <QuotaWindow key={`${window.period}-${window.label ?? ''}`} window={window} now={now} testIdPrefix={testIdPrefix} />)}

      {/* Consumption is never drawn as a budget: these windows have no limit
          and no reset, so a bar here would invent a quota. */}
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
          <small className="overview-budget-note">
            {consumptionWindows.some(w => w.resetsAt)
              ? 'Usage tracked across rolling and periodic reset windows.'
              : 'Consumption only — this provider reports no limit or reset time.'}
          </small>
        </>
      )}

      {snapshot.credits && (
        <small className="overview-budget-note">{snapshot.credits.remaining.toFixed(2)} {snapshot.credits.currency} remaining</small>
      )}

      {quotaWindows.length === 0 && consumptionWindows.length === 0 && (
        <div className="overview-budget-nodata" data-testid={`${testIdPrefix}-nodata-${snapshot.provider}`}>
          <strong>No data</strong>
          {/* The reason is the useful part: a missing CLI and a missing API
              need different fixes, and a bare "no data" hides that. */}
          <small>{snapshot.unavailableReason ?? 'This provider did not report account usage.'}</small>
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
    // A snapshot can be minutes stale if the window sat hidden, so re-read on
    // return rather than showing an old limit as if it were current.
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Countdowns tick client-side off `resetsAt` — no polling, so the provider
  // read stays on its own slow cadence.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (error) {
    return (
      <section className="overview-budgets" data-testid={`${testIdPrefix}-error`} aria-label="Provider budgets">
        <div className="overview-budgets-head">
          <h3>Provider budgets</h3>
        </div>
        <div className="overview-budget-nodata">
          <strong>No data</strong>
          <small>{error}</small>
        </div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="overview-budgets" aria-label="Provider budgets">
        <div className="overview-budgets-head"><h3>Provider budgets</h3></div>
        <div className="overview-budget-nodata"><small>Checking provider accounts…</small></div>
      </section>
    );
  }

  if (result.snapshots.length === 0) {
    return (
      <section className="overview-budgets" data-testid={`${testIdPrefix}-empty`} aria-label="Provider budgets">
        <div className="overview-budgets-head"><h3>Provider budgets</h3></div>
        <div className="overview-budget-nodata">
          <strong>No providers enabled</strong>
          <small>Add a provider in Settings → AI Provider to see its account budget here.</small>
        </div>
      </section>
    );
  }

  return (
    <section className="overview-budgets" data-testid={`${testIdPrefix}-section`} aria-label="Provider budgets">
      <div className="overview-budgets-head">
        <h3>Provider budgets</h3>
        <span className="overview-budgets-checked">Checked {relativeTime(result.checkedAt, now)}</span>
        <button className="btn btn-quiet" type="button" data-testid={`${testIdPrefix}-refresh`} onClick={() => void load()}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>
      <div className="overview-budgets-grid">
        {result.snapshots.map(snapshot => <ProviderCard key={snapshot.provider} snapshot={snapshot} now={now} testIdPrefix={testIdPrefix} />)}
      </div>
      <p className="overview-usage-note">Limits and reset times come from each provider's own account API. A provider that does not expose one is shown as no data rather than a zero.</p>
    </section>
  );
}
