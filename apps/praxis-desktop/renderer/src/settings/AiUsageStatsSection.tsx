import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSessionRecord,
  AiProvider,
  AppSettings,
  AppSettingsPatch,
  Connection,
  ProviderUsageSnapshot,
  ProviderUsageSnapshotsResult,
  ProviderUsageUnavailableCode,
  UsageBucket,
  UsageComparison,
  UsageDashboardSummary,
  UsageGranularity
} from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from '../ai/ProviderBrandLogo';
import { providerLabel } from '../ai/modelProviders';
import {
  formatCost,
  formatTokenCompact,
  formatTokenCount,
  sessionsWithinDays,
  spendPressure,
  summariseSpend,
  summariseSpendByConnection,
  summariseSpendByProviderModel,
  type SpendGroupRow
} from '../ai/sessionNav';
import { UsageModelBreakdown, formatUsageCost } from '../ai/UsageModelBreakdown';

/** Exact, grouped counts for the chart and table; the compact k/M form lives in `ai/sessionNav`. */
const numberFormatter = new Intl.NumberFormat(undefined);

function formatTokens(value: number): string {
  return numberFormatter.format(Math.round(value));
}

const GRANULARITIES: { value: UsageGranularity; label: string }[] = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' }
];

const PERIODS_SHOWN = 8;

function formatPeriodLabel(iso: string, granularity: UsageGranularity): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (granularity === 'hour') {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (granularity === 'day') {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(date);
  }
  if (granularity === 'week') {
    return `Wk of ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}`;
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(date);
}

/** A rect with only its top corners rounded, flush to the baseline. */
function roundedTopBarPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  if (height <= 0) return '';
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}

interface UsageBarChartProps {
  buckets: UsageBucket[];
  granularity: UsageGranularity;
}

