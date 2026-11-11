import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createPraxisBridge } from './praxisBridge.generated';
import { createTauriTransport } from './tauriTransport';

export async function installTauriBridge(): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).praxis) {
    return;
  }
  const transport = await createTauriTransport(invoke, listen);
  Object.defineProperty(window, 'praxis', { value: createPraxisBridge(transport), configurable: false, writable: false });
  window.addEventListener('beforeunload', () => transport.dispose(), { once: true });
}
