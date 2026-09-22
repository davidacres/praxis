export const MOBILE_PAIRING_INVITATION_VERSION = 1 as const;
export const MOBILE_PAIRING_TTL_MS = 10 * 60 * 1000;

export interface MobilePairingToken {
  tokenId: string;
  hostId: string;
  endpointHint?: string;
  expiresAt: string;
  consumedAt?: string;
}

/** Versioned QR / paste payload. Contains the single-use token; never a host private key. */
export interface MobilePairingInvitation {
  version: typeof MOBILE_PAIRING_INVITATION_VERSION;
  hostId: string;
  displayName: string;
  publicKeyHex: string;
  endpoints: readonly { address: string; port: number }[];
  tokenId: string;
  expiresAt: string;
}

export interface MobilePairingPendingRequest {
  requestId: string;
  tokenId: string;
  hostId: string;
  deviceId: string;
  devicePublicKey: string;
  deviceLabel: string;
  requestedAt: string;
}

export function issueMobilePairingToken(
  hostId: string,
  tokenId: string,
  now = new Date(),
  ttlMs = MOBILE_PAIRING_TTL_MS,
  endpointHint?: string,
): MobilePairingToken {
  return {
    tokenId,
    hostId,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ...(endpointHint ? { endpointHint } : {}),
  };
}

export function createMobilePairingInvitation(
  token: MobilePairingToken,
  input: { displayName: string; publicKeyHex: string; endpoints: readonly { address: string; port: number }[] },
): MobilePairingInvitation {
  return {
    version: MOBILE_PAIRING_INVITATION_VERSION,
    hostId: token.hostId,
    displayName: input.displayName,
    publicKeyHex: input.publicKeyHex,
    endpoints: input.endpoints,
    tokenId: token.tokenId,
    expiresAt: token.expiresAt,
  };
}

/** Compact alphanumeric payload for a QR; same fields as the JSON invitation. */
export function compactMobilePairingPayload(invitation: MobilePairingInvitation): string {
  const endpoint = invitation.endpoints[0];
  const host = endpoint ? `${endpoint.address}:${endpoint.port}` : '';
  return [
    `P${invitation.version}`,
    invitation.hostId,
    invitation.publicKeyHex,
    host,
    invitation.tokenId,
    invitation.expiresAt,
  ].join('|');
}

export function isActivePairingToken(token: MobilePairingToken | undefined, now: string): token is MobilePairingToken {
  return Boolean(token && !token.consumedAt && token.expiresAt > now);
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
