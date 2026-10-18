import { useEffect, useState } from 'react';
import type { AiProvider } from '@praxis/core';
import { ProviderBrandLogo } from '../ui/ProviderBrandLogo';
import { StatusGlyph } from '../ui/StatusGlyph';

export interface LiveTurnActivityIndicatorProps {
  startedAt?: number | string;
  statusText: string;
  provider?: AiProvider;
  model?: string;
  tokenCount?: number;
  variant?: 'chat' | 'composer';
  testId?: string;
}

function parseStartTime(startedAt?: number | string): number {
  if (typeof startedAt === 'number' && !Number.isNaN(startedAt)) {
    return startedAt;
  }
  if (typeof startedAt === 'string') {
    const parsed = Date.parse(startedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export function formatElapsedDuration(elapsedMs: number): string {
  const safeMs = Math.max(0, elapsedMs);
  const totalSeconds = safeMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Isolated leaf component that presents the active AI turn activity
 * with a sub-second ticking elapsed timer, preventing re-renders of the
 * parent transcript.
 */
export function LiveTurnActivityIndicator({
  startedAt,
  statusText,
  provider,
  model,
  tokenCount,
  variant = 'chat',
  testId = variant === 'composer' ? 'session-composer-activity-chip' : 'session-activity-status'
}: LiveTurnActivityIndicatorProps) {
  const [startTime, setStartTime] = useState<number>(() => parseStartTime(startedAt));

  useEffect(() => {
    if (startedAt) {
      setStartTime(parseStartTime(startedAt));
    }
  }, [startedAt]);

  const [elapsedMs, setElapsedMs] = useState<number>(() => Math.max(0, Date.now() - startTime));

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startTime));
    }, 100);

    return () => clearInterval(interval);
  }, [startTime]);

  const reportedTokens = typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount >= 0
    ? Math.round(tokenCount).toLocaleString() : undefined;
  const formattedTime = formatElapsedDuration(elapsedMs);

  return (
    <div
      className={variant === 'composer' ? 'composer-chip session-runtime-chip is-readonly session-activity-chip session-composer-live-activity' : 'session-activity-status'}
      data-testid={testId}
      role="status"
      aria-live={variant === 'composer' ? 'off' : 'polite'}
    >
      {provider ? (
        <ProviderBrandLogo
          provider={provider}
          size={13}
          className={`session-activity-icon session-activity-icon-${provider}`}
        />
      ) : (
        <StatusGlyph status="running" size="sm" ariaLabel="Active turn running" />
      )}
      <span className="session-activity-label" title={variant === 'composer' ? statusText : undefined}>{statusText}</span>
      <span className="session-activity-timer" data-testid={variant === 'composer' ? 'session-composer-activity-timer' : 'session-activity-timer'} aria-label={`Elapsed time: ${formattedTime}`}>
        {formattedTime}
      </span>
      {variant === 'composer' && <span
        className="session-activity-tokens"
        data-testid="session-composer-token-count"
        title={reportedTokens === undefined ? 'Token usage not reported' : 'Reported session token total'}
        aria-label={reportedTokens === undefined ? 'Token usage not reported' : `${reportedTokens} reported tokens for this session`}
      >{reportedTokens ?? '—'} tokens</span>}
    </div>
  );
}
