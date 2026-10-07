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
import { formatCost, summariseSpend } from './sessionNav';
import { ProviderCard } from './ProviderUsageWindows';

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

/** Mirrors snapshotHasUsage from the main process, plus the ledger MTD spend the batch cannot see. */
function cardHasData({ snapshot, mtdUsd }: { snapshot: ProviderUsageSnapshot; mtdUsd: number }): boolean {
  return (!snapshot.unavailableReason && snapshot.windows.length > 0) || mtdUsd > 0;
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

  const computeProviderMtdUsd = useCallback((providerId: string): number => {
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
    return hasCost && totalUsd > 0 ? totalUsd : 0;
  }, [sessions]);

  // The main process already leads with providers that reported account usage
  // (sortByUsageAvailability in providerUsageBatch.ts), but it cannot see this
  // workspace's session ledger. This pass additionally promotes cards with
  // measured MTD spend, so a provider that exposes no account API but is in
  // active use does not sink below the "No data" cards. Stable sort: ties keep
  // the order the batch delivered.
  const orderedCards = useMemo(() => {
    const cards = [...(result?.snapshots ?? [])].map(snapshot => ({
      snapshot,
      mtdUsd: computeProviderMtdUsd(snapshot.provider)
    }));
    return cards.sort((a, b) => Number(cardHasData(b)) - Number(cardHasData(a)));
  }, [result, computeProviderMtdUsd]);

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
        {orderedCards.map(({ snapshot, mtdUsd }) => (
          <ProviderCard
            key={snapshot.provider}
            snapshot={snapshot}
            now={now}
            spendFormatted={mtdUsd > 0 ? `$${mtdUsd.toFixed(2)}` : undefined}
            testIdPrefix={testIdPrefix}
          />
        ))}
      </div>
      <p className="overview-usage-note">Limits and reset times come from each provider's own account API. A provider that does not expose one is shown as no data rather than a zero.</p>
    </section>
  );
}
