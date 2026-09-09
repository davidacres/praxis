export type MobileAccessMode = 'off' | 'local-only' | 'internet';

export interface MobileAccessPolicy {
  mode: MobileAccessMode;
  allowedInterfaces: readonly string[];
  allowedSubnets: readonly string[];
}

export interface MobilePeerContext {
  interfaceName: string;
  remoteAddress: string;
  authenticated: boolean;
  forwardedFor?: string;
  relayRoute?: boolean;
}

export type MobileAccessDecision =
  | { allowed: true; reason: 'local-peer' | 'internet-peer' }
  | { allowed: false; reason: 'disabled' | 'not-authenticated' | 'relay-not-enabled' | 'forwarded-header-not-trusted' | 'interface-not-allowed' | 'address-not-allowed' };

export const DEFAULT_MOBILE_ACCESS_POLICY: MobileAccessPolicy = {
  mode: 'off',
  allowedInterfaces: [],
  allowedSubnets: [],
};

export function evaluateMobileAccess(policy: MobileAccessPolicy, peer: MobilePeerContext): MobileAccessDecision {
  if (policy.mode === 'off') return { allowed: false, reason: 'disabled' };
  if (!peer.authenticated) return { allowed: false, reason: 'not-authenticated' };
  if (peer.forwardedFor) return { allowed: false, reason: 'forwarded-header-not-trusted' };
  if (policy.mode === 'local-only') {
    if (peer.relayRoute) return { allowed: false, reason: 'relay-not-enabled' };
    if (policy.allowedInterfaces.length && !policy.allowedInterfaces.includes(peer.interfaceName)) return { allowed: false, reason: 'interface-not-allowed' };
    if (policy.allowedSubnets.length && !policy.allowedSubnets.some(subnet => peer.remoteAddress.startsWith(subnet))) return { allowed: false, reason: 'address-not-allowed' };
    return { allowed: true, reason: 'local-peer' };
  }
  if (peer.relayRoute) return { allowed: true, reason: 'internet-peer' };
  return { allowed: false, reason: 'address-not-allowed' };
}
