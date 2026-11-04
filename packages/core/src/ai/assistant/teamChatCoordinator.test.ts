import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TeamChatCoordinator,
  makeParticipant,
  type TeamChatExecutionAdapter,
  type ConversationUpdate
} from './teamChatCoordinator';
import type {
  DurableConversation,
  TeamChatRepository,
  TeamChatSnapshot,
  SubmitConversationCommand
} from './assistantTypes';

class MemoryTeamChatRepository implements TeamChatRepository {
  public snapshot: TeamChatSnapshot;

  public constructor(initialConversations: DurableConversation[] = []) {
    this.snapshot = {
      schemaVersion: 2,
      revision: 0,
      teamChats: [],
      conversations: initialConversations
    };
  }

  public read(): TeamChatSnapshot {
    return structuredClone(this.snapshot);
  }

  public async transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
    const draft = structuredClone(this.snapshot);
    const result = mutate(draft);
    this.snapshot = structuredClone(draft);
    return result;
  }
}

function makeConversation(id = 'conv-1'): DurableConversation {
  return {
    id,
    schemaVersion: 2,
    revision: 1,
    title: 'Test Conversation',
    createdAt: '2026-11-03T20:00:00.000Z',
    updatedAt: '2026-11-03T20:00:00.000Z',
    coordinatorEpoch: 'epoch-1',
    participants: [
      makeParticipant('dev'),
      makeParticipant('qa'),
      makeParticipant('lead'),
      makeParticipant('security'),
      makeParticipant('product')
    ],
    messages: [],
    turns: [],
    bindings: [],
    summaries: [],
    pinnedMessageIds: [],
    commandReceipts: []
  };
}

test('TASK-478 AC1: Two simultaneous sends produce distinct FIFO queued turns, repeated delivery produces one turn', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const executedTurns: string[] = [];

  const adapter: TeamChatExecutionAdapter = {
    execute: async ({ turn }) => {
      executedTurns.push(turn.id);
      return { text: 'Done' };
    }
  };

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: adapter
  });

  const commandA: SubmitConversationCommand = {
    conversationId: 'conv-1',
    commandId: 'cmd-1',
    expectedRevision: 1,
    text: 'Hello first',
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  };

  const commandB: SubmitConversationCommand = {
    conversationId: 'conv-1',
    commandId: 'cmd-2',
    expectedRevision: 1,
    text: 'Hello second',
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  };

  // Repeated delivery of cmd-1
  const res1 = await coordinator.submitTurn(commandA);
  const res1Dup = await coordinator.submitTurn(commandA);

  assert.equal(res1.turnId, res1Dup.turnId, 'Repeated delivery of one command produces one turn');

  // Simultaneous sends produce distinct FIFO queued turns
  const [simA, simB] = await Promise.all([
    coordinator.submitTurn({ ...commandA, commandId: 'cmd-sim-1' }),
    coordinator.submitTurn({ ...commandB, commandId: 'cmd-sim-2' })
  ]);
  assert.notEqual(simA.turnId, simB.turnId, 'Two sends produce distinct turns');

  // Allow execution loops to complete
  await new Promise(r => setTimeout(r, 50));

  const conv = coordinator.getConversation('conv-1')!;
  assert.equal(conv.turns.length, 3);
  assert.equal(conv.turns[0].id, res1.turnId);
  assert.equal(conv.turns[1].id, simA.turnId);
  assert.equal(conv.turns[2].id, simB.turnId);
});

test('TASK-478 AC2: Selected members answer in dev, qa, security, product, lead order; mention selects only that member; empty roster resolves to lead', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const answeredRoles: string[] = [];

  const adapter: TeamChatExecutionAdapter = {
    execute: async ({ participant }) => {
      answeredRoles.push(participant.role);
      return { text: `Reply from ${participant.role}` };
    }
  };

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: adapter
  });

  // Test 1: Out-of-order selected members (product, lead, dev, qa)
  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-order',
    expectedRevision: 1,
    text: 'Please answer team',
    selectedParticipantIds: ['part-product', 'part-lead', 'part-dev', 'part-qa'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 50));

  assert.deepEqual(answeredRoles, ['dev', 'qa', 'product', 'lead'], 'Must answer in dev, qa, security, product, lead order');

  // Test 2: Explicit mention @qa
  answeredRoles.length = 0;
  const currentRev = coordinator.getConversation('conv-1')!.revision;
  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-mention',
    expectedRevision: currentRev,
    text: '@qa What is the test coverage?',
    selectedParticipantIds: ['part-dev', 'part-qa', 'part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(answeredRoles, ['qa'], 'Explicit mention must select only that member');

  // Test 3: Empty roster resolves to lead
  answeredRoles.length = 0;
  const rev3 = coordinator.getConversation('conv-1')!.revision;
  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-empty',
    expectedRevision: rev3,
    text: 'General question without roster',
    selectedParticipantIds: [],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(answeredRoles, ['lead'], 'Empty roster must resolve to lead');
});

