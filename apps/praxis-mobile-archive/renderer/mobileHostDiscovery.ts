// Browser-safe mirror of core's host-discovery contract
// (`@praxis/core` -> `host/mobileHostDiscovery`). Duplicated locally so the
// mobile package carries no import from core and stays portable to its own
// repository — see docs/architecture.md ("mobile imports only versioned
// browser-safe contracts") and the repo convention of duplicating a small pure
// contract next to where it is used rather than reaching across a package.
export interface MobileHostHint {
  hostId: string;
  hostName: string;
  address: string;
  port: number;
  hostKeyFingerprint: string;
  source: 'discovery' | 'manual' | 'last-known';
}

export interface MobileHostIdentityVerifier {
  verify(hint: MobileHostHint): boolean;
}

export interface MobileLanDiscoveryHint {
  hostId: string;
  displayName: string;
  fingerprint: string;
  port: number;
  addresses: readonly string[];
}

export function parseMobileLanDiscoveryHint(raw: string): MobileLanDiscoveryHint | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.hostId !== 'string' || typeof value.displayName !== 'string') return undefined;
    if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{16}$/i.test(value.fingerprint)) return undefined;
    if (typeof value.port !== 'number' || value.port < 1024 || value.port > 65535) return undefined;
    if (!Array.isArray(value.addresses) || !value.addresses.every(address => typeof address === 'string')) return undefined;
    if ('tokenId' in value || 'publicKeyHex' in value || 'privateKey' in value) return undefined;
    return {
      hostId: value.hostId,
      displayName: value.displayName,
      fingerprint: value.fingerprint.toLowerCase(),
      port: value.port,
      addresses: value.addresses.filter(address => address.length > 0),
    };
  } catch {
    return undefined;
  }
}

export function resolveMobileHost(
  hints: readonly MobileHostHint[],
  verifier: MobileHostIdentityVerifier,
): MobileHostHint | undefined {
  for (const hint of hints) if (verifier.verify(hint)) return hint;
  return undefined;
}

export function rememberMobileHost(hint: MobileHostHint): MobileHostHint {
  return { ...hint, source: 'last-known' };
}
