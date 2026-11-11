import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { launchTestApp, closeTestApp, type TestApp, notReproducible } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); if (mock) await mock.close(); app = undefined; mock = undefined; });

// Guards fail with renderer-owned saveChat scheduling: another window never sees accepted turns.
test('two windows converge, queue capture survives navigation and stale controls cannot cancel replacement work', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Durable answer', responseDelayMs: 1500 });
  app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
  const first = app.window;
  const chat = await first.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Durable project', key: 'DUR', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    return window.praxis.assistant.createChat(project.id);
  }, app.userDataDir);
  await first.reload();
  await expect(first.getByTestId('team-chat-row')).toHaveCount(1);
  await first.getByTestId('team-chat-row').locator('.team-chat-main').click();
  const second = await app.openWindow(first.url());
  await expect(second.getByTestId('team-chat-row')).toHaveCount(1);
  await second.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await first.getByTestId('assistant-input').fill('First accepted question');
  await first.getByTestId('assistant-send').click();
  await expect(second.getByTestId('assistant-message-user')).toHaveText('First accepted question');
  // The other window shows which member is answering, not just that something is.
  await expect(second.getByTestId('assistant-turn-status')).toContainText('dev: running');
  await first.getByTestId('assistant-input').fill('Queued original context');
  await first.getByTestId('assistant-send').click();
  await expect(second.getByTestId('assistant-message-user')).toHaveCount(2);
  await expect(second.getByTestId('assistant-turn-status').filter({ hasText: 'Queued' })).toHaveCount(1);
  const queueArtifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/durable-team-chat-queue.png');
  fs.mkdirSync(path.dirname(queueArtifact), { recursive: true });
  await second.screenshot({ path: queueArtifact });
  const snapshot = await second.evaluate(id => window.praxis.assistant.getConversation(id), chat.id);
  await first.getByTestId('assistant-new-chat').click();
  await expect(first.getByTestId('assistant-message-user')).toHaveCount(0);
  await expect(second.getByTestId('assistant-message-dev')).toHaveCount(2, { timeout: 20000 });
  const stale = await second.evaluate(async ({ id, revision, turnId }) => window.praxis.assistant.control({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: revision, turnId, action: 'cancel' }), { id: chat.id, revision: snapshot!.revision, turnId: snapshot!.turns[0].id });
  expect(stale.turns.every(turn => turn.state === 'completed')).toBe(true);
  const staleTyped = await second.evaluate(async ({ id, revision, turnId }) => window.praxis.assistant.cancelTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: revision, turnId }), { id: chat.id, revision: snapshot!.revision, turnId: snapshot!.turns[0].id });
  expect(staleTyped.status).toBe('conflict');
  expect(staleTyped.conversation.turns.every(turn => turn.state === 'completed')).toBe(true);
  await second.reload();
  await second.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await expect(second.getByTestId('assistant-message-dev')).toHaveCount(2);
  await expect(second.getByTestId('session-usage-summary')).toContainText('50 tok');
  await expect(second.getByTestId('team-chat-row')).toHaveCount(1);
  await second.getByRole('button', { name: 'Pin decision', exact: true }).first().focus();
  await second.keyboard.press('Enter');
  await expect(second.getByRole('button', { name: 'Unpin decision', exact: true })).toHaveCount(1);
  await second.getByRole('button', { name: 'Unpin decision', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Unpin decision', exact: true })).toHaveCount(0);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/durable-team-chat-two-windows.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await second.screenshot({ path: artifact });
});

// Subscribe-before-snapshot is a transport contract, exercised without a provider.
test('subscription buffers a racing revision and discards responses after selection changes', async () => {
  const { subscribeConversation } = await import('../renderer/src/assistant/conversationSubscription');
  let listener!: (update: import('@praxis/core').ConversationUpdate) => void;
  let firstRead!: (snapshot: import('@praxis/core').DurableConversation) => void;
  let reads = 0;
  let unsubscribed = false;
  const published: number[] = [];
  const bridge = {
    subscribeConversation: (_id: string, callback: typeof listener) => { listener = callback; return () => { unsubscribed = true; }; },
    getConversation: async () => {
      reads++;
      if (reads === 1) return new Promise<import('@praxis/core').DurableConversation>(resolve => { firstRead = resolve; });
      return { id: 'one', revision: 5 } as import('@praxis/core').DurableConversation;
    }
  } as unknown as import('@praxis/core').AssistantIpc;
  const dispose = subscribeConversation(bridge, 'one', snapshot => published.push(snapshot!.revision), error => { throw error; });
  listener({ conversationId: 'one', revision: 5, type: 'turn_accepted' });
  firstRead({ id: 'one', revision: 3 } as import('@praxis/core').DurableConversation);
  await expect.poll(() => published).toEqual([3, 5]);
  listener({ conversationId: 'one', revision: 4, type: 'turn_accepted' });
  expect(reads).toBe(2);
  dispose();
  expect(unsubscribed).toBe(true);
  let release!: (snapshot: import('@praxis/core').DurableConversation) => void;
  bridge.getConversation = () => new Promise(resolve => { release = resolve; });
  const cancelled = subscribeConversation(bridge, 'two', () => { throw new Error('Stale selection published.'); }, error => { throw error; });
  cancelled();
  release({ id: 'two', revision: 9 } as import('@praxis/core').DurableConversation);
  await Promise.resolve();
});

