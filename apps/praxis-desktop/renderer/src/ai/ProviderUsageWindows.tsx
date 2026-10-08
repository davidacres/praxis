import type { ProviderUsageSnapshot, ProviderUsageWindow } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ProviderBrandLogo } from './ProviderBrandLogo';
import { providerLabel } from './modelProviders';
import { formatTokenCompact } from './sessionNav';

/**
 * Presentational pieces of a provider's account usage: the provider card, a quota
 * bar with a reset countdown, and a consumption-only row. Shared by the Overview provider cards
 * and the session composer's usage panel so both read the same.
 */

/** "2h 14m" or "4d 18h" — the shape people read a countdown in. */
export function countdown(resetsAt: string, now: number): string {
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
export function isQuota(window: ProviderUsageWindow): boolean {
  if (typeof window.usedPercent === 'number') return true;
  const used = window.usedTokens ?? window.usedCost;
  const limit = window.tokenLimit ?? window.costLimit;
  return typeof used === 'number' && typeof limit === 'number' && limit > 0;
}

/** Provider-reported percentage, or used / limit when only absolute figures are given. */
export function windowPercent(window: ProviderUsageWindow): number {
  if (typeof window.usedPercent === 'number') return window.usedPercent;
  const used = window.usedTokens ?? window.usedCost ?? 0;
  const limit = window.tokenLimit ?? window.costLimit ?? 1;
  return Math.round((used / limit) * 100);
}

export function QuotaWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
  const percent = windowPercent(window);
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

export function ConsumptionWindow({ window, now, testIdPrefix }: { window: ProviderUsageWindow; now: number; testIdPrefix: string }) {
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

export function ProviderCard({
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

  const maxUsed = Math.max(0, ...snapshot.windows.map(windowPercent));

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

  const hasData = (!snapshot.unavailableReason && (quotaWindows.length > 0 || consumptionWindows.length > 0)) || Boolean(rateLimitPill) || Boolean(displaySpend);
  const isCompact = !hasData;

  return (
    <div
      className={`overview-budget-card ai-provider-card${isCompact ? ' is-compact' : ''}`}
      data-testid={`${testIdPrefix}-card-${snapshot.provider}`}
      data-compact={isCompact ? 'true' : undefined}
    >
      <div className="ai-provider-card-head overview-budget-card-head">
        <div className="ai-provider-card-identity">
          <div className="ai-provider-card-logo">
            <ProviderBrandLogo provider={snapshot.provider} size={isCompact ? 22 : 32} />
          </div>
          <div className="ai-provider-card-names">
            <div className="ai-provider-card-title overview-budget-card-name">{label}</div>
            <div className="ai-provider-card-type">{typeLabel}</div>
          </div>
        </div>
        <div className={`ai-provider-card-status is-${status}`} data-testid={`${testIdPrefix}-status-${snapshot.provider}`}>
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
