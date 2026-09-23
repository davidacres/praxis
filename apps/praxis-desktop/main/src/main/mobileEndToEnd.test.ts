/**
 * Phone ↔ desktop over the real wire: the production LAN listener, host
 * services, session projection and event log, driven by the same
 * `MobileSecureClient` + `mergeSequencedSnapshot` the iOS app uses. Only the
 * AI launch itself is faked — it records exactly what the desktop was asked
 * to start, which is the boundary these tests are about.
 */
import assert from 'node:assert/strict';
import * as net from 'node:net';
import test from 'node:test';
import {
  InMemoryMobileCommandLedger,
  MOBILE_PROTOCOL_VERSION,
  type AgentSessionRecord,
  type MobileCaller,
  type MobileCommandOperation,
  type MobileHostApplication,
  type MobileHostInfo,
  type MobileModelCatalog,
  type MobileProviderCatalog,
  type MobileReadRequest,
  type MobileSessionEvent,
  type MobileSessionSnapshot,
  type MobileSessionSummary,
} from '@praxis/core';
import {
  MobileRequestError,
  MobileSecureClient,
  generateKeyPair,
  mergeSequencedSnapshot,
  type KeyPair,
} from '@praxis/mobile-protocol';
import { MobileLanServer } from './mobileLanServer';
import { createMobileHostExecutionHandlers, createMobileHostReads, type MobileHostServiceDeps } from './mobileHostServices';
import { appendMobileAppearanceEvent, appendMobileSessionEvent, mobileSessionSnapshot, mobileSessionSummary } from './mobileSessionProjection';

const HOST = 'host-mac';
const PROJECT = 'p1';
const caller: MobileCaller = { deviceId: 'claimed-by-phone', capabilities: ['view', 'execute', 'approve'] };

