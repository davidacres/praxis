import { useState } from 'react';
import type { UsageDashboardSummary, UsageWindowSummary } from '@praxis/core';
import { formatCost, formatTokenCount } from './sessionNav';

/**
 * The per-model breakdown shared by the Overview usage panel and Settings → AI
 * Usage. Both render this one component from the one `dashboardSummary` read,
 * so the dashboard cannot be a second answer that disagrees with Settings.
 */

type BreakdownPeriod = 'today' | 'week' | 'month' | 'allTime';

const PERIODS: Array<{ value: BreakdownPeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'allTime', label: 'All time' }
];

export const COST_NOT_REPORTED = 'Not reported';

/** Cost per currency, labelled rather than converted; an empty list is "not reported", never a zero. */
export function formatUsageCost(costs: UsageWindowSummary['costByCurrency']): string {
  if (costs.length === 0) return COST_NOT_REPORTED;
  return costs.map(({ amount, currency }) => formatCost({ amount, currency }) ?? `${amount.toFixed(2)} ${currency}`).join(' · ');
}

interface UsageModelBreakdownProps {
  summary: UsageDashboardSummary;
  /** How many rows to show; Settings shows all, the dashboard a short list. */
  limit?: number;
  testIdPrefix: string;
}

export function UsageModelBreakdown({ summary, limit, testIdPrefix }: UsageModelBreakdownProps) {
  const [period, setPeriod] = useState<BreakdownPeriod>('week');
  const models = summary[period].models;
  const shown = limit ? models.slice(0, limit) : models;

  return (
    <div className="usage-models" data-testid={`${testIdPrefix}-models`}>
      <div className="usage-models-heading">
        <h4>Top models</h4>
        <div className="session-mode-toggle" role="group" aria-label="Top models period">
          {PERIODS.map(option => (
            <button
              key={option.value}
              type="button"
              className={period === option.value ? 'active' : ''}
              data-testid={`${testIdPrefix}-models-period-${option.value}`}
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="usage-models-empty" data-testid={`${testIdPrefix}-models-empty`}>No model usage in this period.</p>
      ) : (
        <ol className="usage-models-list">
          {shown.map((entry, index) => (
            <li key={`${entry.provider ?? ''}:${entry.model}`} className="usage-model-row" data-testid={`${testIdPrefix}-model-row`}>
              <span className="usage-model-rank">{index + 1}</span>
              <span className="usage-model-name" title={entry.provider ? `${entry.model} · ${entry.provider}` : entry.model}>
                {entry.model}
              </span>
              <span className="usage-model-bar" aria-hidden="true"><i style={{ width: `${Math.max(entry.tokenShare * 100, entry.totalTokens > 0 ? 2 : 0)}%` }} /></span>
              <span className="usage-model-tokens">{formatTokenCount(entry.totalTokens)}</span>
              <span className="usage-model-share">{Math.round(entry.tokenShare * 100)}%</span>
              <span className={`usage-model-cost${entry.costByCurrency.length === 0 ? ' usage-model-cost-absent' : ''}`}>
                {formatUsageCost(entry.costByCurrency)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {limit && models.length > limit && <small className="usage-models-more">+{models.length - limit} more in AI Usage</small>}
    </div>
  );
}
