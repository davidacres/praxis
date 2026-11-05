/**
 * Real-provider proof for FX-BE-184 (durable team chat). Excluded from every ordinary run:
 * it spends real model calls on a real account.
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent e2e/durableTeamChat.live.spec.ts
 *
 * CLI check: PRAXIS_LIVE_AGENT_CMD (default `claude-agent-acp`) must be on PATH and signed in;
 * PRAXIS_LIVE_TEAM_CHAT_CLI_PROVIDER picks the Praxis provider id (default `claude-code-cli`).
 * API check: PRAXIS_LIVE_API_PROVIDER (a built-in API provider id) and PRAXIS_LIVE_API_KEY,
 * optionally PRAXIS_LIVE_API_MODEL. A missing credential is a skip with a reason, never a mock.
 *
 * Each check retains attempt ids, provider session ids and context receipts under
 * `.praxis/session-artifacts/durable-team-chat-live-*.json`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const TURN_MS = 240000;
const ARTIFACTS = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
const CLI_PROVIDER = process.env.PRAXIS_LIVE_TEAM_CHAT_CLI_PROVIDER ?? 'claude-code-cli';
const CLI_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';
const API_PROVIDER = process.env.PRAXIS_LIVE_API_PROVIDER;
const API_KEY = process.env.PRAXIS_LIVE_API_KEY;

let app: TestApp | undefined;

function commandAvailable(command: string): boolean {
  const probe = process.platform === 'win32' ? ['where', command] : ['which', command];
  return Boolean(command) && spawnSync(probe[0], probe.slice(1), { encoding: 'utf8' }).status === 0;
}

test.beforeAll(() => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'Set PRAXIS_LIVE_AGENT=1 to spend real model calls.');
});
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

async function send(win: Page, id: string, text: string, runtimeOptions: Record<string, string>): Promise<void> {
  await win.evaluate(async ({ id, text, runtimeOptions }) => {
    const snapshot = await window.praxis.assistant.getConversation(id);
    await window.praxis.assistant.submitTurn({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: snapshot!.revision,
      text, selectedParticipantIds: ['part-dev', 'part-lead'], attachmentRefs: [], runtimeOptions });
  }, { id, text, runtimeOptions });
  await expect.poll(() => win.evaluate(async id => (await window.praxis.assistant.getConversation(id))?.turns.at(-1)?.state, id),
    { timeout: TURN_MS, intervals: [1000] }).toMatch(/completed|failed|interrupted|outcome_unknown|context_required/);
  const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
  const turn = conversation.turns.at(-1)!;
  expect(turn.state, JSON.stringify(turn.attempts.at(-1)?.error ?? turn.contextRequiredReason ?? turn.state)).toBe('completed');
}

/** Two turns with a pinned decision, a full app restart, then a third turn that must recall it. */
async function continuationAcrossRestart(label: string, seed: Record<string, unknown>, configure: (win: Page) => Promise<void>,
  runtimeOptions: Record<string, string>): Promise<void> {
  const codename = `heron-${Math.random().toString(36).slice(2, 7)}`;
  app = await launchTestApp(seed, undefined, undefined, { openNewSession: false });
  await configure(app.window);
  let win = app.window;
  const id = await win.evaluate(() => window.praxis.assistant.createChat('').then(chat => chat.id));
  await send(win, id, `Decision for this chat: the release codename is ${codename}. Reply with one short sentence acknowledging it. Do not use tools.`, runtimeOptions);
  await win.evaluate(async id => {
    const conversation = (await window.praxis.assistant.getConversation(id))!;
    await window.praxis.assistant.control({ conversationId: id, commandId: crypto.randomUUID(), expectedRevision: conversation.revision, action: 'pin', messageId: conversation.messages[0].id });
  }, id);
  await send(win, id, 'In one short sentence, name one risk of renaming a release late. Do not use tools.', runtimeOptions);
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  win = app.window;
  await send(win, id, 'What release codename did we decide on? Reply with the codename only. Do not use tools.', runtimeOptions);
  const conversation = (await win.evaluate(id => window.praxis.assistant.getConversation(id), id))!;
  const attempts = conversation.turns.flatMap(turn => turn.attempts.map(attempt => ({ turnId: turn.id, attemptId: attempt.id, participantId: attempt.participantId, state: attempt.state,
    coordinatorEpoch: attempt.coordinatorEpoch, bindingId: attempt.bindingId, providerSessionId: attempt.providerSessionId,
    contextReceipt: attempt.contextReceipt, nativeContextReceipt: attempt.nativeContextReceipt,
    recoveryEvidence: attempt.recoveryEvidence, usage: attempt.usage })));
  const sessionReuse = ['part-dev', 'part-lead'].map(participantId => {
    const member = attempts.filter(attempt => attempt.participantId === participantId);
    const reused = Boolean(member[0]?.providerSessionId && member[0].providerSessionId === member[1]?.providerSessionId);
    const nativeDelivery = member[1]?.recoveryEvidence?.some(evidence => evidence.kind === 'final_result' && evidence.result?.contextDelivery === 'native') === true;
    const nativeReuseProved = reused && nativeDelivery;
    return { participantId, reused, nativeDelivery, nativeReuseProved, firstBindingId: member[0]?.bindingId, secondBindingId: member[1]?.bindingId,
      firstSessionId: member[0]?.providerSessionId, secondSessionId: member[1]?.providerSessionId,
      proof: nativeReuseProved ? 'native-session-reused' : 'context-reconstructed-native-reuse-unproved' };
  });
  const evidence = { check: label, codename, conversationId: id, recordedAt: new Date().toISOString(), runtimeOptions,
    bindings: conversation.bindings.map(({ id, providerRuntime, status, providerSessionId, deliveredMessageIds }) => ({ id, providerRuntime, status, providerSessionId, delivered: deliveredMessageIds.length })),
    sessionReuse, nativeReuseProved: sessionReuse.every(member => member.nativeReuseProved),
    attempts, replies: conversation.messages.filter(m => m.role !== 'user').map(m => m.text) };
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, `durable-team-chat-live-${label}.json`), JSON.stringify(evidence, null, 2));
  expect(conversation.turns).toHaveLength(3);
  expect(new Set(attempts.map(a => a.attemptId)).size).toBe(6);
  for (const participantId of ['part-dev', 'part-lead']) {
    const memberAttempts = attempts.filter(attempt => attempt.participantId === participantId);
    expect(memberAttempts).toHaveLength(3);
    expect(memberAttempts[2].coordinatorEpoch).not.toBe(memberAttempts[0].coordinatorEpoch);
    expect(memberAttempts.every(attempt => attempt.state === 'completed')).toBe(true);
    if (sessionReuse.find(member => member.participantId === participantId)!.reused) {
      expect(memberAttempts[1].bindingId).toBe(memberAttempts[0].bindingId);
    }
    for (const attempt of memberAttempts) expect(attempt.contextReceipt.messageIds).toContain(conversation.messages[0].id);
  }
  for (const turn of conversation.turns) {
    const sessions = turn.attempts.map(attempt => attempt.providerSessionId).filter(Boolean);
    if (sessions.length) expect(new Set(sessions).size).toBe(2);
  }
  // The third turn's context includes the pinned decision, whether reused natively or reconstructed.
  const firstMessage = conversation.messages[0].id;
  const third = conversation.turns[2].attempts.at(-1)!;
  const binding = conversation.bindings.find(b => b.id === third.bindingId);
  expect(third.contextReceipt.messageIds.includes(firstMessage) || Boolean(binding?.deliveredMessageIds.includes(firstMessage))).toBe(true);
  for (const attempt of conversation.turns[2].attempts) {
    const reply = conversation.messages.find(message => message.id === attempt.resultMessageId);
    expect(reply, `restart reply for ${attempt.participantId}`).toBeDefined();
    expect(reply!.text.toLowerCase()).toContain(codename);
  }
}

