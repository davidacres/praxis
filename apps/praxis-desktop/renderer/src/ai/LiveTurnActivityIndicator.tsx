import { useEffect, useState } from 'react';
import type { AiProvider } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { providerIconName } from './modelProviders';

export interface LiveTurnActivityIndicatorProps {
  startedAt?: number | string;
  statusText: string;
  provider?: AiProvider;
  model?: string;
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
  model
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

  const formattedTime = formatElapsedDuration(elapsedMs);

  return (
    <div
      className="session-activity-status"
      data-testid="session-activity-status"
      role="status"
      aria-live="polite"
    >
      {provider ? (
        <Icon
          name={providerIconName(provider)}
          size={13}
          className={`session-activity-icon session-activity-icon-${provider}`}
        />
      ) : (
        <span className="session-activity-dot" aria-hidden="true" />
      )}
      <span className="session-activity-label">{statusText}</span>
      <span className="session-activity-timer" data-testid="session-activity-timer" aria-label={`Elapsed time: ${formattedTime}`}>
        {formattedTime}
      </span>
    </div>
  );
}
