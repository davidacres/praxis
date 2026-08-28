import type { ConnectionCheck } from '@praxis/core';

export interface ConnectionStatusDotProps {
  /** Latest health-check result for the connection; undefined while the first check runs. */
  check: ConnectionCheck | undefined;
}

/**
 * Small status dot for a connection, fed by `connection.check` results (run
 * lazily in App after the list loads — never blocking the board list).
 */
export function ConnectionStatusDot({ check }: ConnectionStatusDotProps) {
  const status = check?.status ?? 'checking';
  const title = check ? `${check.message} (${check.status})` : 'Checking connection…';
  return (
    <span
      className={`status-dot status-dot--${status}`}
      data-testid="status-dot"
      data-status={status}
      title={title}
      aria-label={title}
    />
  );
}
