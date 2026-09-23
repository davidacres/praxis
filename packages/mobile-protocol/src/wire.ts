/**
 * The frames carried inside an open Noise channel, and the connection status
 * vocabulary both ends share. The desktop LAN listener writes these; the phone
 * (through `MobileSecureClient`) reads them. Operation payloads stay opaque
 * here — their contracts live with the host application in `@praxis/core`.
 *
 * Every accepted channel starts with one `status` frame: `ready` for a paired
 * device, `pairing-required` for an unknown one, or a refusal. The listener
 * sends a refusal *before* closing, so the phone can say why instead of
 * reporting a bare closed socket.
 */

export interface MobileRequestFrame {
  id: string;
  /** `pair` presents an invitation token for an unknown device (payload `{ tokenId }`). */
  kind: 'read' | 'command' | 'replay' | 'pair';
  payload: unknown;
}

export type MobileReplyErrorCode =
  | 'pairing-pending'
  | 'not-authorised'
  | 'unsupported-operation'
  | 'cursor-expired'
  | 'rejected';

export interface MobileReplyFrame {
  id: string;
  kind: 'reply';
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: MobileReplyErrorCode;
}

export interface MobileEventFrame {
  kind: 'event';
  envelope: { sequence: number } & Record<string, unknown>;
}

export interface MobileStatusFrame {
  kind: 'status';
  status: MobileConnectionStatus;
}

export type MobileServerFrame = MobileReplyFrame | MobileEventFrame | MobileStatusFrame;

/** Result of a `replay` request. */
export interface MobileReplayResult {
  replaying: true;
  latestSequence: number;
  /** Events after the requested cursor have already left the desktop's bounded log; re-read state. */
  truncated?: boolean;
}

export type MobileConnectionStatusCode =
  /** Paired and authorised: requests may flow. */
  | 'ready'
  /** Unknown device: present an invitation token with a `pair` frame. */
  | 'pairing-required'
  /** Token accepted; waiting for someone to confirm this phone on the desktop. */
  | 'pairing-pending'
  | 'pairing-rejected'
  | 'invitation-expired'
  | 'invitation-invalid'
  | 'invitation-used'
  | 'device-revoked'
  | 'host-key-reset'
  | 'access-disabled'
  | 'access-denied'
  | 'host-shutdown';

export interface MobileConnectionStatus {
  code: MobileConnectionStatusCode;
  message: string;
  /** True when simply reconnecting later may succeed without user action. */
  retryable: boolean;
}

const STATUS_DEFAULTS: Record<MobileConnectionStatusCode, { message: string; retryable: boolean }> = {
  'ready': { message: 'Connected.', retryable: true },
  'pairing-required': { message: 'This phone is not paired with the desktop. Scan a current pairing invitation from Settings → Mobile access.', retryable: false },
  'pairing-pending': { message: 'Waiting for this phone to be confirmed in Settings → Mobile access on the desktop.', retryable: true },
  'pairing-rejected': { message: 'The desktop declined this pairing request.', retryable: false },
  'invitation-expired': { message: 'The pairing invitation has expired. Create a new invitation in Settings → Mobile access and scan it again.', retryable: false },
  'invitation-invalid': { message: 'The pairing invitation does not match the one the desktop is offering. Scan the invitation currently shown in Settings → Mobile access.', retryable: false },
  'invitation-used': { message: 'That pairing invitation has already been used. Create a new invitation on the desktop to pair this phone.', retryable: false },
  'device-revoked': { message: 'The desktop revoked this phone’s access. Pair it again with a new invitation from Settings → Mobile access.', retryable: false },
  'host-key-reset': { message: 'The desktop reset its host key, so every phone must pair again. Scan a new invitation from Settings → Mobile access.', retryable: false },
  'access-disabled': { message: 'Mobile access is turned off on the desktop. Turn it on in Settings → Mobile access.', retryable: false },
  'access-denied': { message: 'The desktop’s mobile access policy does not allow connections from this network.', retryable: false },
  'host-shutdown': { message: 'The Praxis desktop stopped its mobile listener.', retryable: true },
};

export function mobileConnectionStatus(code: MobileConnectionStatusCode, message?: string): MobileConnectionStatus {
  const fallback = STATUS_DEFAULTS[code];
  return { code, message: message?.trim() || fallback.message, retryable: fallback.retryable };
}

export function isMobileConnectionStatusCode(value: unknown): value is MobileConnectionStatusCode {
  return typeof value === 'string' && value in STATUS_DEFAULTS;
}

/** A status code that ends the connection (anything but ready / pairing in progress). */
export function isTerminalMobileStatus(code: MobileConnectionStatusCode): boolean {
  return code !== 'ready' && code !== 'pairing-required' && code !== 'pairing-pending';
}

/** Where a connection failed, when the listener could not say why itself. */
export type MobileTransportFailureCode =
  | 'unreachable'
  | 'handshake-rejected'
  | 'handshake-failed'
  | 'connection-lost'
  | 'timed-out'
  | 'protocol-error';

export type MobileConnectionErrorCode = MobileConnectionStatusCode | MobileTransportFailureCode;

/** A connection failure with a stable code the UI can act on and a message it can show. */
export class MobileConnectionError extends Error {
  constructor(
    readonly code: MobileConnectionErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'MobileConnectionError';
  }

  static fromStatus(status: MobileConnectionStatus): MobileConnectionError {
    return new MobileConnectionError(status.code, status.message, status.retryable);
  }
}

/**
 * Classifies a socket that failed without a status frame. `stage` is how far
 * the connection got: `connect` (no TCP connection), `handshake` (TCP open, the
 * Noise handshake never completed) or `session` (channel was open).
 */
export function classifyMobileTransportFailure(input: {
  stage: 'connect' | 'handshake' | 'session';
  endpoint: string;
  cause?: unknown;
  timedOut?: boolean;
}): MobileConnectionError {
  const detail = input.cause instanceof Error ? input.cause.message : input.cause === undefined ? undefined : String(input.cause);
  if (input.timedOut) {
    return input.stage === 'session'
      ? new MobileConnectionError('timed-out', 'The Praxis desktop stopped responding. Reconnecting…', true, detail)
      : new MobileConnectionError('timed-out', `No answer from the Praxis desktop at ${input.endpoint}. Check that the phone and desktop are on the same network and that Mobile access is on.`, true, detail);
  }
  if (input.stage === 'connect') {
    return new MobileConnectionError(
      'unreachable',
      `Couldn’t reach the Praxis desktop at ${input.endpoint}${detail ? ` (${detail})` : ''}. Check that Praxis is running with Mobile access on, and that the phone is on the same network.`,
      true,
      detail,
    );
  }
  if (input.stage === 'handshake') {
    return new MobileConnectionError(
      'handshake-rejected',
      'The desktop closed the secure handshake. Its host key may have been reset, or this phone pinned a different desktop — scan a current pairing invitation from Settings → Mobile access.',
      false,
      detail,
    );
  }
  return new MobileConnectionError('connection-lost', 'The connection to the Praxis desktop was lost. Reconnecting…', true, detail);
}
