import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
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
  const secondPromise = app.electronApp.waitForEvent('window');
  await app.electronApp.evaluate(async ({ BrowserWindow }, paths) => {
    const win = new BrowserWindow({ width: 1300, height: 900, webPreferences: { preload: paths.preload, contextIsolation: true, nodeIntegration: false } });
    const require = process.getBuiltinModule('module')!.createRequire(paths.guard);
    require(paths.guard).attachRendererNavigationGuard(win, undefined);
    await win.loadURL(paths.url);
  }, { preload: path.resolve(__dirname, '../out/preload/index.js'), guard: path.resolve(__dirname, '../out/main/rendererNavigationGuard.js'), url: first.url() });
  const second = await secondPromise;
  await expect(second.getByTestId('team-chat-row')).toHaveCount(1);
  await second.getByTestId('team-chat-row').locator('.team-chat-main').click();
  await first.getByTestId('assistant-input').fill('First accepted question');
  await first.getByTestId('assistant-send').click();
  await expect(second.getByTestId('assistant-message-user')).toHaveText('First accepted question');
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
  const { subscribeConversation } = await import('../../renderer/src/assistant/conversationSubscription');
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
  await app.electronApp.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module')!.createRequire(modulePath);
    const coordinator = require(modulePath).getTeamChatCoordinator();
    const adapter = coordinator.executionAdapter;
    const execute = adapter.execute.bind(adapter);
    let failOnce = true;
    adapter.execute = async (params: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw new (require('@praxis/core').TeamChatAcceptanceUnknown)('Controlled unknown outcome');
      }
      return execute(params);
    };
  }, path.resolve(__dirname, '../out/main/assistantIpc.js'));
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

test('keyboard cancellation preserves accepted messages and cancels only the selected queued turn', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Should be cancelled', responseDelayMs: 5000 });
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
  await queued.getByRole('button', { name: 'Cancel queued turn' }).focus();
  await win.keyboard.press('Enter');
  await expect(queued).toHaveCount(0);
  await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
  await win.getByRole('button', { name: 'Stop', exact: true }).focus();
  await win.keyboard.press('Enter');
  await expect(win.getByTestId('assistant-turn-status')).toHaveCount(0);
  await expect(win.getByTestId('assistant-message-user')).toHaveText(['Active accepted message', 'Queued accepted message']);
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
  const conversation = (await win.evaluate(async () => {
    const chats = await window.praxis.assistant.listChats('');
    return window.praxis.assistant.getConversation(chats[0].id);
  }))!;
  expect(conversation.turns.map(turn => turn.state)).toEqual(['cancelled', 'cancelled']);
});

test('an unconfirmed submission retries its original command after both acknowledgements are lost', async () => {
  mock = await startMockOpenAiCompatibleServer({ reply: 'Accepted exactly once' });
  app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
  await app.electronApp.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> })._invokeHandlers;
    const handler = handlers.get('assistant:submitTurn')!;
    let calls = 0;
    ipcMain.removeHandler('assistant:submitTurn');
    ipcMain.handle('assistant:submitTurn', async (event, command) => {
      const result = await handler(event, command);
      if (++calls <= 2) throw new Error('Lost acceptance acknowledgement');
      return result;
    });
  });
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
