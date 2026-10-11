import { isLocalNetworkAddress, normalizeMobileSubnet, addressInSubnet } from '../ai/tools/networkAddress';

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

/** Shared normalized IP classifier, including hexadecimal mapped IPv4. */
export const isPrivateAddress = isLocalNetworkAddress;

export const DEFAULT_MOBILE_ACCESS_POLICY: MobileAccessPolicy = {
  mode: 'off',
  allowedInterfaces: [],
  allowedSubnets: [],
};

export function evaluateMobileAccess(policy: MobileAccessPolicy, peer: MobilePeerContext): MobileAccessDecision {
  if (policy.mode === 'off') return { allowed: false, reason: 'disabled' };
  if (!peer.authenticated) return { allowed: false, reason: 'not-authenticated' };
  if (peer.forwardedFor) return { allowed: false, reason: 'forwarded-header-not-trusted' };
  // A relayed stream has no local interface or address to judge: only `internet` mode admits it.
  if (peer.relayRoute) return policy.mode === 'internet' ? { allowed: true, reason: 'internet-peer' } : { allowed: false, reason: 'relay-not-enabled' };
  // `internet` is "local + internet relay" (architecture.md): direct peers keep the local allowlists.
  // Both direct modes require a local network address; relay admission is checked above.
  if (!isPrivateAddress(peer.remoteAddress)) return { allowed: false, reason: 'address-not-allowed' };
  if (policy.allowedInterfaces.length && !policy.allowedInterfaces.includes(peer.interfaceName)) return { allowed: false, reason: 'interface-not-allowed' };
  if (policy.allowedSubnets.length && !policy.allowedSubnets.some(subnet => { const normalized = normalizeMobileSubnet(subnet); return normalized !== undefined && addressInSubnet(peer.remoteAddress, normalized); })) return { allowed: false, reason: 'address-not-allowed' };
  return { allowed: true, reason: 'local-peer' };
}
