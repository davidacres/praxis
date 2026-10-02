import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_PROTOCOL_VERSION,
  type AnyGadgetEnvelope,
  type MobileCaller,
  type MobileCommand,
  type MobileModelCatalog,
  type MobileProviderCatalog,
  type MobileReadRequest,
  type MobileSessionSnapshot,
} from '@praxis/core';
import {
  createMobileHostExecutionHandlers,
  createMobileHostReads,
  mobileActorFor,
  type MobileHostServiceDeps,
} from './mobileHostServices';

/** A desktop with Anthropic ready, OpenAI without a key, Gemini switched off, and no analysis prompt. */
const FAKE_PROVIDER_CATALOG: MobileProviderCatalog = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  providers: [
    { provider: 'anthropic', label: 'Anthropic', kind: 'api', available: true, defaultModel: 'claude-sonnet-4-6' },
    { provider: 'openai', label: 'OpenAI', kind: 'api', available: false, unavailableReason: 'not-configured', unavailableMessage: 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.' },
    { provider: 'gemini', label: 'Google Gemini', kind: 'api', available: false, unavailableReason: 'disabled', unavailableMessage: 'Google Gemini is turned off on the desktop (Settings → AI Provider).' },
    { provider: 'claude-code-cli', label: 'Claude Code (local)', kind: 'cli-agent', available: true },
  ],
  sessionModes: [
    { mode: 'chat', available: true, toolAccess: 'full' },
    { mode: 'analysis', available: false, toolAccess: 'read-only', unavailableMessage: 'Set an analysis system prompt under Settings → AI Provider on the desktop first.' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
  ],
};

function fakeModelCatalog(provider: string): MobileModelCatalog {
  if (provider === 'anthropic') {
    return {
      provider,
      status: 'ok',
      defaultModel: 'claude-sonnet-4-6',
      models: [
        { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 200000 },
        { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextLength: 200000 },
      ],
    };
  }
  return { provider, status: 'unavailable', message: 'the agent did not answer', models: [] };
}

const caller: MobileCaller = { deviceId: 'phone-1', subject: 'dave', capabilities: ['view', 'execute', 'approve'] };
const viewAndExecute: MobileCaller = { deviceId: 'phone-2', capabilities: ['view', 'execute'] };

const GADGET_SCOPE = { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' };
const FAKE_GADGETS: Record<string, AnyGadgetEnvelope> = {
  'msg-3-1': {
    version: 1, gadgetId: 'msg-3-1', kind: 'choice', scope: GADGET_SCOPE, issuedAt: '2026-09-24T10:00:00.000Z', fallbackText: 'Pick one',
    payload: { question: 'Which fix?', options: [{ value: 'a', label: 'Patch it' }, { value: 'b', label: 'Rewrite it' }] },
    actions: [{ actionId: 'answer', label: 'Answer', effect: 'informational' }],
  },
  'msg-5-1': {
    version: 1, gadgetId: 'msg-5-1', kind: 'approval', scope: GADGET_SCOPE, issuedAt: '2026-09-24T10:00:00.000Z', fallbackText: 'Approve?',
    payload: { title: 'Ship it', summary: 'All gates passed', gate: 'release' },
    actions: [{ actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'release' }],
  },
};
const deviceOnly: MobileCaller = { deviceId: 'phone-1', capabilities: ['view', 'execute', 'approve'] };

interface Recorder {
  calls: Array<[string, ...unknown[]]>;
  deps: MobileHostServiceDeps;
}

function recorder(overrides: Partial<MobileHostServiceDeps> = {}): Recorder {
  const calls: Array<[string, ...unknown[]]> = [];
  const note = (name: string, ...args: unknown[]): void => {
    calls.push([name, ...args]);
  };
  const deps: MobileHostServiceDeps = {
    hostId: 'host-mac',
    hostName: () => 'Dave Mac',
    hostOnline: () => true,
    hostEpoch: 'epoch-1',
    latestSequence: () => 41,
    providerCatalog: async projectId => {
      note('providerCatalog', projectId);
      return FAKE_PROVIDER_CATALOG;
    },
    modelCatalog: async (provider, refresh) => {
      note('modelCatalog', provider, refresh);
      return fakeModelCatalog(provider);
    },
    describeDevice: async deviceId => {
      note('describeDevice', deviceId);
      return { label: 'Dave’s iPhone', projects: [{ projectId: 'p1', name: 'Praxis' }], hostName: 'Dave Mac', accessMode: 'local-only', pairedAt: '2026-09-20T09:00:00.000Z' };
    },
    listProjects: async () => {
      note('listProjects');
      return [{ projectId: 'p1', name: 'Praxis' }];
    },
    getProject: async id => {
      note('getProject', id);
      return id === 'p1' ? { projectId: 'p1', name: 'Praxis', workflow: 'governed-delivery' } : undefined;
    },
    listWork: async projectId => {
      note('listWork', projectId);
      return [{ workId: 'W-1', title: 'x', status: 'idle' }];
    },
    listSessions: async projectId => {
      note('listSessions', projectId);
      return [];
    },
    getSession: async id => {
      note('getSession', id);
      return id === 's1' ? {
        sessionId: 's1', sessionKey: 'W-1', projectId: 'p1', workId: 'W-1', title: 'x', lifecycle: 'idle', mode: 'chat', archived: false,
        startedAt: '2026-09-10T09:00:00.000Z', sequence: 0, messages: [], pendingPermissions: [], canContinue: true, canCancel: false,
      } : undefined;
    },
    listWorkflows: async projectId => {
      note('listWorkflows', projectId);
      return [{ workflowId: 'governed-delivery', name: 'Governed delivery', trigger: 'manual' }];
    },
    listRuns: async projectId => {
      note('listRuns', projectId);
      return [];
    },
    getRun: async id => {
      note('getRun', id);
      return id === 'r1' ? { runId: 'r1', projectId: 'p1', status: 'awaiting-approval' } : undefined;
    },
    listRunChanges: async runId => {
      note('listRunChanges', runId);
      return { runId, files: [] };
    },
    sessionChanges: async sessionId => {
      note('sessionChanges', sessionId);
      return { sessionId, repository: true, files: [{ path: 'src/a.ts', status: 'modified', reportedBySession: true }] };
    },
    sessionFileDiff: async (sessionId, path) => {
      note('sessionFileDiff', sessionId, path);
      return { path, binary: false, additions: 1, deletions: 0, hunks: [], truncated: false };
    },
    sessionImagePreview: async (sessionId, params) => {
      note('sessionImagePreview', sessionId, params);
      return undefined;
    },
    findGadget: (sessionId, gadgetId) => {
      note('findGadget', sessionId, gadgetId);
      return FAKE_GADGETS[gadgetId];
    },
    submitGadget: async (sessionId, payload, actor) => {
      note('submitGadget', sessionId, payload, actor);
      return { version: 1, gadgetId: payload.gadgetId, actionId: payload.actionId, correlationId: 'c1', idempotencyKey: payload.idempotencyKey, status: 'completed', at: '2026-09-24T10:00:00.000Z' };
    },
    rejectRun: async (runId, actor, reason) => {
      note('rejectRun', runId, actor, reason);
      return { runId, status: 'failed' };
    },
    listAttention: async projectId => {
      note('listAttention', projectId);
      return [];
    },
    createSession: async input => {
      note('createSession', input);
      return {
        sessionId: 's-new', sessionKey: 'SESSION-NEW', projectId: input.projectId, title: input.title,
        lifecycle: 'active', mode: 'chat', archived: false, startedAt: '2026-09-10T09:00:00.000Z',
        sequence: 0, messages: [], pendingPermissions: [], canContinue: false, canCancel: true,
      };
    },
    startRun: async input => {
      note('startRun', input);
      return { runId: 'r-new' };
    },
    cancelRun: async (runId, reason, actor) => {
      note('cancelRun', runId, reason, actor);
      return { runId };
    },
    retryStage: async (runId, nodeId, actor) => {
      note('retryStage', runId, nodeId, actor);
      return { runId };
    },
    approveRun: async (runId, actor, note2) => {
      note('approveRun', runId, actor, note2);
      return { runId };
    },
    continueSession: async (sessionId, message, actor) => {
      note('continueSession', sessionId, message, actor);
      return { sessionId };
    },
    configureSession: async (sessionId, change, actor) => {
      note('configureSession', sessionId, change, actor);
      return {
        sessionId, sessionKey: 'W-1', projectId: 'p1', title: 'x', lifecycle: 'active', mode: change.mode ?? 'chat', archived: false,
        startedAt: '2026-09-10T09:00:00.000Z', sequence: 0, messages: [], pendingPermissions: [], canContinue: false, canCancel: true,
      };
    },
    cancelSession: async (sessionId, actor) => {
      note('cancelSession', sessionId, actor);
      return { sessionId };
    },
    respondToPermission: async (requestId, decision, actor, projectId) => {
      note('respondToPermission', requestId, decision, actor, projectId);
      return { requestId };
    },
    ...overrides,
  };
  return { calls, deps };
}

function read(operation: MobileReadRequest['operation'], target: MobileReadRequest['target']): MobileReadRequest {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: 'req-1', caller, target, operation };
}

function command(operation: MobileCommand['operation'], target: MobileCommand['target'], payload: unknown, who: MobileCaller = caller): MobileCommand {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, commandId: 'cmd-abc1234', issuedAt: '2026-09-10T09:00:00.000Z', caller: who, target, operation, payload };
}

