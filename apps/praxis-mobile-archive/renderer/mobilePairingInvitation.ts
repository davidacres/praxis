/**
 * Reads what the desktop's Settings → Mobile access offers for pairing — the
 * compact QR text (`P1|hostId|key|address:port|tokenId|expiresAt`), the JSON
 * invitation, or a bare 64-hex host key — and turns connection failures into
 * something a person can act on.
 */
import type { MobileConnectionErrorCode } from '@praxis/mobile-protocol';
import { parseInstant } from './mobileTime';

export interface MobileInvitationDetails {
  hostId?: string;
  hostName?: string;
  address?: string;
  port?: number;
  hostPublicKeyHex?: string;
  /** Single-use token; presented once to request confirmation. */
  tokenId?: string;
  expiresAt?: string;
}

export type MobileInvitationParse =
  | { kind: 'invitation'; details: MobileInvitationDetails; expired: boolean }
  | { kind: 'key'; details: MobileInvitationDetails }
  | { kind: 'unrecognised' };

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function splitEndpoint(endpoint: string | undefined): { address?: string; port?: number } {
  const separator = endpoint?.lastIndexOf(':') ?? -1;
  if (!endpoint || separator <= 0) return {};
  const port = Number(endpoint.slice(separator + 1));
  return { address: endpoint.slice(0, separator), ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}) };
}

export function parseMobileInvitation(raw: string, now: Date = new Date()): MobileInvitationParse {
  const value = raw.trim();
  const expired = (expiresAt: string | undefined): boolean => (parseInstant(expiresAt) ?? Infinity) <= now.getTime();
  if (HEX_KEY.test(value)) return { kind: 'key', details: { hostPublicKeyHex: value.toLowerCase() } };
  if (/^P\d+\|/.test(value)) {
    const [, hostId, key, endpoint, tokenId, expiresAt] = value.split('|');
    const details: MobileInvitationDetails = {
      ...(hostId ? { hostId } : {}),
      ...(key && HEX_KEY.test(key) ? { hostPublicKeyHex: key.toLowerCase() } : {}),
      ...splitEndpoint(endpoint),
      ...(tokenId ? { tokenId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    return details.hostPublicKeyHex ? { kind: 'invitation', details, expired: expired(expiresAt) } : { kind: 'unrecognised' };
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const endpoints = Array.isArray(parsed.endpoints) ? parsed.endpoints as Array<{ address?: unknown; port?: unknown }> : [];
    const addresses = Array.isArray(parsed.addresses) ? parsed.addresses : [];
    const firstEndpoint = endpoints[0];
    const address = typeof firstEndpoint?.address === 'string' ? firstEndpoint.address : typeof addresses[0] === 'string' ? addresses[0] as string : undefined;
    const port = typeof firstEndpoint?.port === 'number' ? firstEndpoint.port : typeof parsed.port === 'number' ? parsed.port : undefined;
    const key = typeof parsed.publicKeyHex === 'string' && HEX_KEY.test(parsed.publicKeyHex) ? parsed.publicKeyHex.toLowerCase() : undefined;
    if (!key) return { kind: 'unrecognised' };
    const hostName = typeof parsed.displayName === 'string' ? parsed.displayName : typeof parsed.hostName === 'string' ? parsed.hostName : undefined;
    const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined;
    return {
      kind: 'invitation',
      details: {
        ...(typeof parsed.hostId === 'string' ? { hostId: parsed.hostId } : {}),
        ...(hostName ? { hostName } : {}),
        ...(address ? { address } : {}),
        ...(port ? { port } : {}),
        hostPublicKeyHex: key,
        ...(typeof parsed.tokenId === 'string' ? { tokenId: parsed.tokenId } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      expired: expired(expiresAt),
    };
  } catch {
    return { kind: 'unrecognised' };
  }
}

export type MobileIssueAction = 'rescan' | 'retry' | 'wait' | 'check-desktop';

export interface MobileConnectionIssue {
  code: string;
  title: string;
  message: string;
  action: MobileIssueAction;
  retryable: boolean;
}

const ISSUE_TITLES: Partial<Record<MobileConnectionErrorCode, { title: string; action: MobileIssueAction }>> = {
  'pairing-required': { title: 'This phone is not paired', action: 'rescan' },
  'pairing-pending': { title: 'Waiting for desktop confirmation', action: 'wait' },
  'pairing-rejected': { title: 'Pairing was declined', action: 'rescan' },
  'invitation-expired': { title: 'Invitation expired', action: 'rescan' },
  'invitation-invalid': { title: 'Invitation not recognised', action: 'rescan' },
  'invitation-used': { title: 'Invitation already used', action: 'rescan' },
  'device-revoked': { title: 'Access revoked', action: 'rescan' },
  'host-key-reset': { title: 'Desktop key was reset', action: 'rescan' },
  'handshake-rejected': { title: 'Secure handshake refused', action: 'rescan' },
  'handshake-failed': { title: 'Desktop identity mismatch', action: 'rescan' },
  'access-disabled': { title: 'Mobile access is off', action: 'check-desktop' },
  'access-denied': { title: 'Network not allowed', action: 'check-desktop' },
  'unreachable': { title: 'Desktop unreachable', action: 'retry' },
  'timed-out': { title: 'Desktop not responding', action: 'retry' },
  'connection-lost': { title: 'Connection lost', action: 'retry' },
  'host-shutdown': { title: 'Desktop stopped listening', action: 'retry' },
  'protocol-error': { title: 'Connection error', action: 'retry' },
};

export function describeConnectionIssue(error: unknown): MobileConnectionIssue {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  const retryable = (error as { retryable?: unknown })?.retryable === true;
  const known = ISSUE_TITLES[code as MobileConnectionErrorCode];
  return {
    code,
    title: known?.title ?? 'Couldn’t connect',
    message,
    action: known?.action ?? (retryable ? 'retry' : 'check-desktop'),
    retryable,
  };
}

/** Delay before reconnect attempt `attempt` (0-based): 1s, 2s, 4s … capped at 30s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
