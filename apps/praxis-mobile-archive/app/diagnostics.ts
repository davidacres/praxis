import { useSyncExternalStore } from 'react';
import {
  addDiagnostic,
  diagnosticMessage,
  syncFailed,
  syncSucceeded,
  type MobileDiagnostic,
  type MobileSyncState,
} from '../renderer/mobileDiagnostics';

/**
 * The phone's record of what went wrong, outside React state so the store,
 * background refreshes and the error boundary can all write to it. App
 * settings shows the list; screens show a banner while a refresh is failing.
 */
let diagnostics: MobileDiagnostic[] = [];
let sync: MobileSyncState = {};
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records a failure the person should be able to find later. */
export function recordDiagnostic(what: string, error: unknown): void {
  diagnostics = addDiagnostic(diagnostics, { at: new Date().toISOString(), what, message: diagnosticMessage(error) });
  changed();
}

/** A background refresh failed: record it and mark what is shown as possibly stale. */
export function refreshFailed(what: string, error: unknown): void {
  const message = diagnosticMessage(error);
  sync = syncFailed(sync, what, message, new Date().toISOString());
  diagnostics = addDiagnostic(diagnostics, { at: new Date().toISOString(), what, message });
  changed();
}

/** A background refresh worked: whatever is shown is current again. */
export function refreshSucceeded(): void {
  const wasFailing = Boolean(sync.failing);
  sync = syncSucceeded(sync, new Date().toISOString());
  if (wasFailing) changed();
}

export function clearDiagnostics(): void {
  diagnostics = [];
  sync = {};
  changed();
}

export function useDiagnostics(): readonly MobileDiagnostic[] {
  return useSyncExternalStore(subscribe, () => diagnostics);
}

export function useSyncState(): MobileSyncState {
  return useSyncExternalStore(subscribe, () => sync);
}