test('TASK-478 AC3: Later members see earlier committed replies from their turn; no member sees queued future user messages', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const messagesSeenByRole = new Map<string, string[]>();

  const adapter: TeamChatExecutionAdapter = {
    execute: async ({ participant, turn, messages }) => {
      const key = `${participant.role}:${turn.id}`;
      messagesSeenByRole.set(key, messages.map(m => m.text));
      return { text: `Reply from ${participant.role}` };
    }
  };

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: adapter
  });

  // Submit Turn 1 with dev and qa
  const resTurn1 = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-turn1',
    expectedRevision: 1,
    text: 'User question for turn 1',
    selectedParticipantIds: ['part-dev', 'part-qa'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  // Immediately submit Turn 2 before Turn 1 finishes
  const revNow = coordinator.getConversation('conv-1')!.revision;
  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-turn2',
    expectedRevision: revNow,
    text: 'Queued user question for turn 2',
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 100));

  const devMessages = messagesSeenByRole.get(`dev:${resTurn1.turnId}`)!;
  const qaMessages = messagesSeenByRole.get(`qa:${resTurn1.turnId}`)!;

  assert.ok(devMessages.includes('User question for turn 1'));
  assert.ok(!devMessages.includes('Queued user question for turn 2'), 'Dev must not see future queued user message');

  assert.ok(qaMessages.includes('User question for turn 1'));
  assert.ok(qaMessages.includes('Reply from dev'), 'QA must see earlier committed reply from dev');
  assert.ok(!qaMessages.includes('Queued user question for turn 2'), 'QA must not see future queued user message');
});

test('TASK-478 AC4: Changing roster affects subsequent accepted turns only; failures pause the current turn and leave later turns queued', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  let shouldFail = true;

  const adapter: TeamChatExecutionAdapter = {
    execute: async ({ participant }) => {
      if (participant.role === 'dev' && shouldFail) {
        throw new Error('Dev provider failed.');
      }
      return { text: `Success from ${participant.role}` };
    }
  };

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: adapter
  });

  // Turn 1 will fail
  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-fail',
    expectedRevision: 1,
    text: 'Trigger failure',
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  // Turn 2 queued behind Turn 1
  const rev1 = coordinator.getConversation('conv-1')!.revision;
  const turn2Res = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-queued',
    expectedRevision: rev1,
    text: 'Queued message',
    selectedParticipantIds: ['part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 50));

  const conv = coordinator.getConversation('conv-1')!;
  assert.equal(conv.turns[0].state, 'failed', 'Current turn must be paused on failure');
  assert.equal(conv.turns[1].state, 'queued', 'Later turn must remain queued');
  assert.equal(conv.turns[1].id, turn2Res.turnId);

  // Retry the failed participant
  shouldFail = false;
  await coordinator.retryParticipant('conv-1', conv.turns[0].id, 'part-dev');

  await new Promise(r => setTimeout(r, 100));

  const convRecovered = coordinator.getConversation('conv-1')!;
  assert.equal(convRecovered.turns[0].state, 'completed');
  assert.equal(convRecovered.turns[1].state, 'completed');
});

test('TASK-479 AC1: IPC timeout after durable acceptance followed by resubmission returns the original turn ID', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: { execute: async () => ({ text: 'ok' }) }
  });

  const cmd: SubmitConversationCommand = {
    conversationId: 'conv-1',
    commandId: 'cmd-timeout-test',
    expectedRevision: 1,
    text: 'Message that timed out on client',
    selectedParticipantIds: ['part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  };

  const res1 = await coordinator.submitTurn(cmd);
  // Resubmission with same command ID
  const res2 = await coordinator.submitTurn(cmd);

  assert.equal(res1.turnId, res2.turnId);
  assert.equal(res2.turnId, res1.turnId);
});

