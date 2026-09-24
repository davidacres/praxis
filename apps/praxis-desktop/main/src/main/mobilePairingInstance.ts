import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  fingerprintMobileHostKey,
  type MobileCapability,
  type MobileLanInterface,
  type MobilePairedDevice,
  type MobilePairingSnapshot,
} from '@praxis/core';
import { mobileConnectionStatus, type MobileConnectionStatus } from '@praxis/mobile-protocol';
import { MobilePairingRegistry } from './mobilePairingRegistry';
import { getMobileHostId, getMobileHostIdentity, rotateMobileHostIdentity } from './mobileHostIdentity';
import { getSettingsBackend } from './settingsBackendInstance';
import { DEFAULT_MOBILE_LISTENER_PORT } from './mobileAccessLifecycle';
import { getProjectStore } from './projectStoreInstance';
import { isMobileDiscoveryAdvertised } from './mobileDiscoveryAdvertiser';
import { MobileLanServer } from './mobileLanServer';

let registry: MobilePairingRegistry | undefined;
let lanServer: MobileLanServer | undefined;
let lastBindError: string | undefined;

function pairingFile(): string {
  return path.join(app.getPath('userData'), 'mobile-pairing.json');
}

function loadDevices(): MobilePairedDevice[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pairingFile(), 'utf8')) as { devices?: MobilePairedDevice[] };
    return Array.isArray(raw.devices) ? raw.devices : [];
  } catch {
    return [];
  }
}

function saveDevices(devices: MobilePairedDevice[]): void {
  fs.mkdirSync(path.dirname(pairingFile()), { recursive: true });
  fs.writeFileSync(pairingFile(), JSON.stringify({ devices }, null, 2), 'utf8');
}

export function getMobilePairingRegistry(): MobilePairingRegistry {
  if (!registry) {
    registry = new MobilePairingRegistry({
      load: () => ({ devices: loadDevices() }),
      save: state => saveDevices([...state.devices]),
    });
  }
  return registry;
}

export function attachMobileLanServer(server: MobileLanServer | undefined): void {
  lanServer = server;
}

export function setMobileBindError(message: string | undefined): void {
  lastBindError = message;
}

export function lanInterfaces(): MobileLanInterface[] {
  const found: MobileLanInterface[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push({ name, address: entry.address });
    }
  }
  return found;
}

function emitPairingChanged(): void {
  void snapshotMobilePairing().then(snapshot => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('mobile:pairingChanged', snapshot);
    }
  });
}

export function notifyMobilePairingChanged(): void {
  emitPairingChanged();
}

export function mobileAuthorizePeer(publicKeyHex: string) {
  const device = getMobilePairingRegistry().authorize(publicKeyHex);
  if (!device) return undefined;
  getMobilePairingRegistry().touch(publicKeyHex);
  return {
    deviceId: device.deviceId,
    capabilities: device.capabilities ?? (['view'] as const),
    ...(device.projectIds ? { projectIds: device.projectIds } : {}),
  };
}

/**
 * The listener's answer to an unknown phone key. At handshake (`tokenId`
 * undefined) the phone is asked for its invitation — or told it was revoked;
 * with a token, the registry decides whether it becomes a confirmation request.
 */
export function mobileOnUnpairedPeer(publicKeyHex: string, tokenId?: string): MobileConnectionStatus {
  const settings = getSettingsBackend().read().mobileAccess;
  if (settings.mode === 'off') return mobileConnectionStatus('access-disabled');
  const registry = getMobilePairingRegistry();
  if (tokenId === undefined) {
    return registry.wasRevoked(publicKeyHex) && !registry.hasActiveInvitation()
      ? mobileConnectionStatus('device-revoked')
      : mobileConnectionStatus('pairing-required');
  }
  const result = registry.submitUnpaired(publicKeyHex, tokenId);
  if (!result.ok) {
    switch (result.reason) {
      case 'expired':
        return mobileConnectionStatus('invitation-expired');
      case 'used':
        return mobileConnectionStatus('invitation-used');
      case 'no-invitation':
        return mobileConnectionStatus('invitation-expired', 'The desktop is not offering a pairing invitation right now. Create one in Settings → Mobile access and scan it again.');
      default:
        return mobileConnectionStatus('invitation-invalid');
    }
  }
  emitPairingChanged();
  return mobileConnectionStatus('pairing-pending', `Waiting for confirmation on ${settings.hostName.trim() || os.hostname() || 'the desktop'}. Open Settings → Mobile access and confirm “${result.request.deviceLabel}”.`);
}

