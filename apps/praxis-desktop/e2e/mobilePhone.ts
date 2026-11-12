import { expect } from '@playwright/test';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { WebSocket } from 'ws';
import type { Page } from 'playwright';
import { MobileSecureClient, generateKeyPair } from '@praxis/mobile-protocol';
import type { TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

// Test-side phone helpers shared by the mobile transport specs: the two byte transports a phone can
// use (direct TCP on the LAN, or WebSocket messages through the relay), pairing, and event capture.

export type Connector = ConstructorParameters<typeof MobileSecureClient>[0]['connect'];
export type PhoneEvent = { sequence: number; event: { type: string; [key: string]: unknown } };
export type Phone = { client: MobileSecureClient; events: PhoneEvent[] };
export type RelayRoute = { url: string; channel: string };

export const lanConnector = (port: number): Connector => handlers => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
  socket.on('data', data => handlers.onData(typeof data === 'string' ? Buffer.from(data) : data));
  socket.on('error', error => handlers.onError(error));
  socket.on('close', () => handlers.onClose());
  return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
};

/** A phone reaching the desktop through the relay: every Noise record travels as one binary WebSocket message. */
export const relayConnector = (url: string, channel: string): Connector => handlers => {
  const socket = new WebSocket(`${url}/v1/connect?channel=${channel}`);
  socket.on('open', () => handlers.onConnect());
  socket.on('message', data => handlers.onData(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])));
  socket.on('error', error => handlers.onError(error));
  socket.on('close', () => handlers.onClose());
  return { write: bytes => socket.send(bytes), destroy: () => socket.close() };
};

export function newPhone(connect: Connector, endpoint: string, publicKeyHex: string, keys: ReturnType<typeof generateKeyPair>, pairingTokenId?: string): Phone {
  const client = new MobileSecureClient({
    endpoint, staticKeyPair: keys, remoteStaticPublicKey: Buffer.from(publicKeyHex, 'hex'),
    ...(pairingTokenId ? { pairingTokenId } : {}), connectTimeoutMs: 8000, requestTimeoutMs: 8000, legacyReadyAfterMs: 0, connect,
  });
  const phone: Phone = { client, events: [] };
  client.onEvent(envelope => phone.events.push(envelope as unknown as PhoneEvent));
  return phone;
}

export async function createProject(win: Page, userDataDir: string, key: string, name: string) {
  fs.mkdirSync(path.join(userDataDir, key), { recursive: true });
  return win.evaluate(async ({ folder, key, name }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create({
      name, key, type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: `${folder}/${key}`, storage: 'app', planningMode: 'files',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [], defaultAiToolMode: 'full',
    }, workspace.id);
  }, { folder: userDataDir, key, name });
}

/** Pairs a first-time phone (confirmed on the desktop with approvals allowed) and returns it connected. */
export async function pairPhone(app: TestApp, projectName: string, mode: 'local-only' | 'internet', connectFor: (info: { port: number; relay?: RelayRoute }) => Connector) {
  const win = app.window;
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-mobile').click();
  await chooseOption(win.getByTestId('mobile-access-mode'), mode);
  await expect(win.getByTestId('mobile-listener-status')).toContainText('Listening');
  const routeOf = async () => ((await win.evaluate(() => window.praxis.settings.getMobileHostInfo())).invitation as { relay?: RelayRoute } | undefined)?.relay;
  await win.getByTestId('mobile-create-pairing').click();
  if (mode === 'internet') await expect.poll(routeOf, { timeout: 15000 }).toBeTruthy();
  const pairing = await win.evaluate(() => window.praxis.settings.getMobileHostInfo());
  const invitation = pairing.invitation!;
  const relay = mode === 'internet' ? await routeOf() : undefined;
  const keys = generateKeyPair();
  const connect = connectFor({ port: pairing.listener.port!, relay });
  const endpoint = relay ? relay.url : `127.0.0.1:${pairing.listener.port}`;
  const phone = newPhone(connect, endpoint, invitation.publicKeyHex, keys, invitation.tokenId);
  const connecting = phone.client.connect();
  void connecting.catch(() => undefined);
  await expect(win.getByTestId('mobile-pending-device')).toBeVisible();
  await win.getByTestId('mobile-pending-device').getByLabel(projectName, { exact: true }).check();
  await win.getByTestId('mobile-pending-device').getByLabel('Allow approvals', { exact: true }).check();
  await win.getByTestId('mobile-confirm-device').click();
  await connecting;
  return { phone, pairing, invitation, keys, connect, endpoint, relay };
}

export const callerFor = { deviceId: 'forged-admin', subject: 'forged-admin', capabilities: ['view', 'execute', 'approve'] as const };
