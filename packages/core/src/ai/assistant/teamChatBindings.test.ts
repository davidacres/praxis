import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveTeamChatBinding, type TeamChatConfiguration } from './teamChatBindings';
import type { ConversationBinding, ConversationTurn, DurableConversation, TeamChatRepository, TeamChatSnapshot } from './assistantTypes';
import { TeamChatCoordinator, makeParticipant } from './teamChatCoordinator';
const configuration: TeamChatConfiguration = { conversationId: 'chat', participantId: 'member', providerRuntime: 'acp', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: '1', canonicalFolder: '/project', executionMode: 'chat', toolPolicy: 'read-only', permissionPolicy: 'manual' };
test('every resolved compatibility dimension invalidates reuse and switching back stays fresh', () => {
  for (const key of Object.keys(configuration) as (keyof TeamChatConfiguration)[]) {
    const bindings: ConversationBinding[] = [];
    const first = resolveTeamChatBinding(bindings, configuration, 'first');
    assert.equal(resolveTeamChatBinding(bindings, configuration, 'unused'), first);
    const changed = { ...configuration, [key]: 'changed' };
    const second = resolveTeamChatBinding(bindings, changed, 'second');
    assert.notEqual(second.id, first.id);
    if (key !== 'participantId') assert.equal(first.status, 'invalid');
    if (key !== 'participantId') assert.equal(resolveTeamChatBinding(bindings, configuration, 'third').id, 'third');
  }
});

class MemoryRepository implements TeamChatRepository {
  public snapshot: TeamChatSnapshot;
  public constructor(conversation: DurableConversation) { this.snapshot = { schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation] }; }
  public read(): TeamChatSnapshot { return structuredClone(this.snapshot); }
  public async transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
    const draft = structuredClone(this.snapshot);
    const result = mutate(draft);
    this.snapshot = structuredClone(draft);
    return structuredClone(result);
  }
}
function chat(): DurableConversation {
  return { id: 'chat', schemaVersion: 2, revision: 1, title: 'Bindings', createdAt: 'then', updatedAt: 'then', coordinatorEpoch: 'epoch',
    participants: [makeParticipant('lead')], messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] };
}
/** Mirrors the production adapter: the binding is derived only from the turn's captured options. */
function configurationFor(turn: ConversationTurn): TeamChatConfiguration {
  const options = turn.plan.runtimeOptions;
  return { ...configuration, participantId: 'part-lead', providerRuntime: String(options.provider ?? 'acp'),
    canonicalFolder: String(options.workingDirectory ?? '/project'), toolPolicy: String(options.toolMode ?? 'project-only'),
    permissionPolicy: String(options.permissionMode ?? 'manual') };
}
async function settle(coordinator: TeamChatCoordinator, turns: number): Promise<DurableConversation> {
  for (let i = 0; i < 200; i++) {
    const current = coordinator.getConversation('chat')!;
    if (current.turns.length === turns && current.turns.every(t => t.state === 'completed')) return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Coordinator did not settle.');
}

test('folder, permission-mode and provider changes each invalidate the binding and never widen tool mode', async () => {
  const base = { provider: 'acp', workingDirectory: '/project', toolMode: 'read-only', permissionMode: 'manual' };
  const changes: Record<string, string | number | boolean>[] = [
    { workingDirectory: '/elsewhere' }, { permissionMode: 'auto' }, { provider: 'api' }, { toolMode: 'project-only' }
  ];
  for (const change of changes) {
    const repo = new MemoryRepository(chat());
    const seen: ConversationTurn[] = [];
    const coordinator = new TeamChatCoordinator({ repository: repo,
      // The main process fills defaults but never upgrades a captured tool mode.
      captureRuntimeOptions: options => ({ ...options, toolMode: options.toolMode ?? 'project-only' }),
      executionAdapter: {
        prepare: async ({ turn }) => configurationFor(turn),
        execute: async ({ turn }) => { seen.push(turn); return { text: 'ok' }; }
      } });
    await coordinator.submitTurn({ conversationId: 'chat', commandId: 'one', expectedRevision: 1, text: 'first',
      selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: base });
    const first = await settle(coordinator, 1);
    await coordinator.submitTurn({ conversationId: 'chat', commandId: 'two', expectedRevision: first.revision, text: 'second',
      selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: { ...base, ...change } });
    const after = await settle(coordinator, 2);
    const [oldBinding, newBinding] = after.bindings;
    assert.equal(after.bindings.length, 2, JSON.stringify(change));
    assert.equal(oldBinding.status, 'invalid');
    assert.equal(newBinding.status, 'valid');
    assert.equal(after.turns[1].attempts[0].bindingId, newBinding.id);
    assert.deepEqual(newBinding.deliveredMessageIds.filter(id => after.messages.find(m => m.id === id)?.turnId === after.turns[0].id).length, 2,
      'the new binding was given the earlier turn by reconstruction, not assumed');
    const rank = { 'project-only': 0, 'read-only': 1, full: 2 } as Record<string, number>;
    assert.ok(rank[String(seen[1].plan.runtimeOptions.toolMode)] <= rank[String(change.toolMode ?? base.toolMode)], 'tool mode is never broader than captured');
    assert.equal(seen[1].plan.runtimeOptions.permissionMode, change.permissionMode ?? base.permissionMode);
    assert.equal('autoApprovePermissions' in seen[1].plan.runtimeOptions, false);
  }
});

test('a runtime without native resume reconstructs the full bounded context once rather than sending a delta', async () => {
  const repo = new MemoryRepository(chat());
  const prompts: { prepared?: string; native?: string }[] = [];
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: {
    prepare: async ({ turn }) => configurationFor(turn),
    // No resume capability: always deliver the reconstruction and report no native delivery.
    execute: async ({ preparedPrompt, nativePrompt }) => { prompts.push({ prepared: preparedPrompt, native: nativePrompt }); return { text: `reply ${prompts.length}` }; }
  } });
  await coordinator.submitTurn({ conversationId: 'chat', commandId: 'one', expectedRevision: 1, text: 'remember the blue option',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  const first = await settle(coordinator, 1);
  await coordinator.submitTurn({ conversationId: 'chat', commandId: 'two', expectedRevision: first.revision, text: 'which option?',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  const after = await settle(coordinator, 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].prepared!.includes('remember the blue option'), 'reconstruction carries the earlier turn');
  assert.ok(prompts[1].prepared!.includes('reply 1'));
  assert.ok(!prompts[1].native!.includes('remember the blue option'), 'the delta is offered but not used');
  const receipt = after.turns[1].attempts[0].contextReceipt;
  assert.deepEqual(receipt.messageIds, after.messages.slice(0, 3).map(m => m.id), 'the receipt records the full reconstruction');
  assert.equal(new Set(after.bindings[0].deliveredMessageIds).size, after.bindings[0].deliveredMessageIds.length, 'each message is delivered once');
});