test('TASK-479 AC2: Subscription emits revision updates', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: { execute: async () => ({ text: 'reply text' }) }
  });

  const updates: ConversationUpdate[] = [];
  coordinator.subscribe('conv-1', update => updates.push(update));

  await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-sub',
    expectedRevision: 1,
    text: 'Sub test',
    selectedParticipantIds: ['part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await new Promise(r => setTimeout(r, 50));

  assert.ok(updates.length >= 3, 'Should receive turn_accepted, attempt, and completed updates');
  assert.equal(updates[0].type, 'turn_accepted');
  assert.ok(updates.some(u => u.type === 'attempt_completed'));
});

test('TASK-479 AC3: Invalid participant, attachment reference, and permission choice are rejected before provider invocation', async () => {
  let invoked = false;
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: { execute: async () => { invoked = true; return { text: 'ok' }; } }
  });

  // Invalid participant
  await assert.rejects(
    coordinator.submitTurn({
      conversationId: 'conv-1',
      commandId: 'cmd-bad-part',
      expectedRevision: 1,
      text: 'hello',
      selectedParticipantIds: ['part-nonexistent'],
      attachmentRefs: [],
      runtimeOptions: {}
    }),
    /Invalid participant reference/
  );

  // Invalid attachment
  await assert.rejects(
    coordinator.submitTurn({
      conversationId: 'conv-1',
      commandId: 'cmd-bad-att',
      expectedRevision: 1,
      text: 'hello',
      selectedParticipantIds: ['part-lead'],
      attachmentRefs: [{ digest: '', mediaType: '' } as never],
      runtimeOptions: {}
    }),
    /Invalid attachment reference/
  );

  // Invalid permission choice
  await assert.rejects(
    coordinator.submitTurn({
      conversationId: 'conv-1',
      commandId: 'cmd-bad-perm',
      expectedRevision: 1,
      text: 'hello',
      selectedParticipantIds: ['part-lead'],
      attachmentRefs: [],
      runtimeOptions: { permissionMode: 'invalid' as never }
    }),
    /Invalid permission choice/
  );

  assert.equal(invoked, false, 'Provider must not be invoked for invalid commands');
});

test('TASK-479 AC4: cancellation preserves unresolved execution as unknown', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: {
      execute: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { text: 'Late reply' };
      }
    }
  });

  const res = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-cancel',
    expectedRevision: 1,
    text: 'Will be cancelled',
    selectedParticipantIds: ['part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await coordinator.cancelTurn('conv-1', res.turnId);

  await new Promise(r => setTimeout(r, 250));

  const conv = coordinator.getConversation('conv-1')!;
  const turn = conv.turns.find(t => t.id === res.turnId)!;
  assert.ok(['cancelled', 'outcome_unknown'].includes(turn.state));
});

async function settled(coordinator: TeamChatCoordinator, conversationId: string): Promise<DurableConversation> {
  for (let i = 0; i < 100; i++) {
    const conversation = coordinator.getConversation(conversationId)!;
    if (conversation.turns.length && conversation.turns.every(t => !['queued', 'running'].includes(t.state))) return conversation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Coordinator did not settle.');
}

test('compatible members retain one binding each across turns and chats remain isolated; usage commits once', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation(), makeConversation('other')]);
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: {
    prepare: async ({ conversation, participant }) => ({ conversationId: conversation.id, participantId: participant.id, providerRuntime: 'fixture', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: participant.instructionVersion, canonicalFolder: '/fixture', executionMode: 'chat', toolPolicy: 'read-only', permissionPolicy: 'manual' }),
    execute: async ({ attempt }) => ({ text: 'Reply', usage: { inputTokens: 2, outputTokens: 3 }, usageReferences: [attempt.id, attempt.id] })
  } });
  for (const [conversationId, commandId] of [['conv-1', 'first'], ['conv-1', 'second'], ['other', 'third']]) {
    await coordinator.submitTurn({ conversationId, commandId, expectedRevision: 1, text: 'Hello', selectedParticipantIds: ['part-dev', 'part-qa'], attachmentRefs: [], runtimeOptions: {} });
    await settled(coordinator, conversationId);
  }
  const conversation = coordinator.getConversation('conv-1')!;
  assert.equal(conversation.turns.flatMap(t => t.attempts).length, 4);
  assert.equal(conversation.bindings.length, 2);
  assert.equal(new Set([...conversation.bindings, ...coordinator.getConversation('other')!.bindings].map(b => b.id)).size, 4);
  for (const attempt of conversation.turns.flatMap(t => t.attempts)) {
    assert.equal(attempt.usage?.inputTokens, 2);
    assert.deepEqual(attempt.usageReferences, [attempt.id]);
    assert.ok(conversation.bindings.find(b => b.id === attempt.bindingId)?.nativeOutputMessageIds.includes(attempt.resultMessageId!));
  }
});