test('unknown outcome requires recorded reconciliation and acknowledged retry, then converges to a committed reply', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Recovered answer' });
  app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
  notReproducible('injects a fault into the team-chat execution adapter or the main-process fs.promises, which are Electron-main internals; the Rust backend has no equivalent fault-injection hook');
  const win = app.window;
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-input').fill('Recover this accepted message');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-turn-status')).toContainText('outcome unknown');
  const retry = win.getByRole('button', { name: 'Retry dev', exact: true });
  await expect(retry).toBeDisabled();
  await win.getByLabel('What did you check before retrying?').fill('Inspected the mock service: no external mutations occurred.');
  await win.getByRole('button', { name: 'Record reconciliation' }).click();
  await expect(retry).toBeDisabled();
  await win.getByRole('checkbox', { name: /Retry may repeat external actions/ }).check();
  await expect(retry).toBeEnabled();
  await retry.focus();
  await win.keyboard.press('Enter');
  await expect(win.getByTestId('assistant-message-dev')).toContainText('Recovered answer');
  await expect(win.getByTestId('assistant-message-user')).toHaveCount(1);
  const conversation = (await win.evaluate(async () => {
    const chats = await window.praxis.assistant.listChats('');
    return window.praxis.assistant.getConversation(chats[0].id);
  }))!;
  expect(conversation.turns[0].attempts).toHaveLength(2);
  expect(conversation.turns[0].attempts[0].recoveryEvidence?.some(e => e.kind === 'decision' && e.data?.acknowledgeDuplicateActionRisk === true)).toBe(true);
});

test('a migrated chat continues from imported history without reusing unproved runtime identity', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Continued imported history' });
  app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const file = path.join(reuse.userDataDir, 'team-chats.json');
  const original = JSON.stringify({ teamChats: [{ id: 'legacy-fixture', projectId: '', title: 'Imported chat', createdAt: '2026-01-01', updatedAt: '2026-01-02', messages: [
    { id: 'orphan', role: 'dev', text: 'Orphan history retained', createdAt: '2026-01-01', error: true },
    { id: 'old-user', role: 'user', text: 'Original decision sentinel', createdAt: '2026-01-02' }
  ] }] });
  fs.writeFileSync(file, original);
  fs.rmSync(`${file}.v1-backup`, { force: true }); // this disposable fixture predates activation
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const win = app.window;
  expect(await win.evaluate(async () => (await window.praxis.assistant.listChats('')).map(chat => chat.id))).toEqual(['legacy-fixture']);
  const before = (await win.evaluate(() => window.praxis.assistant.getConversation('legacy-fixture')))!;
  expect(before.turns).toHaveLength(0);
  expect(before.bindings).toHaveLength(0);
  expect(before.messages[0].provenance).toBe('imported-unknown');
  expect(before.legacyRuntimeLinks).toBeUndefined(); // no runtime session evidence, so nothing to link
  await win.evaluate(async revision => window.praxis.assistant.submitTurn({ conversationId: 'legacy-fixture', commandId: 'continued', expectedRevision: revision,
    text: 'Continue the original decision', selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: { provider: 'custom:mock', model: 'mock-model', toolMode: 'project-only' } }), before.revision);
  await expect.poll(() => win.evaluate(async () => (await window.praxis.assistant.getConversation('legacy-fixture'))?.turns[0].state)).toBe('completed');
  const after = (await win.evaluate(() => window.praxis.assistant.getConversation('legacy-fixture')))!;
  expect(after.messages).toHaveLength(4);
  expect(after.turns[0].attempts).toHaveLength(1);
  expect(mock.requests.some(request => request.body.includes('Original decision sentinel') && request.body.includes('Orphan history retained'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(`${file}.v1-backup`, 'utf8')).original).toBe(original);
  await win.reload();
  expect(await win.evaluate(async () => (await window.praxis.assistant.listChats('')).length)).toBe(1);
});

