import { useEffect, useState } from 'react';
import type { UsagePeak, UsageDashboardSummary, UsageWindowSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { formatTokenCompact } from '../ai/sessionNav';
import { UsageModelBreakdown, formatUsageCost } from '../ai/UsageModelBreakdown';
import { ProviderBudgets } from '../ai/ProviderBudgetsPanel';

interface AiUsageDashboardPanelProps {
  /** Opens Settings → AI Usage. */
  onOpenDetails: () => void;
  /** Empty-state call to action. */
  onNewConversation: () => void;
}

const TOP_MODELS = 5;

// The ledger buckets on UTC, so every date here is rendered in UTC to match
// the Settings page rather than the viewer's local day.
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const sinceFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function peakLabel(peak: UsagePeak): string {
  const at = new Date(peak.periodStart);
  if (peak.granularity === 'hour') return `${hourFormat.format(at)} UTC`;
  if (peak.granularity === 'month') return monthFormat.format(at);
  return dayFormat.format(at);
}

function UsageTile({ id, label, window, caption }: { id: string; label: string; window: UsageWindowSummary; caption?: string }) {
  const hasUsage = window.eventCount > 0;
  return (
    <div className="overview-usage-tile" data-testid={`overview-usage-tile-${id}`}>
      <small>{label}</small>
      <strong data-testid={`overview-usage-tokens-${id}`}>{hasUsage ? formatTokenCompact(window.totalTokens) : '0'}<span> tokens</span></strong>
      <em data-testid={`overview-usage-cost-${id}`}>{hasUsage ? formatUsageCost(window.costByCurrency) : '—'}</em>
      <span className="overview-usage-peak" data-testid={`overview-usage-peak-${id}`}>
        {window.peak ? `peak ${formatTokenCompact(window.peak.totalTokens)} · ${peakLabel(window.peak)}` : 'no usage yet'}
      </span>
      {caption && <span className="overview-usage-caption">{caption}</span>}
    </div>
  );
}

export function AiUsageDashboardPanel({ onOpenDetails, onNewConversation }: AiUsageDashboardPanelProps) {
  const [summary, setSummary] = useState<UsageDashboardSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    window.praxis.aiUsage.dashboardSummary()
      .then(result => { if (!cancelled) setSummary(result); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  const allTime = summary?.allTime;
  const empty = !!allTime && allTime.eventCount === 0;
  const noCost = !!allTime && !empty && allTime.costByCurrency.length === 0;
  const since = allTime?.firstEventAt ? sinceFormat.format(new Date(allTime.firstEventAt)) : undefined;

  return (
    <section className="overview-panel overview-usage" data-testid="overview-usage-panel" aria-label="AI usage">
      <div className="overview-panel-heading">
        <h2>AI usage</h2>
        {summary && <small className="overview-usage-updated">Updated {new Date(summary.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
        <button className="btn btn-quiet" type="button" data-testid="overview-usage-details" onClick={onOpenDetails}>View details <Icon name="chevron-right" size={13} /></button>
      </div>

      {error && <div className="overview-empty" data-testid="overview-usage-error"><span>Usage is unavailable right now.<small>{error}</small></span></div>}
      {!error && !summary && <div className="overview-empty"><span>Loading usage…</span></div>}

      {summary && empty && (
        <div className="overview-empty overview-empty-sessions" data-testid="overview-usage-empty">
          <Icon name="graph" size={22} />
          <span>No AI usage yet.<small>Token and cost usage appears here once you run a conversation or session.</small></span>
          <button className="btn btn-primary" type="button" onClick={onNewConversation}>New conversation</button>
        </div>
      )}

      {summary && !empty && (
        <>
          <div className="overview-usage-tiles">
            <UsageTile id="today" label="Today" window={summary.today} />
            <UsageTile id="week" label="This week" window={summary.week} />
            <UsageTile id="month" label="This month" window={summary.month} />
            <UsageTile id="all" label={since ? `All time (since ${since})` : 'All time'} window={summary.allTime} />
          </div>
          <UsageModelBreakdown summary={summary} limit={TOP_MODELS} testIdPrefix="overview-usage" />
          {noCost && <p className="overview-usage-note" data-testid="overview-usage-no-cost">Cost is not reported for these models — only ACP agents such as Claude Code and Codex report it.</p>}
          <p className="overview-usage-note">Totals come from the usage ledger, so they can differ from Settings → AI → Spend, which excludes internal one-shot AI calls.</p>
        </>
      )}

      <ProviderBudgets />
    </section>
  );
}