const catalog: MobileProviderCatalog = {
  defaultProvider: 'openai',
  providers: [
    { provider: 'openai', label: 'OpenAI', kind: 'api', available: false, unavailableReason: 'not-configured', unavailableMessage: 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.' },
    { provider: 'anthropic', label: 'Anthropic', kind: 'api', available: true, defaultModel: 'claude-sonnet-4-6' },
    { provider: 'codex-cli', label: 'Codex CLI (local)', kind: 'cli-agent', available: true },
  ],
  sessionModes: [
    { mode: 'chat', available: true, toolAccess: 'full' },
    { mode: 'analysis', available: true, toolAccess: 'read-only' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
  ],
};

const models: Record<string, MobileModelCatalog> = {
  anthropic: { provider: 'anthropic', status: 'ok', defaultModel: 'claude-sonnet-4-6', models: [{ modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' }] },
  'codex-cli': { provider: 'codex-cli', status: 'ok', models: [{ modelId: 'gpt-5.5', name: 'GPT-5.5' }] },
};

/** A desktop whose "AI" is a recorder: launches are logged, streaming is driven by the test. */
function fakeDesktop() {
  const ledger = new InMemoryMobileCommandLedger();
  const sessions = new Map<string, AgentSessionRecord>();
  const launches: Array<{ provider: string; model?: string; mode: string; message: string }> = [];
  const changes: unknown[] = [];
  const emit = (record: AgentSessionRecord): void => { appendMobileSessionEvent(ledger, HOST, record); };
  const update = (sessionId: string, change: (record: AgentSessionRecord) => AgentSessionRecord): void => {
    const next = change(sessions.get(sessionId)!);
    sessions.set(sessionId, next);
    emit(next);
  };
  const deps: MobileHostServiceDeps = {
    hostId: HOST,
    hostName: () => 'Dave Mac',
    hostOnline: () => true,
    hostEpoch: 'epoch-a',
    latestSequence: () => ledger.latestSequence(),
    providerCatalog: async () => catalog,
    modelCatalog: async provider => models[provider] ?? { provider, status: 'unavailable', models: [] },
    describeDevice: async () => ({ projects: [{ projectId: PROJECT, name: 'Praxis' }], hostName: 'Dave Mac', accessMode: 'local-only' }),
    listProjects: async () => [{ projectId: PROJECT, name: 'Praxis' }],
    getProject: async projectId => projectId === PROJECT ? { projectId, name: 'Praxis' } : undefined,
    listWork: async () => [],
    listSessions: async projectId => [...sessions.values()].filter(record => record.projectId === projectId).map(mobileSessionSummary),
    getSession: async sessionId => {
      const record = sessions.get(sessionId);
      return record ? mobileSessionSnapshot(record, ledger.latestSequence()) : undefined;
    },
    listWorkflows: async () => [],
    getRun: async () => undefined,
    listRunChanges: async () => ({}),
    listAttention: async () => [],
    createSession: async input => {
      launches.push({ provider: input.provider, ...(input.model ? { model: input.model } : {}), mode: input.mode, message: input.message });
      const sessionId = `s${sessions.size + 1}`;
      const record: AgentSessionRecord = {
        issueKey: `SESSION-${sessionId}`,
        sessionId,
        projectId: input.projectId,
        title: input.title,
        provider: input.provider as AgentSessionRecord['provider'],
        ...(input.model ? { model: input.model } : {}),
        mode: input.mode,
        state: 'executing',
        taskDefinition: { goal: input.message, scope: 'project', definitionOfDone: 'answer' },
        stepCount: 0,
        startedAt: '2026-09-23T09:00:00.000Z',
        events: [],
      };
      sessions.set(sessionId, record);
      emit(record);
      return mobileSessionSnapshot(record, ledger.latestSequence());
    },
    startRun: async () => ({ runId: 'r1' }),
    cancelRun: async () => ({}),
    retryStage: async () => ({}),
    approveRun: async () => ({}),
    continueSession: async (sessionId, message) => {
      update(sessionId, record => ({
        ...record,
        state: 'executing',
        events: [...record.events, { timestamp: '2026-09-23T09:05:00.000Z', type: 'user_input_completed', summary: message }],
      }));
      return mobileSessionSnapshot(sessions.get(sessionId)!, ledger.latestSequence());
    },
    configureSession: async (sessionId, change) => {
      changes.push(change);
      update(sessionId, record => ({
        ...record,
        ...(change.mode ? { mode: change.mode } : {}),
        ...(change.model ? { model: change.model } : {}),
        ...(change.handover ? { provider: change.handover.provider as AgentSessionRecord['provider'], model: change.handover.model, state: 'executing' as const } : {}),
      }));
      return mobileSessionSnapshot(sessions.get(sessionId)!, ledger.latestSequence());
    },
    cancelSession: async sessionId => mobileSessionSnapshot(sessions.get(sessionId)!, ledger.latestSequence()),
    respondToPermission: async () => ({}),
  };
  const commands = createMobileHostExecutionHandlers(deps);
  const app: MobileHostApplication = {
    reads: createMobileHostReads(deps, Object.keys(commands) as MobileCommandOperation[]),
    commands,
    ledger,
    payloadDigest: command => JSON.stringify(command.payload ?? null),
  };
  return { app, ledger, sessions, launches, changes, update };
}

function nodeClient(port: number, hostKey: KeyPair, phoneKey: KeyPair): MobileSecureClient {
  return new MobileSecureClient({
    connect: handlers => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
      socket.on('data', (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
      socket.on('error', error => handlers.onError(error));
      socket.on('close', () => handlers.onClose());
      return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
    },
    endpoint: `127.0.0.1:${port}`,
    staticKeyPair: phoneKey,
    remoteStaticPublicKey: hostKey.publicKey,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
  });
}

let requestSequence = 0;
function read(operation: MobileReadRequest['operation'], target: Omit<MobileReadRequest['target'], 'hostId'> = {}, params?: MobileReadRequest['params']): MobileReadRequest {
  requestSequence += 1;
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: `read-${requestSequence}`, caller, target: { hostId: HOST, projectId: PROJECT, ...target }, operation, ...(params ? { params } : {}) };
}

let commandSequence = 0;
function command(operation: MobileCommandOperation, target: Record<string, string>, payload: unknown) {
  commandSequence += 1;
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, commandId: `cmd-e2e-${commandSequence}-${Date.now()}`, issuedAt: new Date().toISOString(), caller, target: { hostId: HOST, projectId: PROJECT, ...target }, operation, payload };
}

/** What the phone store does on (re)connect: pin the cursor, re-read, then replay after it. */
async function phoneMirror(client: MobileSecureClient) {
  let sessions: Readonly<Record<string, MobileSessionSnapshot>> = {};
  let received = 0;
  client.onEvent(envelope => {
    received += 1;
    const event = (envelope as unknown as { event: MobileSessionEvent }).event;
    if (event.type === 'session.snapshot') sessions = mergeSequencedSnapshot(sessions, event.snapshot);
  });
  await client.connect();
  const info = await client.read<MobileHostInfo>(read('host.info'));
  const summaries = await client.read<MobileSessionSummary[]>(read('sessions.list'));
  for (const summary of summaries) {
    sessions = mergeSequencedSnapshot(sessions, await client.read<MobileSessionSnapshot>(read('sessions.get', { sessionId: summary.sessionId })));
  }
  await client.replay(info.latestSequence);
  return { get sessions() { return sessions; }, get received() { return received; }, info };
}

const settle = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('the phone lists providers and models, and the desktop launches exactly the selected pair', async () => {
  const desktop = fakeDesktop();
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const server = new MobileLanServer({
    app: desktop.app,
    hostStaticKey: hostKey,
    authorizePeer: () => ({ deviceId: 'paired-phone', capabilities: ['view', 'execute', 'approve'], projectIds: [PROJECT] }),
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  const phone = nodeClient(server.port!, hostKey, phoneKey);
  try {
    const mirror = await phoneMirror(phone);
    assert.equal(mirror.info.surfaceRevision, 4);

    // (1) the real provider list reaches the phone — availability, labels, no secrets
    const providers = await phone.read<MobileProviderCatalog>(read('providers.list'));
    assert.deepEqual(providers.providers.map(option => [option.provider, option.available]), [['openai', false], ['anthropic', true], ['codex-cli', true]]);
    const anthropicModels = await phone.read<MobileModelCatalog>(read('models.list', {}, { provider: 'anthropic' }));
    assert.deepEqual(anthropicModels.models.map(model => model.modelId), ['claude-sonnet-4-6', 'claude-opus-4-6']);

    // (6) an unavailable provider cannot start a session, and says why
    await assert.rejects(phone.command(command('sessions.create', {}, { message: 'hi', provider: 'openai' })), (error: unknown) =>
      error instanceof MobileRequestError && /OpenAI has no API key on the desktop/.test(error.message));
    await assert.rejects(phone.command(command('sessions.create', {}, { message: 'hi', provider: 'anthropic', model: 'gpt-5.5' })), /does not offer the model “gpt-5.5”/);
    assert.equal(desktop.launches.length, 0);

    // (2) provider A / model A selected on the phone is what the desktop launches
    const created = await phone.command<MobileSessionSnapshot>(command('sessions.create', {}, { message: 'Plan the release', provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review' }));
    assert.deepEqual(desktop.launches, [{ provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review', message: 'Plan the release' }]);
    // (3) and the session reports its actual provider/model/mode back
    assert.equal(created.provider, 'anthropic');
    assert.equal(created.model, 'claude-opus-4-6');
    assert.equal(created.mode, 'review');
    const listed = await phone.read<MobileSessionSummary[]>(read('sessions.list'));
    assert.deepEqual(listed.map(summary => [summary.provider, summary.model, summary.mode]), [['anthropic', 'claude-opus-4-6', 'review']]);

    // An existing session: refused mid-turn, then changed between turns.
    await assert.rejects(phone.command(command('sessions.configure', { sessionId: created.sessionId }, { model: 'claude-sonnet-4-6' })), /Wait for the current turn to finish/);
    desktop.update(created.sessionId, record => ({ ...record, state: 'completed' }));
    const remodelled = await phone.command<MobileSessionSnapshot>(command('sessions.configure', { sessionId: created.sessionId }, { model: 'claude-sonnet-4-6' }));
    assert.equal(remodelled.model, 'claude-sonnet-4-6');
    desktop.update(created.sessionId, record => ({ ...record, state: 'completed' }));
    const handedOver = await phone.command<MobileSessionSnapshot>(command('sessions.configure', { sessionId: created.sessionId }, { provider: 'codex-cli', model: 'gpt-5.5' }));
    assert.deepEqual([handedOver.provider, handedOver.model], ['codex-cli', 'gpt-5.5']);
    assert.deepEqual(desktop.changes, [{ model: 'claude-sonnet-4-6' }, { handover: { provider: 'codex-cli', model: 'gpt-5.5' } }]);
  } finally {
    phone.close();
    await server.stop();
  }
});

test('usage streams to the phone and reconnect/replay neither duplicates nor loses session updates', async () => {
  const desktop = fakeDesktop();
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const server = new MobileLanServer({
    app: desktop.app,
    hostStaticKey: hostKey,
    authorizePeer: () => ({ deviceId: 'paired-phone', capabilities: ['view', 'execute', 'approve'], projectIds: [PROJECT] }),
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  try {
    const first = nodeClient(server.port!, hostKey, phoneKey);
    const mirror = await phoneMirror(first);
    const created = await first.command<MobileSessionSnapshot>(command('sessions.create', {}, { message: 'Summarise the diff', provider: 'codex-cli', model: 'gpt-5.5' }));
    const id = created.sessionId;

    // Stream a reply with growing usage, as the agent host reports it.
    desktop.update(id, record => ({ ...record, responseText: 'Working', tokenUsage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 } }));
    desktop.update(id, record => ({ ...record, responseText: 'Working through the diff', tokenUsage: { inputTokens: 900, outputTokens: 180, totalTokens: 1080 }, cost: { currency: 'USD', amount: 0.03 } }));
    await settle();
    // (4)(5) usage on the phone is the desktop's live figure, updated by the stream
    assert.equal(mirror.sessions[id]?.tokenUsage?.totalTokens, 1080);
    assert.deepEqual(mirror.sessions[id]?.cost, { currency: 'USD', amount: 0.03 });
    assert.equal(mirror.sessions[id]?.messages.at(-1)?.status, 'streaming');
    const usage = await first.read<{ tokenUsage?: { totalTokens?: number }; costStatus: string; providerLabel?: string }>(read('sessions.usage', { sessionId: id }));
    assert.equal(usage.tokenUsage?.totalTokens, 1080);
    assert.equal(usage.costStatus, 'reported');
    assert.equal(usage.providerLabel, 'Codex CLI (local)');

    // The phone drops off (backgrounded / network loss) mid-stream…
    first.close();
    await settle(50);
    // …while the desktop finishes the turn and the user continues on desktop.
    desktop.update(id, record => ({
      ...record,
      state: 'completed',
      responseText: undefined,
      events: [...record.events, { timestamp: '2026-09-23T09:01:00.000Z', type: 'message', summary: 'Working through the diff: 3 files changed.' }],
      tokenUsage: { inputTokens: 900, outputTokens: 260, totalTokens: 1160 },
      cost: { currency: 'USD', amount: 0.04 },
    }));
    const latestBeforeReconnect = desktop.ledger.latestSequence();

    // (8) reconnect: re-read + replay after the pinned cursor
    const second = nodeClient(server.port!, hostKey, phoneKey);
    const resumed = await phoneMirror(second);
    assert.equal(resumed.info.latestSequence, latestBeforeReconnect);
    const session = resumed.sessions[id]!;
    assert.deepEqual(session.messages.map(message => [message.role, message.text, message.status]), [
      ['user', 'Summarise the diff', 'complete'],
      ['assistant', 'Working through the diff: 3 files changed.', 'complete'],
    ], 'the finished reply replaced the streaming one exactly once');
    assert.equal(session.tokenUsage?.totalTokens, 1160);
    assert.equal(session.lifecycle, 'completed');

    // Live updates keep flowing after reconnect, and a full replay from the start
    // re-delivers every event without duplicating or regressing anything.
    await second.command(command('sessions.continue', { sessionId: id }, { message: 'Now the tests' }));
    await settle();
    await second.replay(0);
    await settle();
    const after = resumed.sessions[id]!;
    assert.ok(resumed.received > 3, 'replayed history was actually delivered');
    assert.deepEqual(after.messages.map(message => message.text), ['Summarise the diff', 'Working through the diff: 3 files changed.', 'Now the tests']);
    assert.equal(after.lifecycle, 'active');
    assert.equal(after.tokenUsage?.totalTokens, 1160);
    second.close();
  } finally {
    await server.stop();
  }
});

test('a theme change reaches a project-scoped phone live, as a host-wide event', async () => {
  const desktop = fakeDesktop();
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const server = new MobileLanServer({
    app: desktop.app,
    hostStaticKey: hostKey,
    authorizePeer: () => ({ deviceId: 'paired-phone', capabilities: ['view'], projectIds: [PROJECT] }),
  });
  await server.start(0, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] });
  const phone = nodeClient(server.port!, hostKey, phoneKey);
  try {
    const appearances: string[] = [];
    phone.onEvent(envelope => {
      const event = (envelope as unknown as { event: { type: string; appearance?: { themeId: string } } }).event;
      if (event.type === 'host.appearance') appearances.push(event.appearance!.themeId);
    });
    await phoneMirror(phone);
    appendMobileAppearanceEvent(desktop.ledger, HOST, {
      themeId: 'praxis-light', themeName: 'Praxis Light', mode: 'light',
      colors: { bg: '#f5f2eb', bgElevated: '#fffdf8', bgSunken: '#ebe7de', bgInput: '#fffdf8', border: '#d5c8b8', borderStrong: '#ad9a85', text: '#2c2620', textSecondary: '#74695e', textTertiary: '#958878', accent: '#c6431f', accentContrast: '#fffdf8', success: '#467a5b', warning: '#9b6b22', danger: '#b94a48' },
    });
    await settle();
    assert.deepEqual(appearances, ['praxis-light'], 'the unscoped theme event is not filtered out like an unscoped session');
    phone.close();
  } finally {
    await server.stop();
  }
});