test('an expired legacy runtime session is linked, reconstructed and listed once', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Continued after the legacy session expired' });
  const settings = { ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } };
  app = await launchTestApp(settings, undefined, undefined, { openNewSession: false });
  const projectId = await app.window.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Legacy project', key: 'LEG', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    return project.id;
  }, app.userDataDir);
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  // The pre-durable shape: a saved chat, the runtime session main keyed from its id, and that
  // session's transcript checkpoint naming the dev reply it last saw. The session is long finished.
  const title = 'Legacy linked chat';
  fs.writeFileSync(path.join(reuse.userDataDir, 'team-chats.json'), JSON.stringify({ teamChats: [{ id: 'legacy-linked', projectId, title,
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:02:00.000Z', messages: [
      { id: 'old-user', role: 'user', text: 'Legacy reconstruction sentinel', createdAt: '2026-09-01T09:00:00.000Z' },
      { id: 'old-dev', role: 'dev', text: 'Legacy dev answer sentinel', createdAt: '2026-09-01T09:02:00.000Z' }] }] }, null, 2));
  const linkedKey = 'ASSISTANT-legacy-linked-dev-0123456789abcdef';
  // An unsaved chat's random prefix whose goal text equals the saved title: never proof.
  const strayKey = 'ASSISTANT-6f1d2c3b-0a9e-4e7d-8c6b-5a4f3e2d1c0b-dev-fedcba9876543210';
  const record = (issueKey: string, sessionId: string) => ({ issueKey, sessionId, title: 'Virtual Team conversation', provider: 'custom:mock', model: 'mock-model',
    state: 'completed', startedAt: '2026-09-01T09:00:00.000Z', completedAt: '2026-09-01T09:02:00.000Z', workingDirectory: reuse.userDataDir, toolMode: 'read-only', stepCount: 1, eventCount: 1,
    taskDefinition: { kind: 'general', sessionMode: 'chat', goal: title, scope: '', definitionOfDone: 'Respond to the Virtual Team chat with the result.' }, events: [] });
  fs.writeFileSync(path.join(reuse.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
    [linkedKey]: record(linkedKey, 'legacy-linked-session'), [strayKey]: record(strayKey, 'legacy-stray-session') } }));
  fs.mkdirSync(path.join(reuse.userDataDir, 'ai-transcripts'), { recursive: true });
  for (const [sessionId, detail] of [['legacy-linked-session', 'old-dev'], ['legacy-stray-session', 'old-dev']]) {
    fs.writeFileSync(path.join(reuse.userDataDir, 'ai-transcripts', `${sessionId}.json`), JSON.stringify({ events: [
      { type: 'info', timestamp: '2026-09-01T09:02:00.000Z', summary: 'Virtual Team transcript checkpoint', detail }] }));
  }
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const win = app.window;
  const before = (await win.evaluate(() => window.praxis.assistant.getConversation('legacy-linked')))!;
  expect(before.bindings).toEqual([]);
  expect(before.legacyRuntimeLinks).toEqual([{ runtimeSessionKey: linkedKey, conversationId: 'legacy-linked', participantId: 'part-dev', role: 'dev',
    provider: 'custom:mock', legacyConfigurationDigest: '0123456789abcdef', checkpointMessageId: 'old-dev', status: 'imported' }]);
  const stored = JSON.parse(fs.readFileSync(path.join(reuse.userDataDir, 'team-chats.json'), 'utf8'));
  expect(stored.conversations).toHaveLength(1); // the title match merged nothing
  expect(stored.legacyRuntimeDiagnostics).toEqual([{ runtimeSessionKey: strayKey, reason: 'unknown-conversation' }]);

  await win.evaluate(async revision => window.praxis.assistant.submitTurn({ conversationId: 'legacy-linked', commandId: 'after-expiry', expectedRevision: revision,
    text: 'Continue after expiry', selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: { provider: 'custom:mock', model: 'mock-model', toolMode: 'project-only' } }), before.revision);
  await expect.poll(() => win.evaluate(async () => (await window.praxis.assistant.getConversation('legacy-linked'))?.turns[0]?.state)).toBe('completed');
  const after = (await win.evaluate(() => window.praxis.assistant.getConversation('legacy-linked')))!;
  // Reconstruction: the new attempt carried the imported history rather than relying on the expired session.
  expect(mock.requests.some(request => request.body.includes('Legacy reconstruction sentinel') && request.body.includes('Legacy dev answer sentinel'))).toBe(true);
  expect(after.bindings.every(binding => binding.id !== linkedKey && binding.providerSessionId !== 'legacy-linked-session')).toBe(true);
  expect(after.legacyRuntimeLinks).toEqual(before.legacyRuntimeLinks);
  expect(after.messages.filter(message => message.role === 'dev').map(message => message.text)).toEqual(['Legacy dev answer sentinel', 'Continued after the legacy session expired']);

  const listedOnce = async () => {
    await expect(win.getByTestId('team-chat-row')).toHaveCount(1);
    await expect(win.getByTestId('team-chat-row')).toContainText(title);
    await expect(win.locator('[data-session-order-id^="ASSISTANT-"]')).toHaveCount(0);
    const sessions = await win.evaluate(() => window.praxis.ai.listSessions());
    expect(sessions.filter(session => session.issueKey === linkedKey || session.issueKey === strayKey)).toHaveLength(2); // records kept
  };
  await win.reload();
  await listedOnce();
  await win.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(2);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/task-485-migrated-chat.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await win.screenshot({ path: artifact });
  await win.reload();
  await listedOnce();
});

