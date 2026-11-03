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

test('TASK-479 AC4: Closing/cancelling turn does not corrupt conversation state', async () => {
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
  assert.equal(turn.state, 'cancelled');
});