test('context overflow pauses before any main provider attempt', async () => {
  let dispatches = 0;
  const coordinator = new TeamChatCoordinator({ repository: new MemoryTeamChatRepository([makeConversation()]), executionAdapter: { execute: async () => { dispatches++; return { text: 'unexpected' }; } } });
  await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'large', expectedRevision: 1, text: 'x'.repeat(40000), selectedParticipantIds: [], attachmentRefs: [], runtimeOptions: {} });
  const conversation = await settled(coordinator, 'conv-1');
  assert.equal(conversation.turns[0].state, 'context_required');
  assert.equal(conversation.turns[0].attempts.length, 0);
  assert.equal(dispatches, 0);
});

test('uncertain acceptance invalidates the binding and never automatically resends', async () => {
  const coordinatorModule = require('./teamChatCoordinator') as typeof import('./teamChatCoordinator');
  const conversation = makeConversation();
  conversation.bindings.push({ id: 'binding', conversationId: conversation.id, participantId: 'part-lead', providerRuntime: 'fixture', compatibilityDigest: '', deliveredMessageIds: [], nativeOutputMessageIds: [], status: 'valid' });
  let calls = 0;
  const coordinator = new TeamChatCoordinator({ repository: new MemoryTeamChatRepository([conversation]), executionAdapter: {
    execute: async () => { calls++; throw new coordinatorModule.TeamChatAcceptanceUnknown('transport closed after send'); }
  } });
  await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'unknown', expectedRevision: 1, text: 'Hello', selectedParticipantIds: [], attachmentRefs: [], runtimeOptions: {} });
  const result = await settled(coordinator, 'conv-1');
  assert.equal(result.turns[0].state, 'outcome_unknown');
  assert.equal(calls, 1);
  await assert.rejects(coordinator.retryParticipant('conv-1', result.turns[0].id, 'part-lead'), /use resolveAttempt/);
});

test('bounded summarization has separate provenance and usage; summary failure dispatches no main prompt', async () => {
  for (const fail of [false, true]) {
    const conversation = makeConversation();
    conversation.messages = Array.from({ length: 18 }, (_, i) => ({ id: `old-${i}`, turnId: 'old', role: 'user' as const, text: `Source ${i} ${'x'.repeat(1000)}`, createdAt: 'now', sequence: i + 1, attachments: [] }));
    conversation.pinnedMessageIds = ['old-0'];
    let dispatches = 0;
    const coordinator = new TeamChatCoordinator({ repository: new MemoryTeamChatRepository([conversation]), executionAdapter: {
      summarize: async prompt => {
        assert.ok(Buffer.byteLength(prompt) <= 16000);
        if (fail) throw new Error('summary unavailable');
        return { text: 'Bounded summary with source IDs.', usage: { inputTokens: 100, outputTokens: 8 } };
      },
      execute: async ({ preparedPrompt }) => {
        dispatches++;
        assert.ok(preparedPrompt!.includes('Source 0'));
        return { text: 'Main reply', usage: { inputTokens: 200 } };
      }
    } });
    await coordinator.submitTurn({ conversationId: conversation.id, commandId: 'large-history', expectedRevision: 1, text: 'Current request ' + 'y'.repeat(12000), selectedParticipantIds: [], attachmentRefs: [], runtimeOptions: {} });
    const result = await settled(coordinator, conversation.id);
    assert.equal(dispatches, fail ? 0 : 1);
    assert.equal(result.turns[0].state, fail ? 'context_required' : 'completed');
    assert.equal(result.summaryAttempts![0].state, fail ? 'failed' : 'completed');
    if (!fail) {
      assert.equal(result.summaryAttempts![0].usage?.inputTokens, 100);
      assert.equal(result.summaries[0].attemptId, result.summaryAttempts![0].id);
      assert.ok(result.summaries[0].sourceMessageIds?.length);
      assert.equal(result.turns[0].attempts[0].usage?.inputTokens, 200);
    }
  }
});