test('keyboard cancellation preserves accepted messages and cancels only the selected queued turn', async () => {
  let releaseReply!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseReply = resolve; });
  mock = await startMockOpenAiCompatibleServer({ reply: 'Should be cancelled', responseGate });
  try {
    app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
    const win = app.window;
    await win.getByTestId('titlebar-assistant').click();
    await win.getByTestId('assistant-input').fill('Active accepted message');
    await win.getByTestId('assistant-send').click();
    await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
    await win.getByTestId('assistant-input').fill('Queued accepted message');
    await win.getByTestId('assistant-send').click();
    const queued = win.getByTestId('assistant-turn-status').filter({ hasText: 'Queued' });
    await expect(queued).toHaveCount(1);
    // Electron's native keyboard target can belong to another concurrently launched window.
    await win.bringToFront();
    await queued.getByRole('button', { name: 'Cancel queued turn' }).press('Enter');
    await expect(queued).toHaveCount(0);
    await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
    await win.bringToFront();
    await win.getByRole('button', { name: 'Stop', exact: true }).press('Enter');
    await expect(win.getByTestId('assistant-turn-status')).toHaveCount(0);
    await expect(win.getByTestId('assistant-message-user')).toHaveText(['Active accepted message', 'Queued accepted message']);
    await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
    const conversation = (await win.evaluate(async () => {
      const chats = await window.praxis.assistant.listChats('');
      return window.praxis.assistant.getConversation(chats[0].id);
    }))!;
    expect(conversation.turns.map(turn => turn.state)).toEqual(['cancelled', 'cancelled']);
  } finally { releaseReply(); }
});

test('an unconfirmed submission retries its original command after both acknowledgements are lost', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Accepted exactly once' });
  app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
  {
    let calls = 0;
    await app.overrideChannel('assistant:submitTurn', async ([command], backend) => {
      const result = await backend.call('assistant:submitTurn', command);
      if (++calls <= 2) throw new Error('Lost acceptance acknowledgement');
      return result;
    });
  }
  const win = app.window;
  await win.getByTestId('titlebar-assistant').click();
  const input = win.getByTestId('assistant-input');
  await input.fill('One logical submission');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByRole('alert')).toContainText('Lost acceptance acknowledgement');
  await expect(input).toHaveValue('One logical submission');
  await expect(win.getByTestId('assistant-message-dev')).toContainText('Accepted exactly once');
  await win.getByTestId('assistant-send').click();
  await expect(input).toHaveValue('');
  await expect(win.getByRole('alert')).toHaveCount(0);
  const conversation = (await win.evaluate(async () => {
    const chats = await window.praxis.assistant.listChats('');
    return window.praxis.assistant.getConversation(chats[0].id);
  }))!;
  expect(conversation.turns).toHaveLength(1);
  expect(conversation.commandReceipts).toHaveLength(1);
  expect(conversation.messages.filter(message => message.role === 'user')).toHaveLength(1);
});

function mockSettings(server: MockOpenAiCompatibleServer) {
  return { ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: server.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } };
}
const completions = (server: MockOpenAiCompatibleServer) => server.requests.filter(request => request.url.endsWith('/chat/completions')).length;
type DiskSnapshot = { revision: number; conversations: import('@praxis/core').DurableConversation[] };
/** What is durable on disk, read without asking the app (which would itself trigger recovery). */
function onDisk(userDataDir: string): DiskSnapshot {
  const file = path.join(userDataDir, 'team-chats.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { revision: 0, conversations: [] };
}
/** A crash, not a clean quit: no shutdown handler gets to settle anything. */
async function crash(current: TestApp): Promise<{ userDataDir: string; settingsPath: string }> {
  const child = current.electronApp.process();
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return { userDataDir: current.userDataDir, settingsPath: current.settingsPath };
}

test('an app restart mid-reply leaves the turn for the user to resolve; nothing is replayed', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Never delivered', responseDelayMs: 60000 });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const win = app.window;
  await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Restart project', key: 'RST', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    await window.praxis.assistant.createChat(project.id);
  }, app.userDataDir);
  await win.reload();
  await win.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await win.getByTestId('assistant-input').fill('Interrupted question');
  await win.getByTestId('assistant-send').click();
  await expect.poll(() => completions(mock!)).toBe(1);
  await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
  const reuse = await crash(app);
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  // Startup reconciles on its own; the chat has not been opened in this process yet.
  await expect.poll(() => onDisk(reuse.userDataDir).conversations[0]?.turns[0]?.state).toBe('interrupted');
  const turn = onDisk(reuse.userDataDir).conversations[0].turns[0];
  expect(turn.attempts).toHaveLength(1);
  expect(turn.attempts[0].recoveryEvidence?.some(e => e.kind === 'reconciliation' && e.provenance === 'coordinator-startup')).toBe(true);
  await app.window.waitForTimeout(1500);
  expect(completions(mock)).toBe(1);
  const again = app.window;
  await again.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await expect(again.getByTestId('assistant-message-user')).toHaveText('Interrupted question');
  await expect(again.getByTestId('assistant-turn-status')).toContainText('dev: interrupted');
  await expect(again.getByRole('button', { name: 'Retry dev', exact: true })).toBeEnabled();
  expect(completions(mock)).toBe(1);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/fx-be-184-restart-interrupted.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await again.screenshot({ path: artifact });
});

