import { app } from 'electron';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';
import { getSharedSettingsFilePath } from './settingsBackendInstance';

let bridgeInstance: RustHostBridge | undefined;

/**
 * Returns the process-wide [`RustHostBridge`] singleton configured with the current
 * Electron `userData` directory, shared/isolated settings path, `--demo` flag, and `PRAXIS_E2E`.
 *
 * The underlying `praxis-host` process is spawned lazily on the first migrated RPC call
 * or explicit `.start()`.
 */
export function getRustHostBridge(): RustHostBridge {
  if (!bridgeInstance) {
    const transport = new StdioRustHostTransport({
      userDataDir: app.getPath('userData'),
      settingsPath: getSharedSettingsFilePath(),
      demoMode: process.argv.includes('--demo'),
      e2eMode: process.env.PRAXIS_E2E === '1'
    });
    bridgeInstance = new RustHostBridge({ transport });
  }
  return bridgeInstance;
}

/** Disposes the active [`RustHostBridge`] child process on application shutdown. */
export async function disposeRustHost(): Promise<void> {
  const current = bridgeInstance;
  bridgeInstance = undefined;
  if (current) {
    await current.dispose();
  }
}
