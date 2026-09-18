import { useEffect, useMemo, useState } from 'react';
import type { UsageBucket, UsageComparison, UsageGranularity } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * Settings → AI Usage: the AI usage ledger (`AiUsageLog`) bucketed by
 * day/week/month, with a bar per period and a latest-vs-previous-period
 * comparison — "are we using more or less AI than last week", generalised to
 * any granularity. Every event any AI feature logs (agent sessions, the
 * workflow agent recommendation) lands in the same ledger, so this is the one
 * place total AI usage is visible across the whole app.
 *
 * A single metric (total tokens) over discrete, non-overlapping periods —
 * bars, not a line: a line implies interpolation between points that don't
 * exist between "this week" and "last week". One series, so no legend; the
 * current period is the one filled with the full accent, past periods a
 * muted tint of the same hue rather than a second, unrelated color.
 */

const GRANULARITIES: { value: UsageGranularity; label: string }[] = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' }
];

const PERIODS_SHOWN = 8;

const numberFormatter = new Intl.NumberFormat(undefined);

function formatTokens(value: number): string {
  return numberFormatter.format(Math.round(value));
}

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

/** A rect with only its top corners rounded, flush to the baseline — the mark spec's "rounded data-end anchored to the baseline". */
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
              {/* Full-height, invisible hit target — the visible bar can be a sliver for a near-zero period. */}
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
          {buckets[hoverIndex].costByCurrency.length === 1 && (
            <span>
              {buckets[hoverIndex].costByCurrency[0].amount.toFixed(2)} {buckets[hoverIndex].costByCurrency[0].currency}
            </span>
          )}
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

function ComparisonCallout({ comparison }: { comparison: UsageComparison }) {
  const { current, deltaPercent } = comparison;
  const direction = deltaPercent === undefined ? 'flat' : deltaPercent > 0.5 ? 'up' : deltaPercent < -0.5 ? 'down' : 'flat';
  const periodNoun = comparison.granularity === 'hour' ? 'hour' : comparison.granularity === 'day' ? 'day' : comparison.granularity === 'week' ? 'week' : 'month';

  return (
    <div className="ai-usage-headline">
      <div className="ai-usage-headline-figure">
        <span className="ai-usage-headline-value">{formatTokens(current.totalTokens)}</span>
        <span className="ai-usage-headline-unit">tokens this {periodNoun}</span>
      </div>
      <div className={`ai-usage-delta ai-usage-delta-${direction}`} data-testid="ai-usage-delta">
        {direction !== 'flat' && (
          <span className="ai-usage-delta-arrow" aria-hidden="true">
            {direction === 'up' ? '▲' : '▼'}
          </span>
        )}
        <span>
          {deltaPercent === undefined
            ? current.totalTokens > 0
              ? `No AI use logged last ${periodNoun}`
              : `No AI use logged yet`
            : direction === 'flat'
              ? `About the same as last ${periodNoun}`
              : `${Math.abs(Math.round(deltaPercent))}% ${direction === 'up' ? 'more' : 'less'} than last ${periodNoun}`}
        </span>
      </div>
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
            <td>
              {bucket.costByCurrency.length === 0
                ? '—'
                : bucket.costByCurrency.map(entry => `${entry.amount.toFixed(2)} ${entry.currency}`).join(', ')}
            </td>
            <td>{bucket.eventCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AiUsageStatsSection() {
  const [granularity, setGranularity] = useState<UsageGranularity>('week');
  const [buckets, setBuckets] = useState<UsageBucket[] | undefined>();
  const [comparison, setComparison] = useState<UsageComparison | undefined>();
  const [showTable, setShowTable] = useState(false);
  const [error, setError] = useState<string | undefined>();

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

  const hasAnyUsage = useMemo(() => (buckets ?? []).some(bucket => bucket.eventCount > 0), [buckets]);

  return (
    <>
      <div className="settings-category-header">
        <div>
          <h3 className="settings-section-title">AI Usage</h3>
          <p className="settings-section-description">
            Token and cost usage across every session and internal AI feature, by day, week, or month.
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

      {!error && !buckets && <div className="empty-state">Loading usage…</div>}

      {!error && buckets && !hasAnyUsage && (
        <div className="empty-state" data-testid="ai-usage-empty">
          <Icon name="graph" size={28} />
          <span>No AI usage has been logged yet — it appears here once a session or an AI feature like the workflow agent recommendation runs.</span>
        </div>
      )}

      {!error && buckets && comparison && hasAnyUsage && (
        <>
          <ComparisonCallout comparison={comparison} />
          <UsageBarChart buckets={buckets} granularity={granularity} />
          <div className="ai-usage-table-toggle">
            <button type="button" className="btn btn-compact" data-testid="ai-usage-table-toggle" onClick={() => setShowTable(current => !current)}>
              {showTable ? 'Hide table' : 'View as table'}
            </button>
          </div>
          {showTable && <UsageTable buckets={buckets} granularity={granularity} />}
        </>
      )}
    </>
  );
}
