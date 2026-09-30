/**
 * Owns the mobile companion's desktop side: composes the `MobileHostApplication`,
 * registers the IPC bridge, and drives the LAN listener from the persisted
 * `MobileAccessSettings` on startup and on every settings change.
 *
 * The default mode is `off`, so a fresh profile binds nothing. When a policy
 * change narrows access — mode off, internet → local-only, or any lateral
 * allowlist change — established peers are severed and must re-authenticate.
 */
import * as os from 'node:os';
import { fingerprintMobileHostKey, type MobileHostApplication, type MobileListener } from '@praxis/core';
import { getLogBus } from './logBusInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { registerMobileElectronIpc } from './mobileIpc';
import { composeDesktopMobileHost } from './mobileHostComposition';
import { getMobileHostId, getMobileHostIdentity, getMobileRelayIdentity } from './mobileHostIdentity';
import { MobileLanServer } from './mobileLanServer';
import { MobileRelayClient } from './mobileRelayClient';
import { mobileAccessPolicyFromSettings, resolveMobileListenerChange } from './mobileAccessLifecycle';
import {
  startMobileDiscoveryAdvertisement,
  stopMobileDiscoveryAdvertisement,
} from './mobileDiscoveryAdvertiser';
import {
  attachMobileLanServer,
  lanInterfaces,
  mobileAuthorizePeer,
  mobileOnUnpairedPeer,
  notifyMobilePairingChanged,
  setMobileBindError,
  setMobileRelayRoute,
} from './mobilePairingInstance';

let current: MobileListener | undefined;
let lanServer: MobileLanServer | undefined;
let hostApp: MobileHostApplication | undefined;
let relayClient: MobileRelayClient | undefined;
let relayClientUrl: string | undefined;

/** The relay to register with. An environment override for now; a Settings field is a follow-up. */
function configuredRelayUrl(): string | undefined {
  const url = process.env.PRAXIS_MOBILE_RELAY_URL?.trim();
  return url && /^wss?:\/\//i.test(url) ? url : undefined;
}

function stopRelay(): void {
  relayClient?.stop();
  relayClient = undefined;
  relayClientUrl = undefined;
  setMobileRelayRoute(undefined);
}

/**
 * Only `internet` mode holds a relay connection. Any other mode closes it, which
 * makes the relay drop every phone it was piping to this desktop; the LAN
 * listener's own policy change drops the rest.
 */
async function applyRelay(mode: string): Promise<void> {
  const url = mode === 'internet' ? configuredRelayUrl() : undefined;
  if (!url || !lanServer) {
    stopRelay();
    return;
  }
  if (relayClient && relayClientUrl === url) return;
  stopRelay();
  const identity = await getMobileRelayIdentity();
  const client: MobileRelayClient = new MobileRelayClient({
    relayUrl: url,
    identity,
    onStream: stream => lanServer?.acceptRelayedStream(stream),
    onLog: line => getLogBus().appendLine(line),
    onStateChange: () => {
      if (relayClient !== client) return;
      setMobileRelayRoute(client.state === 'registered' && client.channel ? { url, channel: client.channel } : undefined);
      notifyMobilePairingChanged();
    },
  });
  relayClient = client;
  relayClientUrl = url;
  client.start();
}

async function createLanServer(): Promise<void> {
  if (!hostApp) return;
  await lanServer?.stop();
  const identity = await getMobileHostIdentity();
  const pairingCode = process.env.PRAXIS_MOBILE_PAIRING_CODE?.trim();
  lanServer = new MobileLanServer({
    app: hostApp,
    hostStaticKey: identity,
    ...(pairingCode ? { pairingCode } : {}),
    authorizePeer: mobileAuthorizePeer,
    onUnpairedPeer: mobileOnUnpairedPeer,
    onLog: line => getLogBus().appendLine(line),
  });
  attachMobileLanServer(lanServer);
}

function configuredMobilePort(settingsPort: number | undefined): number | undefined {
  const envPort = process.env.PRAXIS_MOBILE_PORT ? Number(process.env.PRAXIS_MOBILE_PORT) : undefined;
  if (envPort && Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }
  return settingsPort;
}

async function applyMobileAccessFromSettings(): Promise<void> {
  const settings = getSettingsBackend().read().mobileAccess;
  const change = resolveMobileListenerChange(current, settings, configuredMobilePort(settings.listenPort));
  current = change.listener;

  if (change.bind || change.unbind || change.dropConnections) {
    getLogBus().appendLine(`[mobile] ${change.reason}`);
  }

  if (!lanServer) return;
  const policy = mobileAccessPolicyFromSettings(settings);
  try {
    setMobileBindError(undefined);
    if (change.unbind) {
      await lanServer.stop();
    } else if (change.bind && change.listener.port !== undefined) {
      await lanServer.start(change.listener.port, policy);
      if (change.dropConnections) lanServer.applyPolicy(policy, true);
    } else {
      lanServer.applyPolicy(policy, change.dropConnections);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMobileBindError(message);
    getLogBus().appendLine(`[mobile] listener change failed: ${message}`);
  }
  try {
    await applyRelay(settings.mode);
  } catch (error) {
    getLogBus().appendLine(`[mobile] relay setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await refreshDiscoveryAdvertisement();
  notifyMobilePairingChanged();
}

async function refreshDiscoveryAdvertisement(): Promise<void> {
  if (lanServer?.listening !== true) {
    stopMobileDiscoveryAdvertisement();
    return;
  }
  try {
    const settings = getSettingsBackend().read().mobileAccess;
    const [identity, hostId] = await Promise.all([getMobileHostIdentity(), getMobileHostId()]);
    const publicKeyHex = Buffer.from(identity.publicKey).toString('hex');
    startMobileDiscoveryAdvertisement({
      version: 1,
      hostId,
      displayName: settings.hostName.trim() || os.hostname() || 'Praxis desktop',
      fingerprint: fingerprintMobileHostKey(publicKeyHex),
      port: lanServer.port ?? configuredMobilePort(settings.listenPort) ?? 43100,
      addresses: lanInterfaces().map(item => item.address),
    });
  } catch (error) {
    stopMobileDiscoveryAdvertisement();
    getLogBus().appendLine(`[mobile] discovery advertisement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Called once during app startup, after the settings backend is ready. Safe to
 * call when mobile access is `off` — it composes the host and registers IPC but
 * binds no socket.
 */
export async function initMobileHost(): Promise<void> {
  hostApp = composeDesktopMobileHost(await getMobileHostId());
  registerMobileElectronIpc(hostApp);

  try {
    await createLanServer();
  } catch (error) {
    getLogBus().appendLine(`[mobile] identity unavailable, LAN listener disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  await applyMobileAccessFromSettings();
  getSettingsBackend().onDidChange(() => {
    void applyMobileAccessFromSettings();
  });
}

export async function restartMobileLanAfterKeyRotation(): Promise<void> {
  current = undefined;
  try {
    await createLanServer();
  } catch (error) {
    getLogBus().appendLine(`[mobile] host key rotation failed to rebind: ${error instanceof Error ? error.message : String(error)}`);
  }
  await applyMobileAccessFromSettings();
}

export function currentMobileListener(): MobileListener | undefined {
  return current;
}

export function mobileLanConnectionCount(): number {
  return lanServer?.connectionCount() ?? 0;
}

export async function stopMobileHost(): Promise<void> {
  stopMobileDiscoveryAdvertisement();
  await lanServer?.stop();
  lanServer = undefined;
  hostApp = undefined;
  current = undefined;
  attachMobileLanServer(undefined);
}