test('a queued turn resumes after restart before any chat is opened', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Resumed after restart' });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const chat = await app.window.evaluate(() => window.praxis.assistant.createChat(''));
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  // The bytes a crash leaves right after durable acceptance and before any dispatch.
  const core = await import('@praxis/core');
  const file = path.join(reuse.userDataDir, 'team-chats.json');
  const snapshot = onDisk(reuse.userDataDir);
  const conversation = snapshot.conversations.find(c => c.id === chat.id)!;
  const command = { conversationId: chat.id, commandId: 'accepted-before-crash', expectedRevision: conversation.revision, text: 'Queued before the crash',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: { provider: 'custom:mock', model: 'mock-model', toolMode: 'project-only' } };
  conversation.revision++;
  conversation.turns.push({ id: 'turn-before-crash', commandId: command.commandId, payloadDigest: core.conversationPayloadDigest(command), userMessageId: 'message-before-crash',
    acceptedSequence: 1, state: 'queued', completedParticipantIds: [], attempts: [],
    plan: { participants: [conversation.participants.find(p => p.role === 'lead')!], runtimeOptions: command.runtimeOptions } });
  conversation.messages.push({ id: 'message-before-crash', turnId: 'turn-before-crash', role: 'user', text: command.text, createdAt: new Date().toISOString(), sequence: 1, attachments: [] });
  conversation.commandReceipts.push({ commandId: command.commandId, payloadDigest: core.conversationPayloadDigest(command), turnId: 'turn-before-crash', revision: conversation.revision, outcome: 'accepted' });
  snapshot.revision++;
  fs.writeFileSync(file, JSON.stringify(snapshot));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  // Nothing in the UI asks for the chat; the provider is reached because startup resumed the queue.
  await expect.poll(() => completions(mock!), { timeout: 15000 }).toBe(1);
  await expect.poll(() => onDisk(reuse.userDataDir).conversations.find(c => c.id === chat.id)?.turns[0].state).toBe('completed');
  const settled = onDisk(reuse.userDataDir).conversations.find(c => c.id === chat.id)!;
  expect(settled.messages.map(m => m.text)).toEqual(['Queued before the crash', 'Resumed after restart']);
  expect(settled.turns[0].attempts).toHaveLength(1);
  expect(mock.requests.at(-1)!.body).toContain('Queued before the crash');
});

test('a storage write failure is shown and the accepted transcript remains', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'First durable reply' });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const win = app.window;
  await win.getByTestId('titlebar-assistant').click();
  const input = win.getByTestId('assistant-input');
  await input.fill('Before the disk filled');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toContainText('First durable reply');
  const committed = fs.readFileSync(path.join(app.userDataDir, 'team-chats.json'), 'utf8');
  // Fail every team-chat temp-file write in main, the way a full disk does.
  notReproducible('injects a fault into the team-chat execution adapter or the main-process fs.promises, which are Electron-main internals; the Rust backend has no equivalent fault-injection hook');
  await input.fill('Lost to a full disk');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByRole('alert')).toContainText('ENOSPC');
  await expect(input).toHaveValue('Lost to a full disk');
  await expect(win.getByTestId('assistant-message-user')).toHaveText(['Before the disk filled']);
  await expect(win.getByTestId('assistant-message-dev')).toContainText('First durable reply');
  expect(fs.readFileSync(path.join(app.userDataDir, 'team-chats.json'), 'utf8')).toBe(committed);
  expect(fs.readdirSync(app.userDataDir).filter(name => name.startsWith('team-chats.json.') && name.endsWith('.tmp'))).toEqual([]);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/fx-be-184-storage-failure.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await win.screenshot({ path: artifact });
  notReproducible('restores the main-process fs.promises patch installed earlier');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-user')).toHaveText(['Before the disk filled', 'Lost to a full disk']);
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(2);
  // Post-dispatch commit failure after the renderer has already loaded the attempt_running revision.
  notReproducible('injects a fault into the team-chat execution adapter or the main-process fs.promises, which are Electron-main internals; the Rust backend has no equivalent fault-injection hook');
  await input.fill('Halted on completion write');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByRole('alert')).toContainText('ENOSPC: completion write failed Restart Praxis to recover this team chat.');
  notReproducible('restores the main-process fs.promises patch installed earlier');
  await input.fill('Queued behind halted turn');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-turn-status').filter({ hasText: 'Queued' })).toHaveCount(1);
  await expect(win.getByRole('alert')).toContainText('ENOSPC: completion write failed Restart Praxis to recover this team chat.');
});