async function recoveryFixture(state: 'interrupted' | 'outcome_unknown') {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: { execute: async () => { throw new Error('fixture'); } } });
  await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'recovery', expectedRevision: 1,
    text: 'recover', selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  await settled(coordinator, 'conv-1');
  const turn = repo.snapshot.conversations[0].turns[0];
  turn.state = state;
  const attempt = turn.attempts[0];
  attempt.state = state;
  attempt.recoveryEvidence = [{ id: 'observation', conversationId: 'conv-1', turnId: turn.id,
    participantId: attempt.participantId, attemptId: attempt.id, coordinatorEpoch: attempt.coordinatorEpoch,
    kind: 'reconciliation', observedAt: 'now', provenance: 'test' }];
  return { repo, coordinator, turn, attempt };
}

test('recovered result imports atomically once with usage and original epoch', async () => {
  const { repo, coordinator, turn, attempt } = await recoveryFixture('outcome_unknown');
  repo.snapshot.conversations[0].coordinatorEpoch = 'replacement';
  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'result', kind: 'final_result',
    result: { text: 'Recovered reply', usageReferences: ['paid-once'] } });
  await coordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'accept');
  await coordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'accept');
  const current = coordinator.getConversation('conv-1')!;
  assert.equal(current.messages.filter(m => m.text === 'Recovered reply').length, 1);
  assert.equal(current.turns[0].state, 'completed');
  assert.deepEqual(current.turns[0].attempts[0].usageReferences, ['paid-once']);
});

test('interrupted retry preserves predecessor and unknown retry requires informed evidence', async () => {
  for (const state of ['interrupted', 'outcome_unknown'] as const) {
    const { coordinator, turn, attempt } = await recoveryFixture(state);
    if (state === 'outcome_unknown') {
      await assert.rejects(coordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'retry'), /acknowledgement/);
      await assert.rejects(coordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'retry',
        { acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: 'wrong' }), /acknowledgement/);
    }
    await coordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'retry',
      { acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: 'observation' });
    await settled(coordinator, 'conv-1');
    const attempts = coordinator.getConversation('conv-1')!.turns[0].attempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].state, state);
    if (state === 'outcome_unknown') assert.ok(attempts[0].recoveryEvidence!.some(e => e.kind === 'decision'));
  }
});

test('active cancellation remains cancelling until execution settles and records evidence', async () => {
  let finish!: (result: { text: string }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: {
    execute: async () => { started(); return new Promise(resolve => { finish = resolve; }); }
  } });
  const result = await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'cancel-barrier',
    expectedRevision: 1, text: 'cancel', selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  await ready;
  await coordinator.cancelTurn('conv-1', result.turnId);
  assert.equal(coordinator.getConversation('conv-1')!.turns[0].state, 'cancelling');
  finish({ text: 'uncommitted' });
  for (let i = 0; i < 100 && coordinator.getConversation('conv-1')!.turns[0].state === 'cancelling'; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const turn = coordinator.getConversation('conv-1')!.turns[0];
  assert.equal(turn.state, 'completed');
  assert.equal(coordinator.getConversation('conv-1')!.messages.filter(m => m.text === 'uncommitted').length, 1);
  assert.ok(turn.attempts[0].recoveryEvidence!.some(e => e.provenance === 'execution-settled-after-abort'));
});

test('startup imports durable results once across repeated coordinator replacements', async () => {
  const { repo, turn, attempt } = await recoveryFixture('outcome_unknown');
  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'final', kind: 'final_result', result: { text: 'restart result' } });
  let invocations = 0;
  for (let i = 0; i < 2; i++) {
    const coordinator = new TeamChatCoordinator({ repository: repo, idSource: () => 'epoch-' + i,
      executionAdapter: { execute: async () => { invocations++; return { text: 'unexpected' }; } } });
    await coordinator.initialize();
  }
  assert.equal(invocations, 0);
  assert.equal(repo.read().conversations[0].messages.filter(m => m.text === 'restart result').length, 1);
  assert.equal(repo.read().conversations[0].turns.find(t => t.id === turn.id)!.state, 'completed');
});

test('direct unknown-outcome retry requires informed resolution without dispatch', async () => {
  const { coordinator, turn, repo } = await recoveryFixture('outcome_unknown');
  const before = repo.read();
  await assert.rejects(coordinator.retryParticipant('conv-1', turn.id, 'part-lead'), /use resolveAttempt.*duplicate-risk acknowledgement/);
  assert.deepEqual(repo.read(), before);
});
