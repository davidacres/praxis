// Run from the repository root after building core:
// node crates/praxis-mobile/tests/fixtures/generate_host_services.cjs [dependency-repo-root]
// Loads the TypeScript source in THIS checkout; the optional root supplies installed npm deps.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const dependencyRoot = path.resolve(process.argv[2] || root);
const dependencyRequire = Module.createRequire(path.join(dependencyRoot, 'package.json'));
const sourcePath = path.join(root, 'apps/praxis-desktop/main/src/main/mobileHostServices.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const coreUrl = require('node:url').pathToFileURL(dependencyRequire.resolve('@praxis/core')).href;
const javascript = Module.stripTypeScriptTypes(source).replace("'@praxis/core'", JSON.stringify(coreUrl));

const session = {
  sessionId: 's1', sessionKey: 'W-1', projectId: 'p1', title: 'Chat', lifecycle: 'completed',
  mode: 'chat', archived: false, provider: 'anthropic', model: 'sonnet',
  startedAt: '2026-10-01T00:00:00.000Z', sequence: 3, messages: [], pendingPermissions: [],
  canContinue: true, canCancel: false,
};
const catalog = {
  defaultProvider: 'anthropic', defaultModel: 'sonnet',
  providers: [
    { provider: 'anthropic', label: 'Anthropic', kind: 'api', available: true },
    { provider: 'openai', label: 'OpenAI', kind: 'api', available: false, unavailableMessage: 'No key on desktop.' },
    { provider: 'cli', label: 'CLI', kind: 'cli-agent', available: true },
  ],
  sessionModes: [
    { mode: 'chat', available: true, toolAccess: 'full' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
    { mode: 'analysis', available: false, toolAccess: 'read-only', unavailableMessage: 'Set an analysis prompt first.' },
  ],
};
const gadget = {
  version: 1, kind: 'choice', gadgetId: 'g1',
  payload: { question: 'Which fix?', options: [{ value: 'b', label: 'Rewrite it' }] },
  actions: [{ actionId: 'answer', label: 'Answer', effect: 'informational' }],
};
const caller = { deviceId: 'phone-1', subject: ' dave ', capabilities: ['view', 'execute', 'approve'] };
const target = { hostId: 'host', projectId: 'p1', sessionId: 's1', runId: 'r1', requestId: 'q1' };
const cases = [];
function add(name, kind, operation, payload = {}, config = {}, request = {}) {
  cases.push({ name, kind, config, request: {
    protocolVersion: 1, ...(kind === 'command'
      ? { commandId: 'command-0001', issuedAt: '2026-10-01T00:00:00.000Z', payload }
      : { requestId: 'read-1' }),
    caller, target, operation, ...request,
  } });
}
for (const operation of ['hosts.list', 'host.info', 'providers.list', 'models.list', 'sessions.usage',
  'access.get', 'projects.snapshot', 'work.list', 'sessions.list', 'sessions.get', 'workflows.list',
  'workflowRuns.list', 'workflowRuns.get', 'changes.get', 'attention.list']) {
  add(operation, 'read', operation);
}
add('all projects', 'read', 'projects.snapshot', {}, {}, { target: { hostId: 'host' } });
add('missing project', 'read', 'projects.snapshot', {}, {}, { target: { ...target, projectId: 'missing' } });
add('appearance', 'read', 'host.info', {}, { appearance: { background: '#112233' } });
add('usage zero cost', 'read', 'sessions.usage', {}, { session: { ...session, cost: 0, tokenUsage: { inputTokens: 42 }, contextTokens: 0, contextLimit: 200000 } });
add('model refresh', 'read', 'models.list', {}, {}, { params: { provider: 'anthropic', refresh: true } });
add('model unavailable', 'read', 'models.list', {}, {}, { params: { provider: 'openai' } });
add('model unknown', 'read', 'models.list', {}, {}, { params: { provider: 'unknown' } });
add('run changes', 'read', 'changes.get', {}, {}, { target: { ...target, sessionId: undefined } });
add('session diff', 'read', 'changes.get', {}, {}, { params: { path: ' src/a.ts ' } });
for (const params of [{ path: 'shot.png' }, { eventIndex: 3, attachmentIndex: 0, offset: 4 },
  {}, { eventIndex: 3 }, { path: 'x', eventIndex: 3, attachmentIndex: 0 },
  { path: 'x', offset: -1 }, { path: 'x', offset: 0.5 }, { path: 'x', offset: '4' },
  { path: 'x', offset: null }, { path: 'x', offset: 9007199254740992 }]) {
  add(`image ${JSON.stringify(params)}`, 'read', 'sessions.imagePreview', {}, {}, { params });
}
const payloads = {
  'sessions.create': { title: ' Mobile ', message: ' hello ', model: 'opus', mode: 'review' },
  'sessions.continue': { message: ' continue ', actor: 'forged' },
  'sessions.configure': { model: 'opus' },
  'sessions.cancel': {},
  'workflowRuns.start': { workflowId: ' ticket ', task: 'Fix mobile' },
  'workflowRuns.cancel': { reason: 'stop' },
  'workflowRuns.retryStage': { nodeId: ' qa ' },
  'permissions.respond': { decision: 'allow_always' },
  'workflowGates.approve': { note: 'ok', actor: 'forged' },
  'workflowGates.reject': { reason: ' missing tests ' },
  'gadgets.submit': { gadgetId: 'g1', actionId: 'answer', value: { kind: 'choice', selected: 'b' } },
};
for (const [operation, payload] of Object.entries(payloads)) add(operation, 'command', operation, payload);
for (const operation of ['sessions.get', 'sessions.usage', 'sessions.imagePreview', 'changes.get', 'workflowRuns.get']) {
  add(`cross project ${operation}`, 'read', operation, {}, {}, { target: { ...target, projectId: 'p2' } });
}
for (const operation of ['sessions.continue', 'sessions.configure', 'sessions.cancel', 'gadgets.submit',
  'workflowRuns.cancel', 'workflowRuns.retryStage', 'workflowGates.approve', 'workflowGates.reject']) {
  add(`cross project ${operation}`, 'command', operation, payloads[operation], {}, { target: { ...target, projectId: 'p2' } });
}
for (const [operation, key] of [['work.list', 'projectId'], ['sessions.get', 'sessionId'], ['workflowRuns.get', 'runId']]) {
  add(`missing ${key}`, 'read', operation, {}, {}, { target: { ...target, [key]: undefined } });
}
for (const operation of ['sessions.get', 'workflowRuns.get']) {
  add(`not found ${operation}`, 'read', operation, {}, {}, { target: { ...target, sessionId: 'missing', runId: 'missing' } });
}
for (const [operation, payload] of [['sessions.create', {}], ['sessions.continue', { message: ' ' }],
  ['workflowRuns.start', {}], ['workflowRuns.retryStage', {}], ['permissions.respond', { decision: 'maybe' }],
  ['workflowGates.reject', { reason: ' ' }], ['gadgets.submit', { gadgetId: 'g1', actionId: 'answer', value: { kind: 'choice' } }]]) {
  add(`malformed ${operation}`, 'command', operation, payload);
}
for (const payload of [{ provider: 'unknown' }, { provider: 'openai' }, { model: 'unknown' },
  { mode: 'analysis' }, { mode: null }, { mode: 42 }, { provider: 'cli', model: 'custom' },
  { message: [null, 'hi', [null, 'there']] }]) {
  add(`launch ${JSON.stringify(payload)}`, 'command', 'sessions.create', { message: 'hello', ...payload });
}
for (const payload of [{}, { provider: 'cli' }, { mode: 'review' }, { model: 'sonnet', mode: 'chat' },
  { provider: 'openai' }, { model: 'unknown' }, { mode: 'analysis' }, { mode: null }]) {
  add(`configure ${JSON.stringify(payload)}`, 'command', 'sessions.configure', payload);
}
for (const override of [{ canCancel: true }, { lifecycle: 'active' }, { archived: true }]) {
  add(`configure state ${JSON.stringify(override)}`, 'command', 'sessions.configure', { mode: 'review' }, { session: { ...session, ...override } });
}
add('device actor fallback', 'command', 'sessions.cancel', {}, {}, { caller: { ...caller, subject: ' ' } });
add('workspace trust refusal', 'command', 'workflowRuns.start', payloads['workflowRuns.start'], { startError: 'Review workspace trust on the desktop first.' });
const unscoped = { hostId: 'host', sessionId: 's1' };
const standalone = { ...session, projectId: undefined, sessionKey: 'SESSION-abcdef12' };
for (const operation of ['sessions.list', 'sessions.get']) {
  add(`scoped device ${operation}`, 'read', operation, {}, {}, { target: unscoped });
  add(`wide device ${operation}`, 'read', operation, {}, { wide: true, session: standalone }, { target: unscoped });
}
add('wide continue', 'command', 'sessions.continue', { message: 'hi' }, { wide: true, session: standalone }, { target: unscoped });
for (const snapshot of [session, { ...standalone, sessionKey: 'TASK-1' }, { ...standalone, runId: 'r1' }]) {
  add(`standalone refusal ${snapshot.sessionKey} ${snapshot.runId || ''}`, 'read', 'sessions.get', {}, { wide: true, session: snapshot }, { target: unscoped });
}
for (const status of ['accepted', 'completed', 'duplicate', 'rejected']) {
  add(`gadget ${status}`, 'command', 'gadgets.submit', payloads['gadgets.submit'], { gadgetStatus: status });
}
add('gadget explicit key', 'command', 'gadgets.submit', { ...payloads['gadgets.submit'], idempotencyKey: ' stable-key ' });
add('gadget missing', 'command', 'gadgets.submit', payloads['gadgets.submit'], { noGadget: true });
for (const capabilities of [['view', 'execute'], ['view', 'execute', 'approve']]) {
  add(`gadget approval ${capabilities.length}`, 'command', 'gadgets.submit', payloads['gadgets.submit'],
    { approval: true }, { caller: { ...caller, capabilities } });
}
const form = { name: 'Tonight', date: '2026-10-25', time: '20:30', timezone: 'Europe/London', issueKeys: ['A-2', 'A-1'] };
add('schedules info', 'read', 'host.info', {}, { schedules: true });
add('schedules list', 'read', 'scheduledRuns.list', {}, { schedules: true });
for (const [operation, payload] of [['scheduledRuns.save', form], ['scheduledRuns.setArmed', { id: 'schedule-1', armed: true }],
  ['scheduledRuns.resolveMissed', { id: 'schedule-1', resolution: 'start-now' }],
  ['scheduledRuns.save', { ...form, name: ' ' }], ['scheduledRuns.save', { ...form, issueKeys: [42] }],
  ['scheduledRuns.save', { ...form, issueKeys: Array(201).fill('A-1') }],
  ['scheduledRuns.setArmed', { id: 'schedule-1', armed: 'true' }],
  ['scheduledRuns.resolveMissed', { id: 'schedule-1', resolution: 'later' }]]) {
  add(`schedule ${operation} ${cases.length}`, 'command', operation, payload, { schedules: true });
}

function dependencies(config, calls) {
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  const snapshot = config.session || session;
  const schedule = { id: 'schedule-1', projectId: 'p1', name: 'Tonight', status: 'draft', scheduledStartAt: '2026-10-25T20:30:00.000Z', timezone: 'Europe/London', entries: [] };
  const deps = {
    hostId: 'host', hostName: () => 'Mac', hostOnline: () => true, hostEpoch: 'epoch-1', latestSequence: () => 41,
    appearance: () => config.appearance,
    providerCatalog: record('providerCatalog', catalog),
    modelCatalog: async (provider, refresh) => { calls.push(['modelCatalog', provider, refresh]); return provider === 'anthropic'
      ? { provider, status: 'ok', models: [{ modelId: 'sonnet', name: 'Sonnet' }, { modelId: 'opus', name: 'Opus' }] }
      : { provider, status: 'unavailable', message: 'agent did not answer', models: [] }; },
    describeDevice: record('describeDevice', { projects: config.wide ? [] : [{ projectId: 'p1', name: 'Praxis' }], hostName: 'Mac', accessMode: 'local-only' }),
    listProjects: record('listProjects', [{ projectId: 'p1', name: 'Praxis' }]),
    getProject: async id => { calls.push(['getProject', id]); return id === 'p1' ? { projectId: id, name: 'Praxis' } : undefined; },
    getSession: async id => { calls.push(['getSession', id]); return id === 's1' ? snapshot : undefined; },
    getRun: async id => { calls.push(['getRun', id]); return id === 'r1' ? { runId: id, projectId: 'p1' } : undefined; },
    listSessions: record('listSessions', []), createSession: record('createSession', snapshot),
    configureSession: record('configureSession', snapshot),
    sessionImagePreview: record('sessionImagePreview', undefined),
    findGadget: (id, gadgetId) => { calls.push(['findGadget', id, gadgetId]); return config.noGadget ? undefined
      : { ...gadget, ...(config.approval ? { kind: 'approval', actions: [{ actionId: 'answer', effect: 'approval' }] } : {}) }; },
    submitGadget: record('submitGadget', { status: config.gadgetStatus || 'completed' }),
  };
  for (const name of ['listWork', 'listWorkflows', 'listRuns', 'listRunChanges', 'sessionChanges', 'sessionFileDiff',
    'listAttention', 'startRun', 'cancelRun', 'retryStage', 'approveRun', 'rejectRun', 'continueSession', 'cancelSession', 'respondToPermission']) {
    deps[name] = async (...args) => { calls.push([name, ...args]); if (name === 'startRun' && config.startError) throw new Error(config.startError); return { ok: name }; };
  }
  if (config.schedules) deps.schedules = Object.fromEntries(['list', 'save', 'setArmed', 'resolveMissed'].map(name => [name, record(`schedules.${name}`, name === 'list' ? [schedule] : schedule)]));
  return deps;
}
(async () => {
  const { createMobileHostReads, createMobileHostExecutionHandlers } = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
  for (const item of cases) {
    const calls = [];
    const deps = dependencies(item.config, calls);
    const commands = createMobileHostExecutionHandlers(deps);
    const handlers = item.kind === 'read' ? createMobileHostReads(deps, Object.keys(commands)) : commands;
    try { item.expected = { value: await handlers[item.request.operation](item.request) }; }
    catch (error) { item.expected = { error: error.message }; }
    item.calls = calls;
  }
  fs.writeFileSync(path.join(__dirname, 'ts_host_services.json'), JSON.stringify({
    source: 'apps/praxis-desktop/main/src/main/mobileHostServices.ts',
    sourceSha256: require('node:crypto').createHash('sha256').update(source).digest('hex'),
    session, catalog, gadget, cases,
  }, null, 2) + '\n');
  console.log(`Generated ${cases.length} TypeScript host-service cases.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