test('re-opening a team chat whose first load failed reads its transcript again', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Kept on disk' });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const win = app.window;
  await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Reload project', key: 'RLD', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    await window.praxis.assistant.createChat(project.id);
  }, app.userDataDir);
  await win.reload();
  const row = win.getByTestId('team-chat-row').locator('.team-chat-main');
  await row.click();
  await win.getByTestId('assistant-input').fill('Remember this');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toContainText('Kept on disk');
  // The next transcript read fails once, as a transient IPC or disk fault would.
  {
    await app.overrideChannel('assistant:getConversation', async () => {
      await app!.restoreChannel('assistant:getConversation');
      throw new Error('Transient read failure');
    });
  }
  await win.reload();
  await row.click();
  await expect(win.getByRole('alert')).toContainText('Transient read failure');
  await expect(win.getByTestId('assistant-message-user')).toHaveCount(0);
  // Same id again: a failed load must not be mistaken for an open transcript.
  await row.click();
  await expect(win.getByTestId('assistant-message-user')).toHaveText('Remember this');
  await expect(win.getByTestId('assistant-message-dev')).toContainText('Kept on disk');
});

// TASK-477: unreadable storage is a recoverable error, never an empty chat list and never rewritten.
test('a malformed team-chat file is shown as a recoverable error and never replaced', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Unused' });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const win = app.window;
  await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Corrupt project', key: 'COR', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    await window.praxis.assistant.createChat(project.id);
  }, app.userDataDir);
  await win.reload();
  await expect(win.getByTestId('team-chat-row')).toHaveCount(1);
  const file = path.join(app.userDataDir, 'team-chats.json');
  const valid = fs.readFileSync(file, 'utf8');
  const siblings = () => fs.readdirSync(app!.userDataDir).filter(name => name.startsWith('team-chats.json.')).sort();
  const siblingsBefore = siblings();
  fs.writeFileSync(file, '{broken');
  await win.reload();
  const storageAlert = win.getByTestId('team-chat-storage-error');
  await expect(storageAlert).toBeVisible();
  await expect(storageAlert).toContainText("Team chats can't be read. The file was left unchanged.");
  await expect(storageAlert).toContainText('Cannot read team chat storage');
  await expect(win.getByTestId('team-chat-row')).toHaveCount(0);
  // Sending from the assistant is refused with the same storage error, not accepted over an empty list.
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-input').fill('Must not replace the file');
  await win.getByTestId('assistant-send').click();
  await expect(win.locator('[role="alert"]').filter({ hasText: 'Cannot read team chat storage' }).first()).toBeVisible();
  await expect(win.getByTestId('assistant-message-user')).toHaveCount(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  expect(siblings(), 'no temp file, backup or replacement is written beside the malformed file').toEqual(siblingsBefore);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/task-477-corrupt-storage.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await win.screenshot({ path: artifact });
  // Repairing the file and retrying brings the chat back without a restart.
  fs.writeFileSync(file, valid);
  await win.getByTestId('team-chat-storage-retry').click();
  await expect(storageAlert).toHaveCount(0);
  await expect(win.getByTestId('team-chat-row')).toHaveCount(1);
});

test('a tool member\'s pending permission is attached to its attempt and a restart never reuses the approval', async () => {
  const promptLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-acp-prompts-')), 'prompts.jsonl');
  const env = { FAKE_ACP_PROMPT_LOG: promptLog };
  const prompts = () => fs.existsSync(promptLog) ? fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  try {
    app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } }, undefined, env, { openNewSession: false });
    const win = app.window;
    const id = await win.evaluate(async folder => {
      const chat = await window.praxis.assistant.createChat('');
      const snapshot = await window.praxis.assistant.getConversation(chat.id);
      await window.praxis.assistant.submitTurn({ conversationId: chat.id, commandId: crypto.randomUUID(), expectedRevision: snapshot!.revision,
        text: 'WITH_PERMISSION read the notes', selectedParticipantIds: ['part-dev'], attachmentRefs: [],
        runtimeOptions: { provider: 'claude-code-cli', toolMode: 'read-only', permissionMode: 'manual', workingDirectory: folder } });
      return chat.id;
    }, app.userDataDir);
    await expect.poll(async () => (await win.evaluate(() => window.praxis.ai.listSessions())).find(s => s.teamChatExecution)?.state, { timeout: 20000 }).toBe('awaiting_approval');
    const pending = (await win.evaluate(() => window.praxis.ai.listSessions())).find(s => s.teamChatExecution)!;
    const attempt = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!.turns[0].attempts.at(-1)!;
    expect(pending.teamChatExecution!.conversationId).toBe(id);
    expect(pending.teamChatExecution!.attemptId).toBe(attempt.id);
    expect(prompts()).toBe(1);
    const reuse = await crash(app);
    app = await launchTestApp(undefined, reuse, env, { openNewSession: false });
    await expect.poll(() => onDisk(reuse.userDataDir).conversations.find(c => c.id === id)?.turns[0].state).toBe('outcome_unknown');
    const recovered = onDisk(reuse.userDataDir).conversations.find(c => c.id === id)!.turns[0];
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.attempts[0].state).toBe('outcome_unknown');
    await app.window.waitForTimeout(1500);
    expect(prompts()).toBe(1);
    const sessions = await app.window.evaluate(() => window.praxis.ai.listSessions());
    expect(sessions.filter(s => s.state === 'awaiting_approval')).toEqual([]);
  } finally {
    fs.rmSync(path.dirname(promptLog), { recursive: true, force: true });
  }
});

