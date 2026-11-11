import type { DesktopTransport } from './praxisBridge.generated';

type Listener = (...args: any[]) => void;
export type HostEvent = { channel: string; payload?: unknown };
export type TauriInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export type TauriListen = (event: string, listener: (event: { payload: HostEvent }) => void) => Promise<() => void>;

export class DesktopInvocationError extends Error {
  readonly channel: string;
  readonly code: string;
  constructor(channel: string, code: string, message: string) {
    super(message);
    this.channel = channel;
    this.code = code;
    this.name = 'DesktopInvocationError';
  }
}

/** One listener per webview, registered before any initial snapshot request. */
export async function createTauriTransport(
  invoke: TauriInvoke,
  listen: TauriListen,
  onListenerError: (error: unknown) => void = error => console.error('Desktop event listener failed:', error)
): Promise<DesktopTransport & { dispose(): void }> {
  const listeners = new Map<string, Set<Listener>>();
  let disposed = false;
  const unlisten = await listen('praxis:event', ({ payload: envelope }) => {
    if (disposed) return;
    // These two legacy subscriptions have positional event arguments. An array
    // payload on any other channel (e.g. session lists) remains one argument.
    const args = envelope.channel === 'runs:statusChanged' || envelope.channel === 'runs:log'
      ? Array.isArray(envelope.payload) ? envelope.payload : []
      : [envelope.payload];
    for (const listener of [...(listeners.get(envelope.channel) ?? [])]) {
      try { listener(undefined, ...args); } catch (error) { onListenerError(error); }
    }
  });
  const off = (channel: string, listener: Listener): void => {
    const entries = listeners.get(channel);
    entries?.delete(listener);
    if (!entries?.size) listeners.delete(channel);
  };
  return {
    async invoke(channel, ...args) {
      if (disposed) throw new DesktopInvocationError(channel, 'DESKTOP_CLOSED', 'Desktop bridge is closed.');
      try {
        return await invoke('praxis_rpc', { channel, args: args.map(arg => arg === undefined ? null : arg) });
      } catch (failure) {
        const error = failure as { code?: unknown; message?: unknown } | null;
        throw new DesktopInvocationError(channel,
          typeof error?.code === 'string' ? error.code : 'DESKTOP_ERROR',
          typeof error?.message === 'string' ? error.message : String(failure));
      }
    },
    on(channel, listener) {
      if (disposed) throw new Error('Desktop bridge is closed.');
      let entries = listeners.get(channel);
      if (!entries) { entries = new Set(); listeners.set(channel, entries); }
      entries.add(listener);
    },
    off,
    removeListener: off,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unlisten();
    }
  };
}
