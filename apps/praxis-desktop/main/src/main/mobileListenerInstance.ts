/**
 * Owns the mobile listener state and applies the persisted
 * `MobileAccessSettings` to it on startup and on every settings change.
 *
 * The listener is currently a descriptor only (`MobileListener` from core:
 * bound / mode / port). The encrypted LAN transport (FX-BE-077) will bind and
 * unbind a real socket here and sever established peers when
 * `resolveMobileListenerChange` reports `dropConnections`; until then this
 * records the transition through the log bus so the seam and its audit line
 * already exist. Default mode is `off`, so a fresh profile binds nothing.
 */
import type { MobileListener } from '@praxis/core';
import { getLogBus } from './logBusInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { resolveMobileListenerChange } from './mobileAccessLifecycle';

let current: MobileListener | undefined;

export function applyMobileAccessFromSettings(): MobileListener {
  const settings = getSettingsBackend().read().mobileAccess;
  const change = resolveMobileListenerChange(current, settings);
  current = change.listener;
  if (change.bind || change.unbind || change.dropConnections) {
    getLogBus().appendLine(`[mobile] ${change.reason}`);
  }
  // TODO(FX-BE-077): when change.bind — start the encrypted LAN listener on
  // change.listener.port; when change.unbind — stop it; when
  // change.dropConnections — close every established peer so it must
  // re-authenticate against the new policy.
  return current;
}

export function currentMobileListener(): MobileListener | undefined {
  return current;
}

export function resetMobileListenerState(): void {
  current = undefined;
}