test('a CLI member without resume capability reconstructs context on its second turn', async () => {
  const promptLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-acp-prompts-')), 'prompts.jsonl');
  try {
    // No FAKE_ACP_REPLAY_ON_RESUME: the agent advertises no session resume capability.
    app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } }, undefined, { FAKE_ACP_PROMPT_LOG: promptLog }, { openNewSession: false });
    const win = app.window;
    const id = await win.evaluate(() => window.praxis.assistant.createChat('').then(chat => chat.id));
    for (const text of ['FIRST_TURN_SENTINEL remember this', 'SECOND_TURN what did I ask first?']) {
      await win.evaluate(async ({ id, text, folder }) => {
        const snapshot = await window.praxis.assistant.getConversation(id);
        await window.praxis.assistant.submitTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot!.revision,
          text, selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: { provider: 'claude-code-cli', toolMode: 'read-only', workingDirectory: folder } });
      }, { id, text, folder: app.userDataDir });
      await expect.poll(() => win.evaluate(async id => (await window.praxis.assistant.getConversation(id))?.turns.at(-1)?.state, id), { timeout: 20000 }).toBe('completed');
    }
    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { promptText: string });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].promptText).toContain('SECOND_TURN');
    expect(prompts[1].promptText).toContain('FIRST_TURN_SENTINEL');
    const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
    const firstTurnIds = conversation.messages.filter(m => m.turnId === conversation.turns[0].id).map(m => m.id);
    expect(firstTurnIds).toHaveLength(2);
    for (const messageId of firstTurnIds) expect(conversation.turns[1].attempts[0].contextReceipt.messageIds).toContain(messageId);
  } finally {
    fs.rmSync(path.dirname(promptLog), { recursive: true, force: true });
  }
});