export async function snapshotMobilePairing(): Promise<MobilePairingSnapshot> {
  const settings = getSettingsBackend().read().mobileAccess;
  const [identity, hostId] = await Promise.all([getMobileHostIdentity(), getMobileHostId()]);
  const publicKeyHex = Buffer.from(identity.publicKey).toString('hex');
  const hostName = settings.hostName.trim() || os.hostname() || 'Praxis desktop';
  const interfaces = lanInterfaces();
  const addresses = interfaces.map(item => item.address);
  const envPort = process.env.PRAXIS_MOBILE_PORT ? Number(process.env.PRAXIS_MOBILE_PORT) : undefined;
  const configuredPort = envPort && Number.isFinite(envPort) && envPort > 0 ? envPort : settings.listenPort;
  const port = lanServer?.port ?? configuredPort ?? DEFAULT_MOBILE_LISTENER_PORT;
  const endpoints = (addresses.length ? addresses : ['127.0.0.1']).map(address => ({ address, port }));
  const invitation = getMobilePairingRegistry().activeInvitation(new Date().toISOString(), {
    displayName: hostName,
    publicKeyHex,
    endpoints,
  });
  const listening = lanServer?.listening === true;
  return {
    hostId,
    hostName,
    publicKeyHex,
    fingerprint: fingerprintMobileHostKey(publicKeyHex),
    ...(invitation ? { invitation } : {}),
    pending: getMobilePairingRegistry().listPending(),
    devices: getMobilePairingRegistry().listDevices(),
    listener: {
      listening,
      mode: settings.mode,
      ...(listening || settings.mode !== 'off' ? { port } : {}),
      addresses,
      interfaces,
      connectionCount: lanServer?.connectionCount() ?? 0,
      lastError: lanServer?.bindError ?? lastBindError,
      discovery: {
        advertised: isMobileDiscoveryAdvertised(),
        hostId,
        displayName: hostName,
        fingerprint: fingerprintMobileHostKey(publicKeyHex),
      },
    },
    projects: getProjectStore().list().map(project => ({ id: project.id, name: project.name })),
  };
}

export async function createMobilePairingInvitation(): Promise<MobilePairingSnapshot> {
  const snapshot = await snapshotMobilePairing();
  const addresses = snapshot.listener.addresses.length ? snapshot.listener.addresses : ['127.0.0.1'];
  // A new invitation voids the old one and every request waiting on it.
  for (const waiting of getMobilePairingRegistry().listPending()) {
    lanServer?.dropPublicKey(waiting.devicePublicKey, mobileConnectionStatus('invitation-expired', 'The desktop created a new pairing invitation, which replaced the one this phone used. Scan the new invitation.'));
  }
  getMobilePairingRegistry().issueInvitation(snapshot.hostId, {
    displayName: snapshot.hostName,
    publicKeyHex: snapshot.publicKeyHex,
    endpoints: addresses.map(address => ({
      address,
      port: snapshot.listener.port ?? DEFAULT_MOBILE_LISTENER_PORT,
    })),
  });
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function confirmMobilePairing(
  requestId: string,
  grant: { label?: string; capabilities: readonly MobileCapability[]; projectIds: readonly string[] },
): Promise<MobilePairingSnapshot> {
  const result = getMobilePairingRegistry().confirm(requestId, grant);
  if (result.ok) {
    for (const other of getMobilePairingRegistry().takeSuperseded()) {
      lanServer?.dropPublicKey(other.devicePublicKey, mobileConnectionStatus('invitation-used'));
    }
    lanServer?.promotePending(result.device.publicKeyHex ?? '', {
      deviceId: result.device.deviceId,
      capabilities: result.device.capabilities ?? ['view'],
      ...(result.device.projectIds ? { projectIds: result.device.projectIds } : {}),
    });
  }
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function denyMobilePairing(requestId: string): Promise<MobilePairingSnapshot> {
  const pending = getMobilePairingRegistry().listPending().find(item => item.requestId === requestId);
  getMobilePairingRegistry().deny(requestId);
  if (pending) lanServer?.dropPublicKey(pending.devicePublicKey, mobileConnectionStatus('pairing-rejected'));
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function revokeMobilePairedDevice(deviceId: string): Promise<MobilePairingSnapshot> {
  getMobilePairingRegistry().revoke(deviceId);
  lanServer?.dropDevice(deviceId, mobileConnectionStatus('device-revoked'));
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function rotateMobileHostKey(): Promise<MobilePairingSnapshot> {
  getMobilePairingRegistry().revokeAll();
  lanServer?.dropAll(mobileConnectionStatus('host-key-reset'));
  await rotateMobileHostIdentity();
  emitPairingChanged();
  return snapshotMobilePairing();
}

export function resetMobilePairingRegistry(): void {
  registry = undefined;
}
