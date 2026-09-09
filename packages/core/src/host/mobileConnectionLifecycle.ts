export type MobileConnectionState = 'disconnected' | 'connecting' | 'authenticated' | 'ready' | 'closing';

export type MobileConnectionEvent = 'connect' | 'authenticate' | 'ready' | 'disconnect' | 'close';

export interface MobileConnection {
  connectionId: string;
  deviceId: string;
  state: MobileConnectionState;
  changedAt: string;
}

export type MobileConnectionTransition =
  | { ok: true; connection: MobileConnection }
  | { ok: false; reason: 'invalid-transition' };

const NEXT: Record<MobileConnectionState, Partial<Record<MobileConnectionEvent, MobileConnectionState>>> = {
  disconnected: { connect: 'connecting' },
  connecting: { authenticate: 'authenticated', disconnect: 'disconnected' },
  authenticated: { ready: 'ready', disconnect: 'disconnected' },
  ready: { disconnect: 'disconnected', close: 'closing' },
  closing: { close: 'disconnected', disconnect: 'disconnected' },
};

export function transitionMobileConnection(
  connection: MobileConnection,
  event: MobileConnectionEvent,
  changedAt: string,
): MobileConnectionTransition {
  const state = NEXT[connection.state][event];
  if (!state) return { ok: false, reason: 'invalid-transition' };
  return { ok: true, connection: { ...connection, state, changedAt } };
}

export function canExecuteOnMobileConnection(connection: MobileConnection): boolean {
  return connection.state === 'ready';
}