test('queued page context and staged image reach the provider after navigation and composer replacement', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-queued-image-'));
  const promptLog = path.join(folder, 'prompts.jsonl');
  try {
    app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } }, undefined,
      { FAKE_ACP_PROMPT_LOG: promptLog }, { openNewSession: false });
    const win = app.window;
    const id = await win.evaluate(() => window.praxis.assistant.createChat('').then(chat => chat.id));
    // Hold the first dispatch without using a timing assumption about provider speed.
    notReproducible('injects a fault into the team-chat execution adapter or the main-process fs.promises, which are Electron-main internals; the Rust backend has no equivalent fault-injection hook');
    const original = await win.evaluate(async ({ id, folder }) => {
      const runtimeOptions = { provider: 'claude-code-cli' as const, toolMode: 'read-only' as const, workingDirectory: folder };
      const submit = async (text: string, attachmentRefs: import('@praxis/core').ConversationAttachment[] = [], context?: import('@praxis/core').SubmitConversationCommand['context']) => {
        const snapshot = (await window.praxis.assistant.getConversation(id))!;
        return window.praxis.assistant.submitTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot.revision,
          text, selectedParticipantIds: ['part-dev'], attachmentRefs, runtimeOptions, ...(context ? { context } : {}) });
      };
      await submit('First queued-image test turn');
      const refs = await window.praxis.assistant.stageAttachments(id, [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }]);
      await submit('IMAGE_ECHO captured question', refs, { pageType: 'issue', entityId: 'ORIGINAL-184', title: 'Original issue', summary: 'Captured page sentinel' });
      // A later composer image is staged, but was never attached to this accepted turn.
      await window.praxis.assistant.stageAttachments(id, [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]);
      return refs;
    }, { id, folder });
    const queued = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
    expect(queued.turns[1].state).toBe('queued');
    await win.reload();
    notReproducible('injects a fault into the team-chat execution adapter or the main-process fs.promises, which are Electron-main internals; the Rust backend has no equivalent fault-injection hook');
    await expect.poll(() => win.evaluate(async id => (await window.praxis.assistant.getConversation(id))?.turns[1].state, id), { timeout: 20000 }).toBe('completed');
    const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
    const message = conversation.messages.find(message => message.id === conversation.turns[1].userMessageId)!;
    expect(message.attachments).toEqual(original);
    expect(conversation.turns[1].plan.context?.entityId).toBe('ORIGINAL-184');
    expect(conversation.messages.at(-1)?.text).toContain('IMAGES_RECEIVED:1:image/png');
    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { promptText: string });
    expect(prompts).toHaveLength(2);
    expect(prompts[0].promptText).not.toContain('Captured page sentinel');
    expect(prompts[1].promptText).toContain('Captured page sentinel');
  } finally {
    if (app) await closeTestApp(app);
    app = undefined;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('closing the initiating window keeps its accepted turn and pending approval observable from another window', async () => {
  const promptLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-acp-prompts-')), 'prompts.jsonl');
  const env = { FAKE_ACP_PROMPT_LOG: promptLog };
  const prompts = () => fs.existsSync(promptLog) ? fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  try {
    app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } }, undefined, env, { openNewSession: false });
    const main = app.window;
    const chat = await main.evaluate(async folderPath => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create({ name: 'Durable project', key: 'DUR', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
      localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
      return window.praxis.assistant.createChat(project.id);
    }, app.userDataDir);
    await main.reload();
    await expect(main.getByTestId('team-chat-row')).toHaveCount(1);
    const extra = await app.openWindow(main.url());
    await extra.evaluate(async ({ id, folder }) => {
      const snapshot = await window.praxis.assistant.getConversation(id);
      await window.praxis.assistant.submitTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot!.revision,
        text: 'WITH_PERMISSION read the notes', selectedParticipantIds: ['part-dev'], attachmentRefs: [],
        runtimeOptions: { provider: 'claude-code-cli', toolMode: 'read-only', permissionMode: 'manual', workingDirectory: folder } });
    }, { id: chat.id, folder: app.userDataDir });
    await expect.poll(async () => (await main.evaluate(() => window.praxis.ai.listSessions())).find(s => s.teamChatExecution)?.state, { timeout: 20000 }).toBe('awaiting_approval');
    await extra.close();
    const attempt = (await main.evaluate(id => window.praxis.assistant.getConversation(id), chat.id))!.turns[0].attempts.at(-1)!;
    const pending = (await main.evaluate(() => window.praxis.ai.listSessions())).find(s => s.teamChatExecution)!;
    expect(pending.teamChatExecution!.attemptId).toBe(attempt.id);
    await main.getByTestId('team-chat-row').locator('.team-chat-main').click();
    await expect(main.getByTestId('assistant-tool-permission')).toBeVisible({ timeout: 15000 });
    const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/durable-team-chat-closed-initiator.png');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    await main.screenshot({ path: artifact });
    await main.getByTestId('assistant-tool-permission').getByRole('button', { name: 'Allow' }).click();
    await expect(main.getByTestId('assistant-message-dev')).toBeVisible({ timeout: 30000 });
    expect(prompts()).toBe(1);
  } finally {
    fs.rmSync(path.dirname(promptLog), { recursive: true, force: true });
  }
});

// TASK-487: the current request can never be summarised away, so one larger than the bounded
// window (32768 bytes less the 12288 reserve for a model with no known window) must pause.
test('an over-budget current request pauses as context_required; Recheck context stays actionable and Stop cancels it', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Must never be produced' });
  app = await launchTestApp(mockSettings(mock), undefined, undefined, { openNewSession: false });
  const win = app.window;
  const oversized = `Over budget request.${' context'.repeat(3000)}`;
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(32768 - 12288);
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-input').fill(oversized);
  await win.getByTestId('assistant-send').click();
  const status = win.getByTestId('assistant-turn-status');
  await expect(status).toContainText('context required');
  const recheck = win.getByTestId('assistant-turn-recheck-context');
  await expect(recheck).toBeEnabled();
  const readConversation = async () => (await win.evaluate(async () => {
    const chats = await window.praxis.assistant.listChats('');
    return window.praxis.assistant.getConversation(chats[0].id);
  }))!;
  const paused = await readConversation();
  expect(paused.turns[0].state).toBe('context_required');
  expect(paused.turns[0].contextRequiredReason).toContain('Bounded context');
  expect(paused.turns[0].attempts).toHaveLength(0);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/fx-be-184-context-required.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await win.screenshot({ path: artifact });
  // Recheck resumes the turn; the budget is unchanged, so it pauses again rather than inventing a reply.
  await recheck.focus();
  await win.keyboard.press('Enter');
  await expect.poll(async () => (await readConversation()).revision).toBeGreaterThan(paused.revision);
  await expect.poll(async () => (await readConversation()).turns[0].state).toBe('context_required');
  await expect(win.getByTestId('assistant-turn-recheck-context')).toBeEnabled();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
  expect(completions(mock)).toBe(0);
  await win.bringToFront();
  await status.getByRole('button', { name: 'Stop', exact: true }).press('Enter');
  await expect(status).toHaveCount(0);
  const settled = await readConversation();
  expect(settled.turns[0].state).toBe('cancelled');
  expect(settled.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual([oversized]);
  expect(completions(mock)).toBe(0);
});