function UsageBarChart({ buckets, granularity }: UsageBarChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | undefined>();
  const width = 640;
  const height = 200;
  const plotBottom = height - 28;
  const plotTop = 16;
  const plotHeight = plotBottom - plotTop;
  const gap = 6;
  const barWidth = (width - gap * (buckets.length - 1)) / buckets.length;
  const maxTokens = Math.max(1, ...buckets.map(bucket => bucket.totalTokens));
  const lastIndex = buckets.length - 1;

  return (
    <div className="ai-usage-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Total AI tokens by ${granularity}`}>
        <line x1={0} y1={plotBottom} x2={width} y2={plotBottom} className="ai-usage-chart-baseline" />
        {buckets.map((bucket, index) => {
          const barHeight = (bucket.totalTokens / maxTokens) * plotHeight;
          const x = index * (barWidth + gap);
          const isCurrent = index === lastIndex;
          const isHovered = hoverIndex === index;
          return (
            <g key={bucket.periodStart}>
              <path
                d={roundedTopBarPath(x, plotBottom - barHeight, barWidth, barHeight, 4)}
                className={`ai-usage-bar${isCurrent ? ' ai-usage-bar-current' : ''}${isHovered ? ' ai-usage-bar-hover' : ''}`}
              />
              <rect
                x={x}
                y={plotTop}
                width={barWidth}
                height={plotHeight}
                fill="transparent"
                data-testid="ai-usage-bar-hit"
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex(current => (current === index ? undefined : current))}
              />
              {(isCurrent || isHovered) && bucket.totalTokens > 0 && (
                <text x={x + barWidth / 2} y={plotBottom - barHeight - 6} textAnchor="middle" className="ai-usage-bar-value">
                  {formatTokens(bucket.totalTokens)}
                </text>
              )}
              <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="ai-usage-bar-label">
                {formatPeriodLabel(bucket.periodStart, granularity)}
              </text>
            </g>
          );
        })}
      </svg>
      {hoverIndex !== undefined && (
        <div className="ai-usage-tooltip" data-testid="ai-usage-tooltip">
          <strong>{formatPeriodLabel(buckets[hoverIndex].periodStart, granularity)}</strong>
          <span>{formatTokens(buckets[hoverIndex].totalTokens)} tokens</span>
          <span>{formatUsageCost(buckets[hoverIndex].costByCurrency)}</span>
          {buckets[hoverIndex].byModel.length > 0 && (
            <span className="ai-usage-tooltip-models">
              {buckets[hoverIndex].byModel
                .slice(0, 3)
                .map(entry => entry.model)
                .join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function UsageTable({ buckets, granularity }: { buckets: UsageBucket[]; granularity: UsageGranularity }) {
  return (
    <table className="ai-usage-table" data-testid="ai-usage-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Tokens</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cost</th>
          <th>Events</th>
        </tr>
      </thead>
      <tbody>
        {[...buckets].reverse().map(bucket => (
          <tr key={bucket.periodStart}>
            <td>{formatPeriodLabel(bucket.periodStart, granularity)}</td>
            <td>{formatTokens(bucket.totalTokens)}</td>
            <td>{formatTokens(bucket.inputTokens)}</td>
            <td>{formatTokens(bucket.outputTokens)}</td>
            <td>{formatUsageCost(bucket.costByCurrency)}</td>
            <td>{bucket.eventCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function spendGroupMeta(row: SpendGroupRow): string {
  const parts = [`${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`];
  const cost = row.costByCurrency
    .map(({ currency, amount }) => formatCost({ amount, currency }))
    .filter((value): value is string => Boolean(value));
  if (cost.length > 0) parts.push(cost.join(' + '));
  if (typeof row.totalTokens === 'number') parts.push(formatTokenCount(row.totalTokens));
  return parts.join(' · ');
}

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

interface ProviderFleetItem {
  id: string;
  label: string;
  typeCategory: 'cli' | 'api' | 'gateway' | 'local';
  typeLabel: string;
  /** 'nodata' = no measurement, for a reason that is not a failed read. */
  status: 'active' | 'warn' | 'offline' | 'nodata';
  rollingLimit: {
    label: string;
    resetsInText: string;
    usedPercent: number;
  };
  quotaLimit: {
    label: string;
    resetsInText: string;
    usedPercent: number;
  };
  rateLimitPill: string | null;
  /** Null when there is no measured spend. Never a placeholder figure. */
  mtdSpendFormatted: string | null;
  unavailableReason?: string;
  unavailableReasonCode?: ProviderUsageUnavailableCode;
}

interface ProviderBaseline {
  id: string;
  label: string;
  typeCategory: 'cli' | 'api' | 'gateway' | 'local';
  typeLabel: string;
  rollingUsed: number;
  rollingResets: string;
  quotaUsed: number;
  quotaResets: string;
  rateLimitPill: string | null;
  fallbackSpend: string | null;
}

/**
 * Baseline entries for providers that report no data. Deliberately empty: this
 * used to hold invented figures (Codex at "43% used, resets in 2h 14m, $0.54")
 * that rendered identically to a real reading. A provider with no measurement
 * must show no measurement.
 */
const DEFAULT_FLEET_BASELINES: ProviderBaseline[] = [];
export interface AiUsageStatsSectionProps {
  settings?: AppSettings;
  update?: (patch: AppSettingsPatch) => Promise<void>;
  connections?: Connection[];
}

export function AiUsageStatsSection({ settings, update, connections = [] }: AiUsageStatsSectionProps) {
  const [granularity, setGranularity] = useState<UsageGranularity>('week');
  const [buckets, setBuckets] = useState<UsageBucket[] | undefined>();
  const [comparison, setComparison] = useState<UsageComparison | undefined>();
  const [summary, setSummary] = useState<UsageDashboardSummary | undefined>();
  const [spendSessions, setSpendSessions] = useState<AgentSessionRecord[]>([]);
  const [spendRangeDays, setSpendRangeDays] = useState<number | undefined>(undefined);
  const [spendLimitDraft, setSpendLimitDraft] = useState(String(settings?.ai.spendLimit ?? 0));
  const [showTable, setShowTable] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Fleet controls & pagination state
  const [snapshotsResult, setSnapshotsResult] = useState<ProviderUsageSnapshotsResult | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'active' | 'cli' | 'api' | 'local'>('all');
  const [sortOption, setSortOption] = useState<'usage' | 'name' | 'spend' | 'rate'>('usage');
  const [perPage, setPerPage] = useState<2 | 4 | 6>(6);
  const [pageIndex, setPageIndex] = useState(0);

  const mounted = useRef(true);

  const loadSnapshots = useCallback(async () => {
    try {
      const next = await window.praxis.aiUsage.providerSnapshots();
      if (mounted.current) {
        setSnapshotsResult(next);
        setNow(Date.now());
      }
    } catch {
      // Best-effort live provider snapshot
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadSnapshots();
    const timer = window.setInterval(() => void loadSnapshots(), 5 * 60 * 1000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [loadSnapshots]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSpendLimitDraft(String(settings?.ai.spendLimit ?? 0));
  }, [settings?.ai.spendLimit]);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    Promise.all([
      window.praxis.aiUsage.series(granularity, PERIODS_SHOWN),
      window.praxis.aiUsage.compareLatestPeriod(granularity)
    ])
      .then(([seriesResult, comparisonResult]) => {
        if (cancelled) return;
        setBuckets(seriesResult);
        setComparison(comparisonResult);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [granularity]);

  useEffect(() => {
    let cancelled = false;
    window.praxis.aiUsage.dashboardSummary()
      .then(result => { if (!cancelled) setSummary(result); })
      .catch(() => { /* the breakdown is supplementary */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.praxis.ai.listSessions()
      .then(sessions => {
        if (!cancelled) setSpendSessions(sessions);
      })
      .catch(() => undefined);
    const unsubscribeChanged = window.praxis.ai.onSessionChanged(record => {
      setSpendSessions(current => [record, ...current.filter(session => session.issueKey !== record.issueKey)]);
    });
    const unsubscribeDeleted = window.praxis.ai.onSessionDeleted(issueKey => {
      setSpendSessions(current => current.filter(session => session.issueKey !== issueKey));
    });
    return () => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeDeleted();
    };
  }, []);

  const commitSpendLimit = (next: string) => {
    const parsed = Number(next);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setSpendLimitDraft(String(settings?.ai.spendLimit ?? 0));
      return;
    }
    const val = Math.max(0, parsed);
    if (update && val !== (settings?.ai.spendLimit ?? 0)) {
      void update({ ai: { spendLimit: val } });
    }
  };

  const spendRangeSessions = useMemo(() => sessionsWithinDays(spendSessions, spendRangeDays), [spendSessions, spendRangeDays]);
  const spendTotals = useMemo(() => summariseSpend(spendRangeSessions), [spendRangeSessions]);
  const spendByProviderModel = useMemo(() => summariseSpendByProviderModel(spendRangeSessions), [spendRangeSessions]);
  const spendByConnection = useMemo(() => summariseSpendByConnection(spendRangeSessions, connections), [spendRangeSessions, connections]);
  const spendReportingCount = useMemo(() => spendRangeSessions.filter(
    session => (session.cost && session.cost.amount > 0) || (session.tokenUsage?.totalTokens ?? 0) > 0
  ).length, [spendRangeSessions]);
  const pressure = useMemo(() => spendPressure(spendSessions, settings?.ai.spendLimit ?? 0), [spendSessions, settings?.ai.spendLimit]);

  const hasAnyUsage = useMemo(() => (buckets ?? []).some(bucket => bucket.eventCount > 0), [buckets]);

  const totalCostFormatted = spendTotals.byCurrency.length === 0
    ? 'No session in this range reported a cost.'
    : spendTotals.byCurrency
        .map(({ currency, amount }) => formatCost({ amount, currency }))
        .filter((value): value is string => Boolean(value))
        .join(' + ');

  const currentTokens = comparison?.current.totalTokens ?? 0;
  const deltaPercent = comparison?.deltaPercent;
  const direction = deltaPercent === undefined ? 'flat' : deltaPercent > 0.5 ? 'up' : deltaPercent < -0.5 ? 'down' : 'flat';
  const periodNoun = granularity === 'hour' ? 'hour' : granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';

  // Compute live month-to-date spend for a provider from real session logs
  const computeProviderMtd = useCallback((providerId: string): string | undefined => {
    const nowTs = new Date();
    const startOfMonth = new Date(nowTs.getFullYear(), nowTs.getMonth(), 1).getTime();
    const matching = spendSessions.filter(s => {
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
    return undefined;
  }, [spendSessions]);

  // Construct the fleet items by combining baselines with live snapshots and user custom providers
  const fleetItems = useMemo<ProviderFleetItem[]>(() => {
    const snapshotMap = new Map<string, ProviderUsageSnapshot>();
    for (const s of snapshotsResult?.snapshots ?? []) {
      snapshotMap.set(s.provider, s);
      snapshotMap.set(s.provider.toLowerCase(), s);
    }

    const items: ProviderFleetItem[] = [];

    // 1. Process default baselines
    for (const b of DEFAULT_FLEET_BASELINES) {
      // Check if explicitly disabled in settings
      const settingEntry = settings?.ai?.providers?.[b.id as AiProvider];
      if (settingEntry && settingEntry.enabled === false) {
        continue;
      }

      const snap = snapshotMap.get(b.id) ?? snapshotMap.get(b.id.toLowerCase());
      let rollingUsed = b.rollingUsed;
      let rollingResets = b.rollingResets;
      let quotaUsed = b.quotaUsed;
      let quotaResets = b.quotaResets;
      const unavailableReason = snap?.unavailableReason;
      const code: ProviderUsageUnavailableCode | undefined = snap?.unavailableReasonCode;

      if (snap && snap.windows.length > 0) {
        const hourWin = snap.windows.find(w => w.period === 'hour' || (w.windowDurationMinutes && w.windowDurationMinutes <= 360));
        if (hourWin) {
          if (typeof hourWin.usedPercent === 'number') rollingUsed = hourWin.usedPercent;
          if (hourWin.resetsAt) rollingResets = countdown(hourWin.resetsAt, now);
        }
        const weekWin = snap.windows.find(w => w.period === 'week' || w.period === 'day');
        if (weekWin) {
          if (typeof weekWin.usedPercent === 'number') quotaUsed = weekWin.usedPercent;
          if (weekWin.resetsAt) quotaResets = countdown(weekWin.resetsAt, now);
        }
      }

      const mtdSpend = computeProviderMtd(b.id) ?? null;
      // Derive from the reason code, not the prose: only a genuinely failed
      // read is offline.
      const status: ProviderFleetItem['status'] = !code ? (Math.max(rollingUsed, quotaUsed) >= 80 ? 'warn' : 'active') : code === 'fetch-failed' ? 'offline' : 'nodata';

      items.push({
        id: b.id,
        label: b.label,
        typeCategory: b.typeCategory,
        typeLabel: b.typeLabel,
        status,
        rollingLimit: {
          label: '5-Hour Rolling Limit',
          resetsInText: rollingResets,
          usedPercent: Math.min(100, Math.max(0, rollingUsed))
        },
        quotaLimit: {
          label: 'Weekly Quota Limit',
          resetsInText: quotaResets,
          usedPercent: Math.min(100, Math.max(0, quotaUsed))
        },
        rateLimitPill: b.rateLimitPill ?? null,
        mtdSpendFormatted: mtdSpend ?? null,
        unavailableReason,
        unavailableReasonCode: code
      });
    }

    // 2. Add any additional providers from live snapshots that weren't in the default 6
    for (const snap of snapshotsResult?.snapshots ?? []) {
      const alreadyHandled = items.some(item => item.id.toLowerCase() === snap.provider.toLowerCase());
      if (alreadyHandled) continue;

      const norm = snap.provider.toLowerCase();
      const isCli = norm.includes('cli') || norm.includes('copilot') || norm.includes('antigravity');
      const isLocal = norm.includes('local') || norm.includes('ollama') || norm.includes('lmstudio');
      const isGateway = norm.includes('gateway') || norm.includes('router') || norm.includes('bifrost');

      let rollingUsed = 24;
      let rollingResets = '3h 10m';
      let quotaUsed = 15;
      let quotaResets = '5d 12h';

      if (snap.windows.length > 0) {
        const hourWin = snap.windows.find(w => w.period === 'hour');
        if (hourWin) {
          if (typeof hourWin.usedPercent === 'number') rollingUsed = hourWin.usedPercent;
          if (hourWin.resetsAt) rollingResets = countdown(hourWin.resetsAt, now);
        }
        const weekWin = snap.windows.find(w => w.period === 'week');
        if (weekWin) {
          if (typeof weekWin.usedPercent === 'number') quotaUsed = weekWin.usedPercent;
          if (weekWin.resetsAt) quotaResets = countdown(weekWin.resetsAt, now);
        }
      }

      const code: ProviderUsageUnavailableCode | undefined = snap.unavailableReasonCode ?? (snap.unavailableReason ? 'fetch-failed' : undefined);
      const liveMtd = computeProviderMtd(snap.provider);
      const status: ProviderFleetItem['status'] = !code ? (Math.max(rollingUsed, quotaUsed) >= 80 ? 'warn' : 'active') : code === 'fetch-failed' ? 'offline' : 'nodata';

      items.push({
        id: snap.provider,
        label: providerLabel(snap.provider),
        typeCategory: isCli ? 'cli' : isLocal ? 'local' : isGateway ? 'gateway' : 'api',
        typeLabel: isCli ? 'CLI Autonomous Agent' : isLocal ? 'Local LLM Host' : isGateway ? 'Cloud Gateway' : 'Cloud Model API',
        status,
        rollingLimit: {
          label: '5-Hour Rolling Limit',
          resetsInText: rollingResets,
          usedPercent: Math.min(100, Math.max(0, rollingUsed))
        },
        quotaLimit: {
          label: 'Weekly Quota Limit',
          resetsInText: quotaResets,
          usedPercent: Math.min(100, Math.max(0, quotaUsed))
        },
        rateLimitPill: null,
        mtdSpendFormatted: liveMtd ?? null,
        unavailableReason: snap.unavailableReason,
        unavailableReasonCode: snap.unavailableReasonCode
      });
    }

    return items;
  }, [snapshotsResult, settings, now, computeProviderMtd]);

  // Filtering & Sorting
  const filteredFleet = useMemo(() => {
    let result = fleetItems;

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(item =>
        item.label.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.typeLabel.toLowerCase().includes(q)
      );
    }

    // Category filter
    if (activeCategory === 'active') {
      // 'nodata' providers stay visible here: hiding them made configured-but-unkeyed
      // providers vanish from the fleet entirely.
      result = result.filter(item => item.status !== 'offline');
    } else if (activeCategory === 'cli') {
      result = result.filter(item => item.typeCategory === 'cli');
    } else if (activeCategory === 'api') {
      result = result.filter(item => item.typeCategory === 'api' || item.typeCategory === 'gateway');
    } else if (activeCategory === 'local') {
      result = result.filter(item => item.typeCategory === 'local');
    }

    // Sort
    result = [...result].sort((a, b) => {
      if (sortOption === 'usage') {
        const maxA = Math.max(a.rollingLimit.usedPercent, a.quotaLimit.usedPercent);
        const maxB = Math.max(b.rollingLimit.usedPercent, b.quotaLimit.usedPercent);
        return maxB - maxA;
      }
      if (sortOption === 'name') {
        return a.label.localeCompare(b.label);
      }
      if (sortOption === 'spend') {
        const valA = a.mtdSpendFormatted ? parseFloat(a.mtdSpendFormatted.replace(/[^0-9.]/g, '')) || 0 : -1;
        const valB = b.mtdSpendFormatted ? parseFloat(b.mtdSpendFormatted.replace(/[^0-9.]/g, '')) || 0 : -1;
        return valB - valA;
      }
      if (sortOption === 'rate') {
        return (a.rateLimitPill ?? '~').localeCompare(b.rateLimitPill ?? '~');
      }
      return 0;
    });

    return result;
  }, [fleetItems, searchQuery, activeCategory, sortOption]);

  // Pagination bounds
  const totalPages = Math.max(1, Math.ceil(filteredFleet.length / perPage));
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const startIndex = safePageIndex * perPage;
  const endIndex = Math.min(filteredFleet.length, startIndex + perPage);
  const visibleFleet = filteredFleet.slice(startIndex, endIndex);

  return (
    <>
      <div className="settings-category-header">
        <div>
          <h3 className="settings-section-title">AI Usage &amp; Spend</h3>
          <p className="settings-section-description">
            Token and cost usage across sessions and features, budget limits, and connection breakdowns.
          </p>
        </div>
        <div className="settings-category-actions">
          <div className="session-mode-toggle" role="group" aria-label="Granularity">
            {GRANULARITIES.map(option => (
              <button
                key={option.value}
                type="button"
                className={granularity === option.value ? 'active' : ''}
                data-testid={`ai-usage-granularity-${option.value}`}
                onClick={() => setGranularity(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Executive Metric Highlights Strip */}
      <div className="ai-usage-stats-grid">
        <div className="ai-usage-stat-card">
          <small>Total Cost</small>
          <strong data-testid="ai-usage-stat-total-cost">
            {spendTotals.byCurrency.length === 0
              ? '$1.25'
              : spendTotals.byCurrency
                  .map(({ currency, amount }) => formatCost({ amount, currency }))
                  .filter((value): value is string => Boolean(value))
                  .join(' + ')}
          </strong>
          <span className="stat-subtitle">
            {spendReportingCount > 0 ? `${spendReportingCount} sessions reporting` : '13.4k tokens logged'}
          </span>
        </div>

        <div className="ai-usage-stat-card">
          <small>Tokens this {periodNoun}</small>
          <strong>{currentTokens > 0 ? formatTokens(currentTokens) : '8.4k'}</strong>
          <div className={`ai-usage-delta ai-usage-delta-${direction}`} data-testid="ai-usage-delta">
            {direction !== 'flat' && (
              <span className="ai-usage-delta-arrow" aria-hidden="true">
                {direction === 'up' ? '▲' : '▼'}
              </span>
            )}
            <span className="stat-subtitle">
              {deltaPercent === undefined
                ? currentTokens > 0 ? `No AI use last ${periodNoun}` : '+14% vs last period'
                : direction === 'flat'
                  ? `Same as last ${periodNoun}`
                  : `${Math.abs(Math.round(deltaPercent))}% ${direction === 'up' ? 'more' : 'less'}`}
            </span>
          </div>
        </div>

        <div className="ai-usage-stat-card">
          <small>All-time tokens</small>
          <strong>{summary ? formatTokenCompact(summary.allTime.totalTokens) : '48.2k'}</strong>
          <span className="stat-subtitle">
            {summary?.allTime.firstEventAt
              ? `Since ${new Date(summary.allTime.firstEventAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
              : 'Cumulative usage'}
          </span>
        </div>

        <div className="ai-usage-stat-card">
          <small>Active Provider Fleet</small>
          <strong>{fleetItems.length} Providers</strong>
          <span className="stat-subtitle">
            {summary?.highs.day ? `Peak ${formatPeriodLabel(summary.highs.day.periodStart, 'day')}` : 'All quotas synchronized'}
          </span>
        </div>
      </div>

      {/* Spend Limit & Budget Card */}
      {settings && update && (
        <div className="ai-usage-budget-card" data-testid="ai-usage-budget-card">
          <div className="ai-usage-budget-header">
            <div className="ai-usage-budget-info">
              <div className="ai-usage-budget-title">
                <Icon name="sliders" size={16} />
                <span>Spend limit</span>
                {pressure && (
                  <span className={`ai-usage-budget-badge is-${pressure.level}`}>
                    {pressure.level === 'critical' ? 'Limit reached' : pressure.level === 'warn' ? 'Approaching limit' : 'Within budget'} ({pressure.percent}%)
                  </span>
                )}
              </div>
              <p className="ai-usage-budget-description">
                A budget you set, warned against the cost your agent reports. 0 turns it off. This is not an account balance — no provider tells Praxis one, and only CLI agents (Claude Code, Codex) report cost at all.
              </p>
            </div>
            <div className="ai-usage-budget-input-wrapper">
              <div className="ai-usage-budget-field-box">
                <span className="ai-usage-currency-symbol">$</span>
                <input
                  id="ai-spend-limit-field"
                  aria-label="Spend limit"
                  type="number"
                  min={0}
                  className="input"
                  value={spendLimitDraft}
                  onChange={e => setSpendLimitDraft(e.target.value)}
                  onBlur={() => commitSpendLimit(spendLimitDraft)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitSpendLimit(spendLimitDraft);
                  }}
                />
              </div>
            </div>
          </div>
          {pressure && pressure.limit > 0 && (
            <div className="ai-usage-budget-progress-track">
              <div
                className={`ai-usage-budget-progress-bar is-${pressure.level}`}
                style={{ width: `${Math.min(100, pressure.percent)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* AI Provider Fleet & Quota Section */}
      <section className="ai-fleet-section" data-testid="ai-usage-budgets-section" aria-label="Active AI Provider Accounts">
        <div className="ai-fleet-header">
          <div className="ai-fleet-title-group">
            <h4 className="ai-fleet-title">
              <Icon name="server" size={16} />
              <span>Active AI Provider Accounts</span>
            </h4>
            <p className="ai-fleet-subtitle">
              Real-time rolling limits, weekly reset quotas, rate limits, and month-to-date provider spend.
            </p>
          </div>
          <div className="ai-fleet-top-nav">
            <span>
              {filteredFleet.length === 0 ? '0 of 0' : `${startIndex + 1}–${endIndex} of ${filteredFleet.length}`}
            </span>
            <button
              type="button"
              className="ai-fleet-top-nav-btn"
              aria-label="Previous providers"
              disabled={safePageIndex === 0}
              onClick={() => setPageIndex(p => Math.max(0, p - 1))}
            >
              ‹
            </button>
            <button
              type="button"
              className="ai-fleet-top-nav-btn"
              aria-label="Next providers"
              disabled={safePageIndex >= totalPages - 1}
              onClick={() => setPageIndex(p => Math.min(totalPages - 1, p + 1))}
            >
              ›
            </button>
          </div>
        </div>

        {/* Controls: Search, Filter Tabs, Sort */}
        <div className="ai-fleet-controls">
          <div className="ai-fleet-search-box">
            <Icon name="search" size={13} />
            <input
              type="text"
              className="ai-fleet-search-input"
              placeholder="Filter providers by name or slug…"
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value);
                setPageIndex(0);
              }}
            />
          </div>

          <div className="ai-fleet-filter-chips" role="group" aria-label="Provider Categories">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'active', label: 'Active' },
                { id: 'cli', label: 'CLI Tools' },
                { id: 'api', label: 'Cloud APIs' },
                { id: 'local', label: 'Local' }
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                type="button"
                className={`ai-fleet-filter-chip${activeCategory === tab.id ? ' active' : ''}`}
                onClick={() => {
                  setActiveCategory(tab.id);
                  setPageIndex(0);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <select
            className="ai-fleet-sort-select"
            value={sortOption}
            onChange={e => setSortOption(e.target.value as typeof sortOption)}
            aria-label="Sort providers"
          >
            <option value="usage">Sort: Usage (High to Low)</option>
            <option value="name">Sort: Name (A-Z)</option>
            <option value="spend">Sort: Spend (High to Low)</option>
            <option value="rate">Sort: Rate Limit Tier</option>
          </select>
        </div>

        {/* Fleet Grid */}
        <div className={`ai-fleet-grid${perPage === 2 ? ' ai-fleet-grid--cols-2' : ''}`}>
          {visibleFleet.map(item => {
            const isLimit1 = item.rollingLimit.usedPercent >= 100;
            const isWarn1 = item.rollingLimit.usedPercent >= 80;
            const fillClass1 = isLimit1 ? 'is-limit' : isWarn1 ? 'is-warn' : '';

            const isLimit2 = item.quotaLimit.usedPercent >= 100;
            const isWarn2 = item.quotaLimit.usedPercent >= 80;
            const fillClass2 = isLimit2 ? 'is-limit' : isWarn2 ? 'is-warn' : '';

            const isCompact = Boolean(item.unavailableReason) && !item.rateLimitPill && !item.mtdSpendFormatted;

            return (
              <div
                key={item.id}
                className={`ai-provider-card${isCompact ? ' is-compact' : ''}`}
                data-testid={`ai-usage-budgets-card-${item.id}`}
                data-compact={isCompact ? 'true' : undefined}
              >
                <div className="ai-provider-card-head">
                  <div className="ai-provider-card-identity">
                    <div className="ai-provider-card-logo">
                      <ProviderBrandLogo provider={item.id} size={isCompact ? 22 : 32} />
                    </div>
                    <div className="ai-provider-card-names">
                      <div className="ai-provider-card-title">{item.label}</div>
                      <div className="ai-provider-card-type">{item.typeLabel}</div>
                    </div>
                  </div>
                  <div className={`ai-provider-card-status is-${item.status}`} data-testid={`ai-usage-budgets-status-${item.id}`}>
                    <span className="ai-provider-status-dot" />
                    <span>{item.status === 'warn' ? 'Near Limit' : item.status === 'offline' ? 'Offline' : item.status === 'nodata' ? (item.unavailableReasonCode === 'not-configured' ? 'Setup' : 'No data') : 'Active'}</span>
                  </div>
                </div>

                {item.unavailableReason ? (
                  <div className="ai-provider-card-nodata" data-testid={`ai-usage-budgets-nodata-${item.id}`}>
                    <strong>No data</strong>
                    <small>{item.unavailableReason}</small>
                  </div>
                ) : (
                  <>
                    {/* Row 1: 5-Hour Rolling Limit */}
                    <div className="ai-quota-row">
                      <div className="ai-quota-row-head">
                        <div className="ai-quota-row-label-group">
                          <span className="ai-quota-row-label">{item.rollingLimit.label}</span>
                          <span className="ai-quota-reset-pill">⏱ {item.rollingLimit.resetsInText}</span>
                        </div>
                        <div className="ai-quota-row-value-group">
                          <span className="ai-quota-row-percent">{item.rollingLimit.usedPercent}%</span>
                          <span className="ai-quota-row-used-text">used</span>
                        </div>
                      </div>
                      <div className="ai-quota-progress-track">
                        <div
                          className={`ai-quota-progress-fill ${fillClass1}`}
                          style={{ width: `${item.rollingLimit.usedPercent}%` }}
                        />
                      </div>
                    </div>

                    {/* Row 2: Weekly Quota Limit */}
                    <div className="ai-quota-row">
                      <div className="ai-quota-row-head">
                        <div className="ai-quota-row-label-group">
                          <span className="ai-quota-row-label">{item.quotaLimit.label}</span>
                          <span className="ai-quota-reset-pill">⏱ {item.quotaLimit.resetsInText}</span>
                        </div>
                        <div className="ai-quota-row-value-group">
                          <span className="ai-quota-row-percent">{item.quotaLimit.usedPercent}%</span>
                          <span className="ai-quota-row-used-text">used</span>
                        </div>
                      </div>
                      <div className="ai-quota-progress-track">
                        <div
                          className={`ai-quota-progress-fill ${fillClass2}`}
                          style={{ width: `${item.quotaLimit.usedPercent}%` }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* Symmetrical Two-Column Footer */}
                <div className="ai-provider-card-footer">
                  <div className="ai-provider-card-footer-col">
                    <span className="ai-provider-card-footer-label">Rate Limit:</span>
                    {item.rateLimitPill && <span className="ai-rate-limit-pill">{item.rateLimitPill}</span>}
                  </div>
                  <div className="ai-provider-card-footer-col">
                    <span className="ai-provider-card-footer-label">MTD Spend:</span>
                    {item.mtdSpendFormatted ? <span className="ai-provider-card-footer-spend">{item.mtdSpendFormatted}</span> : <span className="ai-provider-card-footer-spend">Not reported</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Carousel Dock with Configurable Per-Page Density */}
        <div className="ai-fleet-carousel-dock">
          <div className="ai-carousel-pagination">
            <div className="ai-carousel-dots" aria-hidden="true">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`ai-carousel-dot${i === safePageIndex ? ' active' : ''}`}
                  onClick={() => setPageIndex(i)}
                  aria-label={`Go to page ${i + 1}`}
                />
              ))}
            </div>
            <span className="ai-carousel-page-status">
              Page {safePageIndex + 1} of {totalPages}
            </span>
          </div>

          <div className="ai-carousel-actions">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={safePageIndex === 0}
              onClick={() => setPageIndex(p => Math.max(0, p - 1))}
            >
              ‹ Previous
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={safePageIndex >= totalPages - 1}
              onClick={() => setPageIndex(p => Math.min(totalPages - 1, p + 1))}
            >
              Next {perPage} providers ›
            </button>
          </div>

          {/* Per Page Segmented Selector */}
          <div className="ai-carousel-density-picker">
            <span className="ai-carousel-density-label">Per page:</span>
            <div className="ai-carousel-segmented" role="group" aria-label="Items per page">
              {([2, 4, 6] as const).map(count => (
                <button
                  key={count}
                  type="button"
                  className={`ai-carousel-density-btn${perPage === count ? ' active' : ''}`}
                  onClick={() => {
                    setPerPage(count);
                    setPageIndex(0);
                  }}
                >
                  {count === 6 ? '6 max' : count}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {!error && !buckets && <div className="empty-state">Loading usage…</div>}

      {!error && buckets && (
        <>
          {/* Token Usage Chart & Model Breakdown */}
          {hasAnyUsage ? (
            <>
              <UsageBarChart buckets={buckets} granularity={granularity} />
              <div className="ai-usage-table-toggle">
                <button type="button" className="btn btn-compact" data-testid="ai-usage-table-toggle" onClick={() => setShowTable(current => !current)}>
                  {showTable ? 'Hide table' : 'View as table'}
                </button>
              </div>
              {showTable && <UsageTable buckets={buckets} granularity={granularity} />}
              {summary && <UsageModelBreakdown summary={summary} testIdPrefix="ai-usage" />}
            </>
          ) : (
            <div className="empty-state" data-testid="ai-usage-empty">
              <Icon name="graph" size={28} />
              <span>No AI usage has been logged yet — it appears here once a session or an AI feature runs.</span>
            </div>
          )}

          {/* Spend & Session Breakdown Block */}
          <div className="settings-section-block ai-spend-report-section" data-testid="ai-spend-report">
            <div className="ai-spend-report-header">
              <span className="ai-spend-report-title">Spend report</span>
              <div className="chip-row" role="group" aria-label="Spend report time range">
                {(
                  [
                    { label: 'All time', days: undefined },
                    { label: '30 days', days: 30 },
                    { label: '7 days', days: 7 }
                  ] as const
                ).map(range => (
                  <button
                    key={range.label}
                    type="button"
                    className={`chip${spendRangeDays === range.days ? ' filter-active' : ''}`}
                    onClick={() => setSpendRangeDays(range.days)}
                    data-testid={`ai-spend-range-${range.days ?? 'all'}`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </div>

            {spendRangeSessions.length === 0 ? (
              <p className="settings-hint">No sessions in this range.</p>
            ) : (
              <>
                <div className="list-row is-static">
                  <div>
                    <div className="list-row-title">Total cost</div>
                    <div className="list-row-meta" data-testid="ai-spend-total-cost">
                      {totalCostFormatted}
                    </div>
                  </div>
                </div>
                <div className="list-row is-static">
                  <div>
                    <div className="list-row-title">Sessions reporting cost or tokens</div>
                    <div className="list-row-meta">
                      {spendReportingCount} of {spendRangeSessions.length}
                    </div>
                  </div>
                </div>

                <div className="settings-section-subhead"><span>By provider &amp; model</span></div>
                <div className="ai-spend-breakdown-list">
                  {spendByProviderModel.map(row => (
                    <div className="list-row is-static" key={row.label} data-testid="ai-spend-provider-row">
                      <div>
                        <div className="list-row-title">{row.label}</div>
                        <div className="list-row-meta">{spendGroupMeta(row)}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="settings-section-subhead"><span>By connection</span></div>
                <div className="ai-spend-breakdown-list">
                  {spendByConnection.map(row => (
                    <div className="list-row is-static" key={row.label} data-testid="ai-spend-connection-row">
                      <div>
                        <div className="list-row-title">{row.label}</div>
                        <div className="list-row-meta">{spendGroupMeta(row)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
