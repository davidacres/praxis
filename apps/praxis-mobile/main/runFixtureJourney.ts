/**
 * A runnable walkthrough of the mobile companion against the in-process host
 * fixture: `npm run fixture --workspace=@praxis/mobile` (or `npm run
 * mobile:fixture` from the root). Prints each step of
 * pair -> connect -> read -> continue -> approve -> reconnect + replay.
 *
 * No Electron, no model, no network beyond loopback — this is the fastest way
 * to see the frozen protocol and the core host contracts working end to end.
 */
import {
  InMemoryMobilePairingStore,
  MOBILE_PROTOCOL_VERSION,
  consumeMobilePairing,
  createMobileCommand,
  type MobileCaller,
  type MobileReadRequest,
} from '@praxis/core';
import { generateKeyPair } from '@praxis/mobile-protocol';
import { FIXTURE_HOST_ID, FIXTURE_PROJECT_ID, createMobileHostFixture } from './mobileHostFixture';
import { LoopbackMobileClient, startLoopbackMobileHost } from './mobileLoopbackServer';

const caller: MobileCaller = { deviceId: 'phone-dave', subject: 'dave', capabilities: ['view', 'execute', 'approve'] };
const step = (n: number, text: string): void => console.log(`\n${n}. ${text}`);
const show = (label: string, value: unknown): void => console.log(`   ${label}: ${JSON.stringify(value)}`);

function read(operation: MobileReadRequest['operation'], target: MobileReadRequest['target']): MobileReadRequest {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: `r-${operation}-${Date.now()}`, caller, target, operation };
}

async function main(): Promise<void> {
  step(1, 'Pair the device with a single-use token and explicit confirmation');
  const store = new InMemoryMobilePairingStore([
    { tokenId: 'pair-token-1', hostId: FIXTURE_HOST_ID, expiresAt: '2999-01-01T00:00:00.000Z' },
  ]);
  const paired = consumeMobilePairing(
    store,
    { verify: () => true, confirmDevice: () => true },
    { tokenId: 'pair-token-1', hostId: FIXTURE_HOST_ID, deviceId: caller.deviceId, devicePublicKey: 'device-key', projectIds: [FIXTURE_PROJECT_ID], proof: 'signed', requestedAt: new Date().toISOString() },
    new Date().toISOString(),
  );
  show('paired', paired);

  step(2, 'Start the fixture host and connect over a Noise IK channel');
  const fixture = createMobileHostFixture();
  const hostKey = generateKeyPair();
  const host = await startLoopbackMobileHost(fixture.app, hostKey);
  const client = new LoopbackMobileClient('127.0.0.1', host.port, generateKeyPair(), host.staticPublicKey);
  await client.connect();
  show('host port', host.port);
  show('channel authenticated host key', Buffer.from(client.peerStaticPublicKey ?? []).toString('hex').slice(0, 16) + '…');

  step(3, 'Read the project snapshot and the work list');
  show('project', (await client.read(read('projects.snapshot', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }))).value);
  show('work', (await client.read(read('work.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }))).value);
  show('events on connect', client.takeEvents().map(envelope => envelope.event));

  step(4, 'Continue the session with a follow-up message');
  const cont = await client.command(
    createMobileCommand({
      commandId: 'cmd-continue-1',
      issuedAt: new Date().toISOString(),
      caller,
      target: { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, sessionId: 'sess-1' },
      operation: 'sessions.continue',
      payload: { message: 'Also update apps/praxis-mobile/docs/development.md.' },
    }),
  );
  show('reply', cont.value);
  show('events', client.takeEvents().map(envelope => envelope.event));

  step(5, 'Check the attention inbox, then approve the gate');
  show('attention before', (await client.read(read('attention.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }))).value);
  const approve = await client.command(
    createMobileCommand({
      commandId: 'cmd-approve-1',
      issuedAt: new Date().toISOString(),
      caller,
      target: { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, runId: 'run-1' },
      operation: 'workflowGates.approve',
      payload: {},
    }),
  );
  show('reply', approve.value);
  show('events', client.takeEvents().map(envelope => envelope.event));
  show('attention after', (await client.read(read('attention.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }))).value);

  step(6, 'Drop the connection and reconnect a fresh peer, replaying every event');
  client.disconnect();
  const rejoin = new LoopbackMobileClient('127.0.0.1', host.port, generateKeyPair(), host.staticPublicKey);
  await rejoin.connect();
  await rejoin.requestReplay(0);
  show('replayed events', rejoin.takeEvents().map(envelope => `${envelope.sequence}:${(envelope.event as { kind: string }).kind}`));
  rejoin.disconnect();

  await host.close();
  console.log('\nDone.');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