test('real CLI member continues a durable team chat across an app restart', async () => {
  test.skip(!commandAvailable(CLI_COMMAND), `CLI not on PATH: ${CLI_COMMAND}`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-team-chat-'));
  try {
    await continuationAcrossRestart('cli', { ai: { activeProvider: CLI_PROVIDER } },
      win => win.evaluate(({ provider, command }) => window.praxis.settings.set({ ai: { providers: { [provider]: { cliPath: command } } } }),
        { provider: CLI_PROVIDER, command: CLI_COMMAND }).then(() => undefined),
      { provider: CLI_PROVIDER, toolMode: 'read-only', permissionMode: 'manual', workingDirectory: folder });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('real API member continues a durable team chat across an app restart', async () => {
  test.skip(!API_PROVIDER || !API_KEY, 'Set PRAXIS_LIVE_API_PROVIDER and PRAXIS_LIVE_API_KEY for the real API check.');
  const model = process.env.PRAXIS_LIVE_API_MODEL;
  await continuationAcrossRestart('api', { ai: { activeProvider: API_PROVIDER, ...(model ? { providers: { [API_PROVIDER!]: { defaultModel: model, enabled: true } } } : {}) } },
    win => win.evaluate(key => window.praxis.ai.setApiKey(key), API_KEY!).then(() => undefined),
    { provider: API_PROVIDER!, toolMode: 'project-only', ...(model ? { model } : {}) });
});
