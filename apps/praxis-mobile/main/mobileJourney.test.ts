import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMobilePairingStore,
  MOBILE_PROTOCOL_VERSION,
  consumeMobilePairing,
  createMobileCommand,
  type MobileCaller,
  type MobileCommandOperation,
  type MobilePairingRequest,
  type MobilePairingToken,
  type MobilePairingVerifier,
  type MobileReadRequest,
  type MobileTarget,
} from '@praxis/core';
import { FIXTURE_HOST_ID, FIXTURE_PROJECT_ID, createMobileHostFixture } from './mobileHostFixture';
import { LoopbackMobileClient, startLoopbackMobileHost } from './mobileLoopbackServer';

const AT = '2026-09-10T09:00:00.000Z';

const caller: MobileCaller = {
  deviceId: 'phone-dave',
  subject: 'dave',
  capabilities: ['view', 'execute', 'approve'],
};

function read(operation: MobileReadRequest['operation'], target: MobileReadRequest['target']): MobileReadRequest {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: `r-${operation}-${Date.now()}`, caller, target, operation };
}

let commandSeq = 0;
function command(operation: MobileCommandOperation, target: MobileTarget, payload: unknown) {
  commandSeq += 1;
  return createMobileCommand({
    commandId: `cmd-00${commandSeq}-journey`,
    issuedAt: new Date().toISOString(),
    caller,
    target,
    operation,
    payload,
  });
}

test('pair -> connect -> continue -> approve -> reconnect + replay over the loopback host', async () => {
  // 1. Pairing: a single-use token is consumed with explicit device confirmation.
  const token: MobilePairingToken = {
    tokenId: 'pair-token-1',
    hostId: FIXTURE_HOST_ID,
    expiresAt: '2026-09-10T10:00:00.000Z',
  };
  const store = new InMemoryMobilePairingStore([token]);
  const verifier: MobilePairingVerifier = { verify: () => true, confirmDevice: () => true };
  const pairingRequest: MobilePairingRequest = {
    tokenId: token.tokenId,
    hostId: FIXTURE_HOST_ID,
    deviceId: caller.deviceId,
    devicePublicKey: 'device-key',
    projectIds: [FIXTURE_PROJECT_ID],
    proof: 'signed',
    requestedAt: AT,
  };
  const paired = consumeMobilePairing(store, verifier, pairingRequest, AT);
  assert.equal(paired.ok, true);
  // The token cannot be replayed.
  assert.equal(consumeMobilePairing(store, verifier, pairingRequest, AT).ok, false);

  // 2. Stand up the host and connect.
  const fixture = createMobileHostFixture(() => AT);
  const host = await startLoopbackMobileHost(fixture.app);
  const client = new LoopbackMobileClient('127.0.0.1', host.port);
  await client.connect();

  try {
    // 3. Read the project and its work.
    const project = await client.read<{ projectId: string; workflow: string }>(read('projects.snapshot', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }));
    assert.equal(project.ok, true);
    assert.equal(project.value?.projectId, FIXTURE_PROJECT_ID);

    const work = await client.read<Array<{ workId: string; sessionId: string }>>(read('work.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }));
    assert.equal(work.value?.[0]?.workId, 'FIX-1');

    // The connect handshake already replayed the seeded awaiting-approval event.
    const onConnect = client.takeEvents();
    assert.equal(onConnect.at(-1)?.event && (onConnect.at(-1)!.event as { kind: string }).kind, 'run.awaitingApproval');

    // 4. Continue the session with a follow-up; the host pushes its events.
    const cont = await client.command<{ accepted: boolean }>(
      command('sessions.continue', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, sessionId: 'sess-1' }, { message: 'Also update apps/praxis-mobile/docs/development.md.' }),
    );
    assert.equal(cont.ok, true);
    assert.equal(cont.value?.accepted, true);
    const contEvents = client.takeEvents().map(envelope => (envelope.event as { kind: string }).kind);
    assert.deepEqual(contEvents, ['session.message', 'session.idle']);
    assert.equal(fixture.state.session.transcript.at(-1), 'Also update apps/praxis-mobile/docs/development.md.');

    // 5. The attention inbox shows the pending approval.
    const before = await client.read<Array<{ id: string }>>(read('attention.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }));
    assert.deepEqual(before.value?.map(item => item.id), ['att-1']);

    // 6. Approve the gate.
    const approve = await client.command<{ gate: string; status: string }>(
      command('workflowGates.approve', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, runId: 'run-1' }, {}),
    );
    assert.equal(approve.value?.gate, 'passed');
    assert.equal(approve.value?.status, 'approved');
    assert.equal(client.takeEvents().map(envelope => (envelope.event as { kind: string }).kind).includes('gate.approved'), true);

    // 7. Attention clears.
    const after = await client.read<unknown[]>(read('attention.list', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID }));
    assert.deepEqual(after.value, []);

    // 8. A duplicate command id with the same payload replays its recorded outcome.
    const replayCmd = command('workflowGates.approve', { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, runId: 'run-1' }, {});
    const first = await client.command<{ status: string }>(replayCmd);
    const again = await client.command<{ status: string }>(replayCmd);
    assert.deepEqual(again.value, first.value);
  } finally {
    client.disconnect();
  }

  // 9. Reconnect a fresh peer and replay every event from the start.
  const rejoin = new LoopbackMobileClient('127.0.0.1', host.port);
  await rejoin.connect();
  try {
    await rejoin.requestReplay(0);
    const replayed = rejoin.takeEvents().map(envelope => (envelope.event as { kind: string }).kind);
    assert.equal(replayed.includes('run.awaitingApproval'), true);
    assert.equal(replayed.includes('gate.approved'), true);
    assert.equal(replayed.length, fixture.emitted().length);
  } finally {
    rejoin.disconnect();
    await host.close();
  }
});
