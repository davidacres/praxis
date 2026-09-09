export interface MobilePairingToken {
  tokenId: string;
  hostId: string;
  endpointHint?: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface MobilePairingRequest {
  tokenId: string;
  hostId: string;
  deviceId: string;
  devicePublicKey: string;
  projectIds: readonly string[];
  proof: string;
  requestedAt: string;
}

export type MobilePairingResult =
  | { ok: true; deviceId: string; projectIds: readonly string[] }
  | { ok: false; reason: 'expired' | 'replayed' | 'host-mismatch' | 'unconfirmed' | 'invalid-proof' };

export interface MobilePairingStore {
  get(tokenId: string): MobilePairingToken | undefined;
  save(token: MobilePairingToken): void;
}

export interface MobilePairingVerifier {
  verify(request: MobilePairingRequest, token: MobilePairingToken): boolean;
  confirmDevice(request: MobilePairingRequest): boolean;
}

export function consumeMobilePairing(
  store: MobilePairingStore,
  verifier: MobilePairingVerifier,
  request: MobilePairingRequest,
  now: string,
): MobilePairingResult {
  const token = store.get(request.tokenId);
  if (!token) return { ok: false, reason: 'replayed' };
  if (token.consumedAt) return { ok: false, reason: 'replayed' };
  if (token.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (token.hostId !== request.hostId) return { ok: false, reason: 'host-mismatch' };
  if (!verifier.verify(request, token)) return { ok: false, reason: 'invalid-proof' };
  if (!verifier.confirmDevice(request)) return { ok: false, reason: 'unconfirmed' };
  store.save({ ...token, consumedAt: now });
  return { ok: true, deviceId: request.deviceId, projectIds: request.projectIds };
}

export class InMemoryMobilePairingStore implements MobilePairingStore {
  private readonly tokens = new Map<string, MobilePairingToken>();

  constructor(tokens: readonly MobilePairingToken[] = []) {
    for (const token of tokens) this.tokens.set(token.tokenId, token);
  }

  get(tokenId: string): MobilePairingToken | undefined { return this.tokens.get(tokenId); }
  save(token: MobilePairingToken): void { this.tokens.set(token.tokenId, token); }
}
