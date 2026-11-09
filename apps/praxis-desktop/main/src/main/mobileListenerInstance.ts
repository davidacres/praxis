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
import { app } from 'electron';
import { selectMobileTransport, type MobileListenerTransport, type MobileRelayTransport } from './mobileTransport';
import { RustMobileTransport } from './rustMobileTransport';
import { fingerprintMobileHostKey, type MobileHostApplication, type MobileListener } from '@praxis/core';
import { getLogBus } from './logBusInstance';
import { getSettingsBackend, getSharedSettingsFilePath } from './settingsBackendInstance';
import { registerMobileElectronIpc } from './mobileIpc';
import { composeDesktopMobileHost } from './mobileHostComposition';
import { getMobileHostId, getMobileHostIdentity, getMobileRelayIdentity } from './mobileHostIdentity';
import { MobileLanServer } from './mobileLanServer';
import { MobileRelayClient, isAllowedRelayUrl } from './mobileRelayClient';
import { mobileAccessPolicyFromSettings, resolveMobileListenerChange } from './mobileAccessLifecycle';
import {
  startMobileDiscoveryAdvertisement,
  stopMobileDiscoveryAdvertisement,
} from './mobileDiscoveryAdvertiser';
import {
  attachMobileLanServer,
  mobileAuthorizePeer,
  mobileOnUnpairedPeer,
  notifyMobilePairingChanged,
  setMobileBindError,
  setMobileRelayRoute,
} from './mobilePairingInstance';

let current: MobileListener | undefined;
let lanServer: MobileListenerTransport | undefined;
let hostApp: MobileHostApplication | undefined;
let relayClient: MobileRelayTransport | undefined;
let relayClientUrl: string | undefined;
let settingsSubscription: { dispose(): void } | undefined;

/** The relay to register with. An environment override for now; a Settings field is a follow-up. */
function configuredRelayUrl(): string | undefined {
  const url = process.env.PRAXIS_MOBILE_RELAY_URL?.trim();
  return url && isAllowedRelayUrl(url) ? url : undefined;
}

async function stopRelay(): Promise<void> {
  const client = relayClient;
  relayClient = undefined;
  relayClientUrl = undefined;
  setMobileRelayRoute(undefined);
  await client?.stop();
}

/**
 * Only `internet` mode holds a relay connection. Any other mode closes it, which
 * makes the relay drop every phone it was piping to this desktop; the LAN
 * listener's own policy change drops the rest.
 */
async function applyRelay(mode: string): Promise<void> {
  const url = mode === 'internet' ? configuredRelayUrl() : undefined;
  if (!url || !lanServer) {
    await stopRelay();
    return;
  }
  if (relayClient && relayClientUrl === url) return;
  await stopRelay();
  const identity = await getMobileRelayIdentity();
  const options = {
    relayUrl: url,
    identity,
    onLog: (line: string) => getLogBus().appendLine(line),
    onStateChange: () => {
      if (relayClient !== client) return;
      setMobileRelayRoute(client.state === 'registered' && client.channel ? { url, channel: client.channel } : undefined);
      notifyMobilePairingChanged();
    },
  };
  const client: MobileRelayTransport = lanServer instanceof RustMobileTransport
    ? lanServer.createRelay(options)
    : new MobileRelayClient({ ...options, onStream: stream => {
      if (lanServer instanceof MobileLanServer) lanServer.acceptRelayedStream(stream);
    } });
  relayClient = client;
  relayClientUrl = url;
  try {
    await client.start();
  } catch (error) {
    await stopRelay();
    throw error;
  }
}

async function createLanServer(): Promise<void> {
  if (!hostApp) return;
  await stopRelay();
  await lanServer?.stop();
  await lanServer?.dispose?.();
  const identity = await getMobileHostIdentity();
  const pairingCode = process.env.PRAXIS_MOBILE_PAIRING_CODE?.trim();
  const deps = {
    app: hostApp,
    hostStaticKey: identity,
    ...(pairingCode ? { pairingCode } : {}),
    authorizePeer: mobileAuthorizePeer,
    onUnpairedPeer: mobileOnUnpairedPeer,
    onLog: (line: string) => getLogBus().appendLine(line),
  };
  const runtime = selectMobileTransport(app.isPackaged);
  lanServer = runtime === 'rust' ? new RustMobileTransport(deps, {
    host: { userDataDir: app.getPath('userData'), settingsPath: getSharedSettingsFilePath(),
      demoMode: process.argv.includes('--demo'), e2eMode: process.env.PRAXIS_E2E === '1' },
  }) : new MobileLanServer(deps);
  getLogBus().appendLine(`[mobile] Selected ${runtime} transport.`);
  attachMobileLanServer(lanServer);
}

function configuredMobilePort(settingsPort: number | undefined): number | undefined {
  const envPort = process.env.PRAXIS_MOBILE_PORT ? Number(process.env.PRAXIS_MOBILE_PORT) : undefined;
  if (envPort && Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }
  return settingsPort;
}

let accessChange: Promise<void> = Promise.resolve();
function queueMobileAccess(operation: () => Promise<void>): Promise<void> {
  const next = accessChange.then(operation);
  accessChange = next.catch(error => getLogBus().appendLine(`[mobile] access update failed: ${String(error)}`));
  return next;
}

function applyMobileAccessFromSettings(): Promise<void> {
  return queueMobileAccess(applyMobileAccess);
}

async function applyMobileAccess(): Promise<void> {
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
    } else if (change.listener.bound && change.listener.port !== undefined) {
      await lanServer.start(change.listener.port, policy);
      if (change.dropConnections) await lanServer.applyPolicy(policy, true);
    } else {
      await lanServer.applyPolicy(policy, change.dropConnections);
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
      addresses: lanServer.addresses.filter(address => address !== '127.0.0.1' && address !== '::1'),
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
  settingsSubscription = getSettingsBackend().onDidChange(() => {
    void applyMobileAccessFromSettings().catch(() => undefined);
  });
}

export async function restartMobileLanAfterKeyRotation(): Promise<void> {
  await queueMobileAccess(async () => {
    current = undefined;
    try {
      await createLanServer();
    } catch (error) {
      getLogBus().appendLine(`[mobile] host key rotation failed to rebind: ${error instanceof Error ? error.message : String(error)}`);
    }
    await applyMobileAccess();
  });
}

export function currentMobileListener(): MobileListener | undefined {
  return current;
}

export function mobileLanConnectionCount(): number {
  return lanServer?.connectionCount() ?? 0;
}

/** Internal integration evidence, intentionally absent from renderer IPC. */
export function mobileTransportDiagnostics() {
  return lanServer instanceof RustMobileTransport ? lanServer.diagnostics()
    : { mode: 'typescript' as const, listening: lanServer?.listening ?? false };
}

export async function stopMobileHost(): Promise<void> {
  settingsSubscription?.dispose();
  settingsSubscription = undefined;
  stopMobileDiscoveryAdvertisement();
  await accessChange;
  try {
    await stopRelay();
    await lanServer?.stop();
  } finally {
    const server = lanServer;
    lanServer = undefined;
    hostApp = undefined;
    current = undefined;
    attachMobileLanServer(undefined);
    await server?.dispose?.();
  }
}
