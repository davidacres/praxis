import { useEffect, useMemo, useState } from 'react';
import type {
  AgentSessionRecord,
  AppSettings,
  AppSettingsPatch,
  Connection,
  UsageBucket,
  UsageComparison,
  UsageDashboardSummary,
  UsageGranularity
} from '@praxis/core';
import { Icon } from '../ui/Icon';
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
import { ProviderBudgets } from '../ai/ProviderBudgetsPanel';

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
      .catch(() => { /* the breakdown is supplementary; the chart reports its own errors */ });
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

      {/* Budget & Spend Limit Card */}
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

      {!error && <ProviderBudgets testIdPrefix="ai-usage-budgets" />}

      {!error && !buckets && <div className="empty-state">Loading usage…</div>}

      {!error && buckets && (
        <>
          {/* Key Stat Tiles Grid */}
          {(hasAnyUsage || spendRangeSessions.length > 0) && (
            <div className="ai-usage-stats-grid">
              <div className="ai-usage-stat-card">
                <small>Total cost</small>
                <strong data-testid="ai-usage-stat-total-cost">
                  {spendTotals.byCurrency.length === 0
                    ? 'No cost'
                    : spendTotals.byCurrency
                        .map(({ currency, amount }) => formatCost({ amount, currency }))
                        .filter((value): value is string => Boolean(value))
                        .join(' + ')}
                </strong>
                <span className="stat-subtitle">{spendReportingCount} of {spendRangeSessions.length} sessions reporting</span>
              </div>

              <div className="ai-usage-stat-card">
                <small>Tokens this {periodNoun}</small>
                <strong>{formatTokens(currentTokens)}</strong>
                <div className={`ai-usage-delta ai-usage-delta-${direction}`} data-testid="ai-usage-delta">
                  {direction !== 'flat' && (
                    <span className="ai-usage-delta-arrow" aria-hidden="true">
                      {direction === 'up' ? '▲' : '▼'}
                    </span>
                  )}
                  <span className="stat-subtitle">
                    {deltaPercent === undefined
                      ? currentTokens > 0 ? `No AI use last ${periodNoun}` : 'No use yet'
                      : direction === 'flat'
                        ? `Same as last ${periodNoun}`
                        : `${Math.abs(Math.round(deltaPercent))}% ${direction === 'up' ? 'more' : 'less'}`}
                  </span>
                </div>
              </div>

              <div className="ai-usage-stat-card">
                <small>All-time tokens</small>
                <strong>{summary ? formatTokenCompact(summary.allTime.totalTokens) : '—'}</strong>
                <span className="stat-subtitle">
                  {summary?.allTime.firstEventAt ? `Since ${new Date(summary.allTime.firstEventAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'From start'}
                </span>
              </div>

              <div className="ai-usage-stat-card">
                <small>Peak day</small>
                <strong>{summary?.highs.day ? formatTokenCompact(summary.highs.day.totalTokens) : '—'}</strong>
                <span className="stat-subtitle">
                  {summary?.highs.day ? formatPeriodLabel(summary.highs.day.periodStart, 'day') : 'Peak usage'}
                </span>
              </div>
            </div>
          )}

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