test('actor is the verified subject, falling back to the paired device', () => {
  assert.equal(mobileActorFor(caller), 'dave');
  assert.equal(mobileActorFor(deviceOnly), 'phone-1');
});

test('reads route to the matching dependency and pass through scope', async () => {
  const { calls, deps } = recorder();
  const reads = createMobileHostReads(deps);

  assert.deepEqual(await reads['hosts.list'](read('hosts.list', { hostId: 'host-mac' })), [
    { hostId: 'host-mac', hostName: 'Dave Mac', online: true },
  ]);
  await reads['projects.snapshot'](read('projects.snapshot', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['work.list'](read('work.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['sessions.list'](read('sessions.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['workflows.list'](read('workflows.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['workflowRuns.list'](read('workflowRuns.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['attention.list'](read('attention.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['changes.get'](read('changes.get', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }));

  assert.deepEqual(calls.filter(c => !['getProject', 'getSession', 'getRun'].includes(c[0])).map(c => c[0]), ['listWork', 'listSessions', 'listWorkflows', 'listRuns', 'listAttention', 'listRunChanges']);
  assert.deepEqual(calls.find(c => c[0] === 'listRuns'), ['listRuns', 'p1']);
  assert.deepEqual(calls.find(c => c[0] === 'listWork'), ['listWork', 'p1']);
});

test('projects.snapshot returns the whole list when no project is targeted', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  assert.deepEqual(await reads['projects.snapshot'](read('projects.snapshot', { hostId: 'host-mac' })), {
    projects: [{ projectId: 'p1', name: 'Praxis' }],
  });
});

test('reads fail closed when a required identifier is missing', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  await assert.rejects(reads['work.list'](read('work.list', { hostId: 'host-mac' })), /requires target\.projectId/);
  await assert.rejects(reads['sessions.get'](read('sessions.get', { hostId: 'host-mac' })), /requires target\.sessionId/);
});

test('a not-found run or session is an error, not an empty result', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  await assert.rejects(reads['workflowRuns.get'](read('workflowRuns.get', { hostId: 'host-mac', projectId: 'p1', runId: 'missing' })), /was not found/);
  await assert.rejects(reads['sessions.get'](read('sessions.get', { hostId: 'host-mac', projectId: 'p1', sessionId: 'missing' })), /was not found/);
});

test('resource ids cannot escape the paired project scope', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(
    reads['sessions.get'](read('sessions.get', { hostId: 'host-mac', projectId: 'p2', sessionId: 's1' })),
    /not found in project p2/,
  );
  await assert.rejects(
    handlers['workflowRuns.cancel'](command('workflowRuns.cancel', { hostId: 'host-mac', projectId: 'p2', runId: 'r1' }, {})),
    /not found in project p2/,
  );
});

test('commands extract payload fields and carry the verified actor', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);

  await handlers['sessions.create'](command('sessions.create', { hostId: 'host-mac', projectId: 'p1' }, { title: 'Mobile chat', message: 'start here' }));
  await handlers['sessions.continue'](command('sessions.continue', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, { message: '  ship it  ' }));
  await handlers['sessions.cancel'](command('sessions.cancel', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, {}));
  await handlers['workflowGates.approve'](command('workflowGates.approve', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { note: 'looks good' }));
  await handlers['workflowRuns.cancel'](command('workflowRuns.cancel', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, {}, deviceOnly));
  await handlers['workflowRuns.retryStage'](command('workflowRuns.retryStage', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { nodeId: 'qa' }));
  await handlers['workflowRuns.start'](command('workflowRuns.start', { hostId: 'host-mac', projectId: 'p1' }, { workflowId: 'quick-change', task: 'Fix mobile' }));
  await handlers['permissions.respond'](command('permissions.respond', { hostId: 'host-mac', projectId: 'p1', requestId: 'q1' }, { decision: 'allow_always' }));

  assert.deepEqual(calls.find(c => c[0] === 'createSession'), ['createSession', { projectId: 'p1', title: 'Mobile chat', message: 'start here', provider: 'anthropic', mode: 'chat' }]);
  assert.deepEqual(calls.find(c => c[0] === 'continueSession'), ['continueSession', 's1', 'ship it', 'dave']);
  assert.deepEqual(calls.find(c => c[0] === 'cancelSession'), ['cancelSession', 's1', 'dave']);
  assert.deepEqual(calls.find(c => c[0] === 'approveRun'), ['approveRun', 'r1', 'dave', 'looks good']);
  assert.deepEqual(calls.find(c => c[0] === 'cancelRun'), ['cancelRun', 'r1', undefined, 'phone-1']);
  assert.deepEqual(calls.find(c => c[0] === 'retryStage'), ['retryStage', 'r1', 'qa', 'dave']);
  assert.deepEqual(calls.find(c => c[0] === 'startRun'), ['startRun', { projectId: 'p1', workflowId: 'quick-change', task: 'Fix mobile' }]);
  assert.deepEqual(calls.find(c => c[0] === 'respondToPermission'), ['respondToPermission', 'q1', 'allow_always', 'dave', 'p1']);
});

test('commands reject a missing or malformed payload', async () => {
  const { deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(handlers['sessions.create'](command('sessions.create', { hostId: 'host-mac', projectId: 'p1' }, { message: '   ' })), /non-empty payload\.message/);
  await assert.rejects(handlers['sessions.continue'](command('sessions.continue', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, { message: '   ' })), /non-empty payload\.message/);
  await assert.rejects(handlers['workflowRuns.start'](command('workflowRuns.start', { hostId: 'host-mac', projectId: 'p1' }, {})), /payload\.workflowId/);
  await assert.rejects(handlers['permissions.respond'](command('permissions.respond', { hostId: 'host-mac', projectId: 'p1', requestId: 'q1' }, { decision: 'maybe' })), /'allow', 'allow_always', or 'deny'/);
  await assert.rejects(handlers['permissions.respond'](command('permissions.respond', { hostId: 'host-mac', projectId: 'p1' }, { decision: 'allow' })), /requires target\.requestId/);
});

function readWith(operation: MobileReadRequest['operation'], target: MobileReadRequest['target'], params: MobileReadRequest['params']): MobileReadRequest {
  return { ...read(operation, target), ...(params ? { params } : {}) };
}

test('host.info advertises the current surface and the live event cursor', async () => {
  const { deps } = recorder();
  const info = await createMobileHostReads(deps, ['sessions.create'])['host.info'](read('host.info', { hostId: 'host-mac' })) as {
    surfaceRevision: number; readOperations: string[]; commandOperations: string[]; latestSequence: number; hostEpoch: string;
  };
  assert.equal(info.surfaceRevision, 7);
  for (const operation of ['providers.list', 'models.list', 'sessions.usage', 'access.get', 'host.info']) assert.ok(info.readOperations.includes(operation), operation);
  assert.deepEqual(info.commandOperations, ['sessions.create']);
  assert.equal(info.latestSequence, 41);
  assert.equal(info.hostEpoch, 'epoch-1');
  assert.equal('appearance' in info, false, 'no theme until a desktop window has applied one');
});

test('host.info carries the desktop theme once a window has published it', async () => {
  const { deps } = recorder();
  const appearance = { themeId: 'praxis-dark', themeName: 'Praxis Dark', mode: 'dark' as const, colors: {} as never };
  const info = await createMobileHostReads({ ...deps, appearance: () => appearance })['host.info'](read('host.info', { hostId: 'host-mac' })) as { appearance?: unknown };
  assert.deepEqual(info.appearance, appearance);
});

test('providers.list and models.list serve the catalog without private settings', async () => {
  const { deps, calls } = recorder();
  const reads = createMobileHostReads(deps);
  const catalog = await reads['providers.list'](read('providers.list', { hostId: 'host-mac', projectId: 'p1' }));
  assert.deepEqual(catalog, FAKE_PROVIDER_CATALOG);
  assert.deepEqual(calls.find(c => c[0] === 'providerCatalog'), ['providerCatalog', 'p1']);
  assert.doesNotMatch(JSON.stringify(catalog), /apiKey|keySource|gatewayUrl|baseUrl|cliPath|https?:/);

  const models = await reads['models.list'](readWith('models.list', { hostId: 'host-mac' }, { provider: 'anthropic', refresh: true })) as MobileModelCatalog;
  assert.equal(models.status, 'ok');
  assert.deepEqual(models.models.map(model => model.modelId), ['claude-sonnet-4-6', 'claude-opus-4-6']);
  assert.deepEqual(calls.find(c => c[0] === 'modelCatalog'), ['modelCatalog', 'anthropic', true]);

  const unavailable = await reads['models.list'](readWith('models.list', { hostId: 'host-mac' }, { provider: 'openai' })) as MobileModelCatalog;
  assert.equal(unavailable.status, 'provider-unavailable');
  assert.match(unavailable.message ?? '', /no API key/);
  assert.equal(calls.filter(c => c[0] === 'modelCatalog').length, 1, 'an unavailable provider is never probed');
  await assert.rejects(reads['models.list'](readWith('models.list', { hostId: 'host-mac' }, { provider: 'made-up' })), /not an AI provider this desktop knows/);
});

test('sessions.create launches exactly the selected provider, model and mode', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await handlers['sessions.create'](command('sessions.create', { hostId: 'host-mac', projectId: 'p1' }, { message: 'review the diff', provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review' }));
  assert.deepEqual(calls.find(c => c[0] === 'createSession'), ['createSession', {
    projectId: 'p1', title: 'review the diff', message: 'review the diff', provider: 'anthropic', model: 'claude-opus-4-6', mode: 'review',
  }]);
});

test('sessions.create refuses unavailable providers, unknown models and unavailable modes with reasons', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  const create = (payload: Record<string, unknown>) => handlers['sessions.create'](command('sessions.create', { hostId: 'host-mac', projectId: 'p1' }, { message: 'hi', ...payload }));
  await assert.rejects(create({ provider: 'openai' }), /OpenAI has no API key on the desktop/);
  await assert.rejects(create({ provider: 'gemini' }), /Google Gemini is turned off/);
  await assert.rejects(create({ provider: 'nope' }), /not an AI provider this desktop knows/);
  await assert.rejects(create({ provider: 'anthropic', model: 'gpt-4o' }), /Anthropic on this desktop does not offer the model “gpt-4o”/);
  await assert.rejects(create({ provider: 'claude-code-cli', model: 'opus' }), /could not confirm that Claude Code \(local\) offers “opus” \(the agent did not answer\)/);
  await assert.rejects(create({ mode: 'analysis' }), /Set an analysis system prompt/);
  await assert.rejects(create({ mode: 'plan' }), /not a session mode/);
  assert.equal(calls.filter(c => c[0] === 'createSession').length, 0, 'nothing launched');
});

test('sessions.usage reports recorded totals, and says when a provider reports no cost', async () => {
  const base: MobileSessionSnapshot = {
    sessionId: 's1', sessionKey: 'W-1', projectId: 'p1', title: 'x', lifecycle: 'completed', mode: 'chat', archived: false,
    startedAt: '2026-09-10T09:00:00.000Z', sequence: 12, messages: [], pendingPermissions: [], canContinue: true, canCancel: false,
  };
  const withUsage = recorder({ getSession: async () => ({ ...base, provider: 'claude-code-cli', model: 'opus', tokenUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, contextTokens: 9000, contextLimit: 200000, cost: { currency: 'USD', amount: 0.42 } }) });
  const usage = await createMobileHostReads(withUsage.deps)['sessions.usage'](read('sessions.usage', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }));
  assert.deepEqual(usage, {
    sessionId: 's1', provider: 'claude-code-cli', providerLabel: 'Claude Code (local)', model: 'opus', lifecycle: 'completed',
    tokenUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, contextTokens: 9000, contextLimit: 200000,
    cost: { currency: 'USD', amount: 0.42 }, costStatus: 'reported', sequence: 12,
  });

  const noCost = recorder({ getSession: async () => ({ ...base, provider: 'anthropic', tokenUsage: { totalTokens: 50 } }) });
  const apiUsage = await createMobileHostReads(noCost.deps)['sessions.usage'](read('sessions.usage', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' })) as { costStatus: string; cost?: unknown };
  assert.equal(apiUsage.costStatus, 'not-reported');
  assert.equal(apiUsage.cost, undefined, 'an unreported cost is absent, never zero');

  const empty = recorder({ getSession: async () => base });
  const none = await createMobileHostReads(empty.deps)['sessions.usage'](read('sessions.usage', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' })) as { tokenUsage?: unknown };
  assert.equal(none.tokenUsage, undefined);
  await assert.rejects(createMobileHostReads(empty.deps)['sessions.usage'](read('sessions.usage', { hostId: 'host-mac', projectId: 'p2', sessionId: 's1' })), /not found in project p2/);
});

test('access.get reports the verified caller grant, not a claimed one', async () => {
  const { deps } = recorder();
  const access = await createMobileHostReads(deps)['access.get'](read('access.get', { hostId: 'host-mac' }));
  assert.deepEqual(access, {
    deviceId: 'phone-1', capabilities: ['view', 'execute', 'approve'], label: 'Dave’s iPhone', projects: [{ projectId: 'p1', name: 'Praxis' }],
    hostName: 'Dave Mac', accessMode: 'local-only', pairedAt: '2026-09-20T09:00:00.000Z', transport: 'noise-ik', protocolVersion: 1, surfaceRevision: 7,
  });
});

test('sessions.configure hands over, changes model or switches mode between turns only', async () => {
  const idle: MobileSessionSnapshot = {
    sessionId: 's1', sessionKey: 'W-1', projectId: 'p1', title: 'x', lifecycle: 'completed', mode: 'chat', archived: false, provider: 'anthropic', model: 'claude-sonnet-4-6',
    startedAt: '2026-09-10T09:00:00.000Z', sequence: 3, messages: [], pendingPermissions: [], canContinue: true, canCancel: false,
  };
  const { calls, deps } = recorder({ getSession: async () => idle });
  const handlers = createMobileHostExecutionHandlers(deps);
  const configure = (payload: Record<string, unknown>) => handlers['sessions.configure'](command('sessions.configure', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, payload));

  await configure({ provider: 'anthropic', model: 'claude-opus-4-6' });
  await configure({ provider: 'claude-code-cli' });
  await configure({ mode: 'review' });
  await configure({ provider: 'anthropic', model: 'claude-sonnet-4-6', mode: 'chat' });
  assert.deepEqual(calls.filter(c => c[0] === 'configureSession').map(c => c[2]), [
    { model: 'claude-opus-4-6' },
    { handover: { provider: 'claude-code-cli' } },
    { mode: 'review' },
  ], 'a no-op change reaches nothing');

  await assert.rejects(configure({ provider: 'openai' }), /OpenAI has no API key/);
  await assert.rejects(configure({ model: 'gpt-4o' }), /does not offer the model “gpt-4o”/);
  await assert.rejects(configure({ mode: 'analysis' }), /Set an analysis system prompt/);

  const busy = recorder({ getSession: async () => ({ ...idle, lifecycle: 'active', canCancel: true }) });
  await assert.rejects(
    createMobileHostExecutionHandlers(busy.deps)['sessions.configure'](command('sessions.configure', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, { model: 'claude-opus-4-6' })),
    /Wait for the current turn to finish/,
  );
  assert.equal(busy.calls.filter(c => c[0] === 'configureSession').length, 0);
});

test('gadgets.submit records the answer as the verified actor and reports an open decision to the agent', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await handlers['gadgets.submit'](command('gadgets.submit', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, {
    gadgetId: 'msg-3-1', actionId: 'answer', value: { kind: 'choice', selected: 'b' },
  }));
  const submitted = calls.find(c => c[0] === 'submitGadget');
  assert.deepEqual(submitted, ['submitGadget', 's1', { gadgetId: 'msg-3-1', actionId: 'answer', value: { kind: 'choice', selected: 'b' }, idempotencyKey: 'cmd-abc1234' }, 'dave']);
  assert.deepEqual(calls.find(c => c[0] === 'continueSession'), ['continueSession', 's1', 'Gadget response — "Which fix?": Rewrite it.', 'dave']);
});

test('gadgets.submit refuses an approval-effect answer from a phone without the approve permission', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(
    handlers['gadgets.submit'](command('gadgets.submit', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, {
      gadgetId: 'msg-5-1', actionId: 'approve', value: { kind: 'confirmation', confirmed: true },
    }, viewAndExecute)),
    /not allowed to approve/,
  );
  assert.equal(calls.some(c => c[0] === 'submitGadget'), false);
  // With approve it goes through, and an approval is not echoed to the agent as a chat turn.
  await handlers['gadgets.submit'](command('gadgets.submit', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, {
    gadgetId: 'msg-5-1', actionId: 'approve', value: { kind: 'confirmation', confirmed: true },
  }));
  assert.equal(calls.some(c => c[0] === 'submitGadget'), true);
  assert.equal(calls.some(c => c[0] === 'continueSession'), false);
});

test('gadgets.submit rejects a malformed value before reaching the desktop', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(
    handlers['gadgets.submit'](command('gadgets.submit', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, {
      gadgetId: 'msg-3-1', actionId: 'answer', value: { kind: 'choice' },
    })),
    /not in a form the desktop understands/,
  );
  assert.equal(calls.some(c => c[0] === 'submitGadget'), false);
});

test('workflowGates.reject requires a reason and records the verified actor', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(
    handlers['workflowGates.reject'](command('workflowGates.reject', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { reason: '  ' })),
    /Say why/,
  );
  await handlers['workflowGates.reject'](command('workflowGates.reject', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { reason: ' tests are missing ' }));
  assert.deepEqual(calls.find(c => c[0] === 'rejectRun'), ['rejectRun', 'r1', 'dave', 'tests are missing']);
});

test('changes.get with a session target reads that session\'s working tree, or one file\'s diff', async () => {
  const { calls, deps } = recorder();
  const reads = createMobileHostReads(deps);
  const base = { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: 'req-1', caller, operation: 'changes.get' as const };
  await reads['changes.get']!({ ...base, target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' } });
  await reads['changes.get']!({ ...base, target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, params: { path: 'src/a.ts' } });
  assert.deepEqual(calls.find(c => c[0] === 'sessionChanges'), ['sessionChanges', 's1']);
  assert.deepEqual(calls.find(c => c[0] === 'sessionFileDiff'), ['sessionFileDiff', 's1', 'src/a.ts']);
  await assert.rejects(
    reads['changes.get']!({ ...base, target: { hostId: 'host-mac', projectId: 'p2', sessionId: 's1' } }),
    /not found in project p2/,
  );
});

test('sessions.imagePreview reads a chunk from a local or attached image', async () => {
  const { calls, deps } = recorder();
  const reads = createMobileHostReads(deps);
  const base = { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: 'req-1', caller, operation: 'sessions.imagePreview' as const };
  const hit = await reads['sessions.imagePreview']!({
    ...base,
    target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' },
    params: { path: 'shot.png' },
  });
  assert.deepEqual(calls.find(c => c[0] === 'sessionImagePreview'), ['sessionImagePreview', 's1', { path: 'shot.png', offset: 0 }]);
  assert.deepEqual(hit, {});
  await reads['sessions.imagePreview']!({
    ...base,
    target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' },
    params: { eventIndex: 3, attachmentIndex: 0, offset: 4 },
  });
  assert.deepEqual(
    calls.find(c => c[0] === 'sessionImagePreview' && (c[2] as { eventIndex?: number }).eventIndex === 3),
    ['sessionImagePreview', 's1', { eventIndex: 3, attachmentIndex: 0, offset: 4 }],
  );
  await assert.rejects(
    reads['sessions.imagePreview']!({ ...base, target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' } }),
    /requires either params.path or both attachment indices/,
  );
  await assert.rejects(
    reads['sessions.imagePreview']!({
      ...base,
      target: { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' },
      params: { eventIndex: 3 },
    }),
    /requires either params.path or both attachment indices/,
  );
  await assert.rejects(
    reads['sessions.imagePreview']!({ ...base, target: { hostId: 'host-mac', projectId: 'p2', sessionId: 's1' }, params: { path: 'shot.png' } }),
    /not found in project p2/,
  );
});
