/**
 * What went wrong talking to the desktop, kept where a person can see it —
 * a background refresh that fails must not leave stale data on screen
 * looking current.
 */

export interface MobileDiagnostic {
  at: string;
  /** What the phone was doing, in words ("Refreshing attention"). */
  what: string;
  message: string;
}

export const MAX_DIAGNOSTICS = 50;

export function addDiagnostic(list: readonly MobileDiagnostic[], entry: MobileDiagnostic, limit = MAX_DIAGNOSTICS): MobileDiagnostic[] {
  return [entry, ...list].slice(0, limit);
}

export function diagnosticMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export interface MobileSyncState {
  /** When a background refresh last succeeded. */
  lastOkAt?: string;
  /** The refresh that is failing now, and since when. Cleared by the next success. */
  failing?: { what: string; message: string; since: string };
}

export function syncSucceeded(state: MobileSyncState, at: string): MobileSyncState {
  return { lastOkAt: at };
}

export function syncFailed(state: MobileSyncState, what: string, message: string, at: string): MobileSyncState {
  return { ...state, failing: state.failing ? { ...state.failing, what, message } : { what, message, since: at } };
}

/** One line for the banner: what failed, and how old the shown data is. */
export function describeStaleness(state: MobileSyncState, formatClock: (iso: string) => string): string | undefined {
  if (!state.failing) return undefined;
  const age = state.lastOkAt ? ` Showing what was last received at ${formatClock(state.lastOkAt)}.` : '';
  return `${state.failing.what} failed: ${state.failing.message}.${age}`;
}
