/**
 * Turns the persisted `MobileAccessSettings` into a bound/unbound
 * `MobileListener` and decides whether established peers must be dropped.
 *
 * Pure — no sockets, no Electron. `index.ts` owns the real listener and calls
 * `resolveMobileListenerChange` on startup and on every settings change, then
 * binds/unbinds and severs connections accordingly. "Network restrictions are
 * host-enforced on new and established connections" (architecture.md), so any
 * narrowing or lateral change to the policy drops current peers; they must
 * re-authenticate against the new policy to reconnect.
 */
import {
  DEFAULT_MOBILE_ACCESS_POLICY,
  createMobileListener,
  type MobileAccessPolicy,
  type MobileAccessSettings,
  type MobileListener,
} from '@praxis/core';

export const DEFAULT_MOBILE_LISTENER_PORT = 43100;

export function mobileAccessPolicyFromSettings(settings: MobileAccessSettings): MobileAccessPolicy {
  return {
    mode: settings.mode,
    allowedInterfaces: [...settings.allowedInterfaces],
    allowedSubnets: [...settings.allowedSubnets],
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePolicy(left: MobileAccessPolicy, right: MobileAccessPolicy): boolean {
  return (
    left.mode === right.mode &&
    sameList(left.allowedInterfaces, right.allowedInterfaces) &&
    sameList(left.allowedSubnets, right.allowedSubnets)
  );
}

export interface MobileListenerChange {
  listener: MobileListener;
  /** Bind/rebind the socket (mode moved off `off`, or the port/policy changed while bound). */
  bind: boolean;
  /** Unbind the socket (mode moved to `off`). */
  unbind: boolean;
  /** Sever every established peer — the policy narrowed or changed laterally. */
  dropConnections: boolean;
  reason: string;
}

export function resolveMobileListenerChange(
  previous: MobileListener | undefined,
  settings: MobileAccessSettings,
  port: number = DEFAULT_MOBILE_LISTENER_PORT,
): MobileListenerChange {
  const policy = mobileAccessPolicyFromSettings(settings);
  const listener = createMobileListener(policy, port);
  const previousPolicy: MobileAccessPolicy = previous
    ? { mode: previous.mode, allowedInterfaces: DEFAULT_MOBILE_ACCESS_POLICY.allowedInterfaces, allowedSubnets: DEFAULT_MOBILE_ACCESS_POLICY.allowedSubnets }
    : DEFAULT_MOBILE_ACCESS_POLICY;

  if (!previous) {
    return {
      listener,
      bind: listener.bound,
      unbind: false,
      dropConnections: false,
      reason: listener.bound ? `Mobile access started in ${listener.mode} mode.` : 'Mobile access is off.',
    };
  }

  if (previous.mode === settings.mode && previous.port === listener.port && previous.bound === listener.bound) {
    // Same mode and port; interface/subnet allowlists can still have narrowed.
    const narrowed = !samePolicy(previousPolicy, policy);
    return {
      listener,
      bind: false,
      unbind: false,
      dropConnections: narrowed,
      reason: narrowed ? 'The mobile access allowlist changed; established peers were dropped.' : 'No change to mobile access.',
    };
  }

  if (settings.mode === 'off') {
    return { listener, bind: false, unbind: true, dropConnections: true, reason: 'Mobile access was turned off.' };
  }

  const widening = previous.mode === 'local-only' && settings.mode === 'internet';
  return {
    listener,
    bind: true,
    unbind: false,
    dropConnections: !widening,
    reason: widening
      ? 'Mobile access widened to internet; local peers kept.'
      : `Mobile access changed to ${settings.mode}; established peers were dropped.`,
  };
}
