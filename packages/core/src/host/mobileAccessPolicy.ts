import { isIPv4, isIPv6 } from 'node:net';

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

/** Loopback, RFC 1918, link-local and IPv6 unique-local; `::ffff:`-mapped IPv4 is judged as IPv4. */
export function isPrivateAddress(address: string): boolean {
  let value = address.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  if (isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIPv6(value)) {
    if (value === '::1') return true;
    const first = parseInt(value.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

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
  // Unlike `local-only` (bug 107-7 tracks that), a direct peer must also be on a private network: before the
  // relay, `internet` refused every direct peer, and it must not become reachable from the public internet.
  if (policy.mode === 'internet' && !isPrivateAddress(peer.remoteAddress)) return { allowed: false, reason: 'address-not-allowed' };
  if (policy.allowedInterfaces.length && !policy.allowedInterfaces.includes(peer.interfaceName)) return { allowed: false, reason: 'interface-not-allowed' };
  if (policy.allowedSubnets.length && !policy.allowedSubnets.some(subnet => peer.remoteAddress.startsWith(subnet))) return { allowed: false, reason: 'address-not-allowed' };
  return { allowed: true, reason: 'local-peer' };
}
