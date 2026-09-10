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
