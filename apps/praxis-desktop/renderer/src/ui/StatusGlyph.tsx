import type React from 'react';

export type StatusGlyphState =
  | 'running'
  | 'executing'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'awaiting_approval'
  | 'awaiting_input'
  | string;

export interface StatusGlyphProps {
  status: StatusGlyphState;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'waveform' | 'pulse';
  className?: string;
  title?: string;
  ariaLabel?: string;
}

export type CanonicalStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'idle';

export function resolveStatusCategory(rawStatus: string): CanonicalStatus {
  const s = rawStatus.toLowerCase().trim();
  if (
    s === 'running' ||
    s === 'executing' ||
    s === 'in-progress' ||
    s === 'in_progress' ||
    s === 'active' ||
    s === 'planning'
  ) {
    return 'running';
  }
  if (
    s === 'awaiting_approval' ||
    s === 'awaiting_input' ||
    s === 'awaiting-approval' ||
    s === 'awaiting' ||
    s === 'paused' ||
    s === 'needs review' ||
    s === 'needs-review'
  ) {
    return 'awaiting';
  }
  if (
    s === 'completed' ||
    s === 'complete' ||
    s === 'succeeded' ||
    s === 'success' ||
    s === 'done' ||
    s === 'passed'
  ) {
    return 'completed';
  }
  if (
    s === 'failed' ||
    s === 'aborted' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'error'
  ) {
    return 'failed';
  }
  return 'idle';
}

function defaultLabelForCategory(category: CanonicalStatus, raw: string): string {
  switch (category) {
    case 'running':
      return 'Running';
    case 'awaiting':
      return raw === 'awaiting_input' ? 'Action required: input needed' : 'Action required: approval needed';
    case 'completed':
      return 'Completed';
    case 'failed':
      return raw === 'aborted' ? 'Aborted' : 'Failed';
    case 'idle':
      return 'Idle';
  }
}

/**
 * Rich, animated visual status indicator replacing plain colored dots.
 * Supports dynamic micro-waveforms, attention pulse action gates, spring checkmarks,
 * alert crosses, and muted resting states.
 */
export function StatusGlyph({
  status,
  size = 'md',
  variant = 'waveform',
  className = '',
  title,
  ariaLabel
}: StatusGlyphProps) {
  const category = resolveStatusCategory(status);
  const defaultLabel = defaultLabelForCategory(category, status);
  const effectiveTitle = title || defaultLabel;
  const effectiveAriaLabel = ariaLabel || title || defaultLabel;

  // Backwards compatibility classes for tests and existing stylesheets
  const legacyStatusModifier =
    category === 'running'
      ? 'easymode-status--running'
      : category === 'completed'
        ? 'easymode-status--success'
        : category === 'failed'
          ? 'easymode-status--failed'
          : 'easymode-status--idle';

  const legacyGlyphClass =
    category === 'awaiting'
      ? 'easymode-gate-symbol'
      : category === 'completed'
        ? 'completed-glyph'
        : category === 'failed'
          ? 'failed-glyph'
          : '';

  return (
    <span
      className={`status-glyph status-glyph--${category} status-glyph--${size} status-glyph--${variant} easymode-status ${legacyStatusModifier} ${legacyGlyphClass} ${className}`.trim()}
      title={effectiveTitle}
      aria-label={effectiveAriaLabel}
      role="status"
    >
      {category === 'running' && (
        variant === 'pulse' ? (
          <span className="status-glyph__ring-outer" aria-hidden="true">
            <span className="status-glyph__ring-core" />
          </span>
        ) : (
          <span className="status-glyph__waveform" aria-hidden="true">
            <span className="status-glyph__bar bar-1" />
            <span className="status-glyph__bar bar-2" />
            <span className="status-glyph__bar bar-3" />
          </span>
        )
      )}

      {category === 'awaiting' && (
        <span className="status-glyph__gate" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" className="status-glyph__gate-svg">
            <path
              d="M8 2 L14 8 L8 14 L2 8 Z"
              fill="currentColor"
              fillOpacity="0.18"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M8 5.5v3.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            <circle cx="8" cy="11.25" r="0.85" fill="currentColor" />
          </svg>
        </span>
      )}

      {category === 'completed' && (
        <span className="status-glyph__completed" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" className="status-glyph__check-svg">
            <path
              d="M3.5 8.5 L6.5 11.5 L12.5 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}

      {category === 'failed' && (
        <span className="status-glyph__failed" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" className="status-glyph__cross-svg">
            <path
              d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
      )}

      {category === 'idle' && (
        variant === 'pulse' ? (
          <span className="status-glyph__resting-ring" aria-hidden="true">
            <span className="status-glyph__resting-ring-dot" />
          </span>
        ) : (
          <span className="status-glyph__resting-bars" aria-hidden="true">
            <span className="status-glyph__resting-bar" />
            <span className="status-glyph__resting-bar" />
            <span className="status-glyph__resting-bar" />
          </span>
        )
      )}
    </span>
  );
}
