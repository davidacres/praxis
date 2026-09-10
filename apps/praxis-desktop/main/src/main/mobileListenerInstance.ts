/**
 * Owns the mobile companion's desktop side: composes the `MobileHostApplication`,
 * registers the IPC bridge, and drives the LAN listener from the persisted
 * `MobileAccessSettings` on startup and on every settings change.
 *
 * The default mode is `off`, so a fresh profile binds nothing. When a policy
 * change narrows access — mode off, internet → local-only, or any lateral
 * allowlist change — established peers are severed and must re-authenticate.
 */
import type { MobileListener } from '@praxis/core';
import { getLogBus } from './logBusInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { registerMobileElectronIpc } from './mobileIpc';
import { composeDesktopMobileHost } from './mobileHostComposition';
import { getMobileHostIdentity } from './mobileHostIdentity';
import { MobileLanServer } from './mobileLanServer';
import { mobileAccessPolicyFromSettings, resolveMobileListenerChange } from './mobileAccessLifecycle';

let current: MobileListener | undefined;
let lanServer: MobileLanServer | undefined;

async function applyMobileAccessFromSettings(): Promise<void> {
  const settings = getSettingsBackend().read().mobileAccess;
  const change = resolveMobileListenerChange(current, settings);
  current = change.listener;

  if (change.bind || change.unbind || change.dropConnections) {
    getLogBus().appendLine(`[mobile] ${change.reason}`);
  }

  if (!lanServer) return;
  const policy = mobileAccessPolicyFromSettings(settings);
  try {
    if (change.unbind) {
      await lanServer.stop();
    } else if (change.bind && change.listener.port !== undefined) {
      await lanServer.start(change.listener.port, policy);
      if (change.dropConnections) lanServer.applyPolicy(policy, true);
    } else {
      lanServer.applyPolicy(policy, change.dropConnections);
    }
  } catch (error) {
    getLogBus().appendLine(`[mobile] listener change failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Called once during app startup, after the settings backend is ready. Safe to
 * call when mobile access is `off` — it composes the host and registers IPC but
 * binds no socket.
 */
export async function initMobileHost(): Promise<void> {
  const app = composeDesktopMobileHost();
  registerMobileElectronIpc(app);

  try {
    const identity = await getMobileHostIdentity();
    lanServer = new MobileLanServer({ app, hostStaticKey: identity, onLog: line => getLogBus().appendLine(line) });
  } catch (error) {
    getLogBus().appendLine(`[mobile] identity unavailable, LAN listener disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  await applyMobileAccessFromSettings();
  getSettingsBackend().onDidChange(() => {
    void applyMobileAccessFromSettings();
  });
}

export function currentMobileListener(): MobileListener | undefined {
  return current;
}

export function mobileLanConnectionCount(): number {
  return lanServer?.connectionCount() ?? 0;
}

export async function stopMobileHost(): Promise<void> {
  await lanServer?.stop();
  lanServer = undefined;
  current = undefined;
}
