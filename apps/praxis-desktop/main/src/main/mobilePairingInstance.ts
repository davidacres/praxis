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

export function mobileOnUnpairedPeer(publicKeyHex: string): 'pending' | 'refuse' {
  const settings = getSettingsBackend().read().mobileAccess;
  if (settings.mode === 'off') return 'refuse';
  const pending = getMobilePairingRegistry().submitUnpaired(publicKeyHex);
  if (!pending) return 'refuse';
  emitPairingChanged();
  return 'pending';
}

export async function snapshotMobilePairing(): Promise<MobilePairingSnapshot> {
  const settings = getSettingsBackend().read().mobileAccess;
  const [identity, hostId] = await Promise.all([getMobileHostIdentity(), getMobileHostId()]);
  const publicKeyHex = Buffer.from(identity.publicKey).toString('hex');
  const hostName = settings.hostName.trim() || os.hostname() || 'Praxis desktop';
  const interfaces = lanInterfaces();
  const addresses = interfaces.map(item => item.address);
  const port = lanServer?.port ?? settings.listenPort ?? DEFAULT_MOBILE_LISTENER_PORT;
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
  if (pending) lanServer?.dropPublicKey(pending.devicePublicKey);
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function revokeMobilePairedDevice(deviceId: string): Promise<MobilePairingSnapshot> {
  getMobilePairingRegistry().revoke(deviceId);
  lanServer?.dropDevice(deviceId);
  emitPairingChanged();
  return snapshotMobilePairing();
}

export async function rotateMobileHostKey(): Promise<MobilePairingSnapshot> {
  getMobilePairingRegistry().revokeAll();
  lanServer?.dropAll();
  await rotateMobileHostIdentity();
  emitPairingChanged();
  return snapshotMobilePairing();
}

export function resetMobilePairingRegistry(): void {
  registry = undefined;
}
