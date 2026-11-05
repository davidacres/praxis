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
  private queue: Promise<unknown> = Promise.resolve();

  /** `deferred` runs each mutation after an await on a serial queue, like the desktop file repository. */
  public constructor(initialConversations: DurableConversation[] = [], private readonly options: { deferred?: boolean } = {}) {
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
    const apply = () => {
      const draft = structuredClone(this.snapshot);
      const result = mutate(draft);
      this.snapshot = structuredClone(draft);
      return result;
    };
    if (!this.options.deferred) return apply();
    const run = this.queue.then(async () => {
      await new Promise(r => setImmediate(r));
      return apply();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(r => setTimeout(r, 2));
  }
}

function turnState(coordinator: TeamChatCoordinator, turnId: string): string | undefined {
  return coordinator.getConversation('conv-1')!.turns.find(t => t.id === turnId)?.state;
}

function planRoles(coordinator: TeamChatCoordinator, turnId: string): string[] {
  return coordinator.getConversation('conv-1')!.turns.find(t => t.id === turnId)!.plan.participants.map(p => p.role);
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
  // Deferred mutations queue behind each other, as the desktop file repository's do,
  // so concurrent submits genuinely race on the acceptance snapshot.
  const repo = new MemoryTeamChatRepository([makeConversation()], { deferred: true });
  const executedTurns: string[] = [];
  const accepted: string[] = [];

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: {
      execute: async ({ turn }) => {
        executedTurns.push(turn.id);
        return { text: 'Done' };
      }
    },
    onUpdate: update => { if (update.type === 'turn_accepted') accepted.push(update.turnId!); }
  });

  const command = (commandId: string, text: string): SubmitConversationCommand => ({
    conversationId: 'conv-1',
    commandId,
    expectedRevision: 1,
    text,
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  const [a, b, aAgain] = await Promise.all([
    coordinator.submitTurn(command('cmd-a', 'Hello first')),
    coordinator.submitTurn(command('cmd-b', 'Hello second')),
    coordinator.submitTurn(command('cmd-a', 'Hello first'))
  ]);
  // A later sequential redelivery converges too.
  const aLater = await coordinator.submitTurn(command('cmd-a', 'Hello first'));

  assert.notEqual(a.turnId, b.turnId, 'Two sends produce distinct turns');
  assert.equal(aAgain.turnId, a.turnId, 'Concurrent repeated delivery of one command produces one turn');
  assert.equal(aLater.turnId, a.turnId, 'Sequential repeated delivery of one command produces one turn');

  await until(() => coordinator.getConversation('conv-1')!.turns.every(t => t.state === 'completed'));
  const conv = coordinator.getConversation('conv-1')!;
  assert.equal(conv.turns.length, 2);
  assert.deepEqual(conv.commandReceipts.map(r => r.commandId).sort(), ['cmd-a', 'cmd-b'], 'One receipt per command');
  const userSequences = conv.messages.filter(m => m.role === 'user').map(m => m.sequence);
  assert.deepEqual(userSequences, [1, 2], 'Accepted user messages carry contiguous, increasing sequences');
  assert.deepEqual(conv.turns.map(t => t.acceptedSequence), [1, 2]);
  assert.equal(accepted.filter(id => id === a.turnId).length, 1, 'The duplicate is announced once');
  assert.deepEqual(accepted, conv.turns.map(t => t.id), 'Acceptance order matches the queue');
  assert.deepEqual(executedTurns, conv.turns.map(t => t.id), 'Turns dispatch in FIFO acceptance order');
});

test('TASK-478 AC2: Selected members answer in dev, qa, security, product, lead order; mention selects only that member; empty roster resolves to lead', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const answeredRoles: string[] = [];
  const firstMember = gate();
  let planSeenDuringFirstExecution: string[] | undefined;

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: {
      execute: async ({ participant, turn }) => {
        if (!planSeenDuringFirstExecution) {
          planSeenDuringFirstExecution = repo.read().conversations[0].turns.find(t => t.id === turn.id)!.plan.participants.map(p => p.role);
          await firstMember.wait;
        }
        answeredRoles.push(participant.role);
        return { text: `Reply from ${participant.role}` };
      }
    }
  });

  // All five roles, deliberately scrambled.
  const ordered = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-order',
    expectedRevision: 1,
    text: 'Please answer team',
    selectedParticipantIds: ['part-lead', 'part-product', 'part-security', 'part-qa', 'part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  await until(() => planSeenDuringFirstExecution !== undefined);
  assert.deepEqual(planSeenDuringFirstExecution, ['dev', 'qa', 'security', 'product', 'lead'],
    'The response plan is committed in canonical order before the first member runs');
  firstMember.open();
  await until(() => turnState(coordinator, ordered.turnId) === 'completed');
  assert.deepEqual(answeredRoles, ['dev', 'qa', 'security', 'product', 'lead'], 'Must answer in dev, qa, security, product, lead order');

  // Explicit mention @qa
  answeredRoles.length = 0;
  const mention = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-mention',
    expectedRevision: coordinator.getConversation('conv-1')!.revision,
    text: '@qa What is the test coverage?',
    selectedParticipantIds: ['part-dev', 'part-qa', 'part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  await until(() => turnState(coordinator, mention.turnId) === 'completed');
  assert.deepEqual(planRoles(coordinator, mention.turnId), ['qa'], 'Mention plan holds exactly that member');
  assert.deepEqual(answeredRoles, ['qa'], 'Explicit mention must select only that member');

  // Empty roster resolves to lead
  answeredRoles.length = 0;
  const empty = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-empty',
    expectedRevision: coordinator.getConversation('conv-1')!.revision,
    text: 'General question without roster',
    selectedParticipantIds: [],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  await until(() => turnState(coordinator, empty.turnId) === 'completed');
  assert.deepEqual(planRoles(coordinator, empty.turnId), ['lead']);
  assert.deepEqual(answeredRoles, ['lead'], 'Empty roster must resolve to lead');
});

test('TASK-478 AC3: Later members see earlier committed replies from their turn; no member sees queued future user messages', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const messagesSeen = new Map<string, string[]>();
  const devTurn1 = gate();
  let devTurn1Started = false;
  let turn1Id = '';

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: {
      execute: async ({ participant, turn, messages }) => {
        messagesSeen.set(`${participant.role}:${turn.id}`, messages.map(m => m.text));
        if (turn.id === turn1Id && participant.role === 'dev') {
          devTurn1Started = true;
          await devTurn1.wait;
        }
        return { text: `Reply from ${participant.role}` };
      }
    }
  });

  const turn1 = coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-turn1',
    expectedRevision: 1,
    text: 'User question for turn 1',
    selectedParticipantIds: ['part-dev', 'part-qa'],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  turn1Id = (await turn1).turnId;
  await until(() => devTurn1Started);

  // Turn 2 is durably accepted while turn 1's dev reply is still in flight.
  const turn2 = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-turn2',
    expectedRevision: coordinator.getConversation('conv-1')!.revision,
    text: 'Queued user question for turn 2',
    selectedParticipantIds: ['part-security'],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  assert.ok(repo.read().conversations[0].commandReceipts.some(r => r.commandId === 'cmd-turn2'), 'Turn 2 is durable before turn 1 finishes');
  assert.equal(turnState(coordinator, turn2.turnId), 'queued');

  devTurn1.open();
  await until(() => turnState(coordinator, turn2.turnId) === 'completed');

  const dev = messagesSeen.get(`dev:${turn1Id}`)!;
  const qa = messagesSeen.get(`qa:${turn1Id}`)!;
  const security = messagesSeen.get(`security:${turn2.turnId}`)!;

  assert.ok(dev.includes('User question for turn 1'));
  assert.ok(!dev.includes('Queued user question for turn 2'), 'Dev must not see future queued user message');

  assert.ok(qa.includes('User question for turn 1'));
  assert.ok(qa.includes('Reply from dev'), 'QA must see earlier committed reply from dev');
  assert.ok(!qa.includes('Queued user question for turn 2'), 'QA, prepared after turn 2 was accepted, must not see it');

  assert.ok(security.includes('Reply from dev') && security.includes('Reply from qa'), 'Turn 2 sees both turn 1 replies');
  assert.ok(security.includes('Queued user question for turn 2'));
});

test('TASK-478 AC4: Changing roster affects subsequent accepted turns only; failures pause the current turn and leave later turns queued', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  let defaultModel = 'model-v1';
  const held = gate();
  let turn1Id = '';
  let turn1Started = false;
  const executed: { turnId: string; role: string; model: unknown; instructions: string }[] = [];

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    captureRuntimeOptions: options => ({ ...options, model: defaultModel }),
    executionAdapter: {
      execute: async ({ participant, turn }) => {
        if (turn.id === turn1Id && participant.role === 'dev' && !turn1Started) {
          turn1Started = true;
          await held.wait;
        }
        executed.push({ turnId: turn.id, role: participant.role, model: turn.plan.runtimeOptions.model, instructions: participant.instructions });
        return { text: `Success from ${participant.role}` };
      }
    }
  });

  const submit = (commandId: string, selectedParticipantIds: string[]) => coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId,
    expectedRevision: coordinator.getConversation('conv-1')!.revision,
    text: `Message ${commandId}`,
    selectedParticipantIds,
    attachmentRefs: [],
    runtimeOptions: {}
  });

  turn1Id = (await submit('cmd-1', ['part-dev', 'part-qa'])).turnId;
  await until(() => turn1Started);
  const turn2Id = (await submit('cmd-2', ['part-dev', 'part-qa'])).turnId;
  const originalQaInstructions = makeParticipant('qa').instructions;

  // Change runtime defaults and the roster after turns 1 and 2 were accepted.
  defaultModel = 'model-v2';
  await repo.transaction(draft => {
    draft.conversations[0].participants.find(p => p.id === 'part-qa')!.instructions = 'Edited QA instructions';
  });
  const turn3Id = (await submit('cmd-3', ['part-lead'])).turnId;

  held.open();
  await until(() => turnState(coordinator, turn3Id) === 'completed');

  const conv = coordinator.getConversation('conv-1')!;
  for (const id of [turn1Id, turn2Id]) {
    const turn = conv.turns.find(t => t.id === id)!;
    assert.equal(turn.plan.runtimeOptions.model, 'model-v1', 'Accepted turn keeps its runtime defaults');
    assert.equal(turn.plan.participants.find(p => p.role === 'qa')!.instructions, originalQaInstructions, 'Accepted turn keeps its roster');
    for (const run of executed.filter(e => e.turnId === id)) {
      assert.equal(run.model, 'model-v1');
      if (run.role === 'qa') assert.equal(run.instructions, originalQaInstructions);
    }
  }
  const turn3 = conv.turns.find(t => t.id === turn3Id)!;
  assert.equal(turn3.plan.runtimeOptions.model, 'model-v2', 'A later accepted turn takes the new default');
  assert.deepEqual(turn3.plan.participants.map(p => p.role), ['lead'], 'A later accepted turn takes the new roster');
  assert.deepEqual(executed.map(e => `${e.turnId === turn1Id ? 1 : e.turnId === turn2Id ? 2 : 3}:${e.role}`),
    ['1:dev', '1:qa', '2:dev', '2:qa', '3:lead']);
});

test('TASK-478 AC4: A failure pauses the current turn and leaves later turns queued until retried', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  let shouldFail = true;
  const executedTurns: string[] = [];

  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: {
      execute: async ({ participant, turn }) => {
        executedTurns.push(turn.id);
        if (participant.role === 'dev' && shouldFail) throw new Error('Dev provider failed.');
        return { text: `Success from ${participant.role}` };
      }
    }
  });

  const failing = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-fail',
    expectedRevision: 1,
    text: 'Trigger failure',
    selectedParticipantIds: ['part-dev'],
    attachmentRefs: [],
    runtimeOptions: {}
  });
  const queued = await coordinator.submitTurn({
    conversationId: 'conv-1',
    commandId: 'cmd-queued',
    expectedRevision: coordinator.getConversation('conv-1')!.revision,
    text: 'Queued message',
    selectedParticipantIds: ['part-lead'],
    attachmentRefs: [],
    runtimeOptions: {}
  });

  await until(() => turnState(coordinator, failing.turnId) === 'failed');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(turnState(coordinator, failing.turnId), 'failed', 'Current turn must be paused on failure');
  assert.equal(turnState(coordinator, queued.turnId), 'queued', 'Later turn must remain queued');
  assert.ok(!executedTurns.includes(queued.turnId), 'The queued turn never dispatches while the failed turn is paused');

  shouldFail = false;
  await coordinator.retryParticipant('conv-1', failing.turnId, 'part-dev');
  await until(() => turnState(coordinator, queued.turnId) === 'completed');
  assert.equal(turnState(coordinator, failing.turnId), 'completed');
  assert.deepEqual(executedTurns, [failing.turnId, failing.turnId, queued.turnId], 'Turns complete in order after retry');
});

test('TASK-479 AC1: IPC timeout after durable acceptance followed by resubmission returns the original turn ID', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()], { deferred: true });
  const reply = gate();
  let calls = 0;
  const coordinator = new TeamChatCoordinator({
    repository: repo,
    executionAdapter: { execute: async () => { calls++; await reply.wait; return { text: 'ok' }; } }
  });
  const cmd: SubmitConversationCommand = {
    conversationId: 'conv-1', commandId: 'cmd-timeout-test', expectedRevision: 1, text: 'Message that timed out on client',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {}
  };
  // The caller gives up before main's reply arrives; main has already accepted and dispatched.
  const timedOut = await Promise.race([coordinator.submitTurn(cmd).then(() => 'replied'), Promise.resolve('timeout')]);
  assert.equal(timedOut, 'timeout');
  await until(() => calls === 1);
  const committed = repo.read().conversations[0];
  assert.equal(committed.turns.length, 1, 'the turn was durably accepted before the reply was lost');

  const again = await coordinator.submitTurn(cmd);
  assert.equal(again.turnId, committed.turns[0].id, 'Resubmission returns the original turn ID');
  reply.open();
  const done = await settled(coordinator, 'conv-1');
  assert.equal(done.messages.filter(m => m.role === 'user').length, 1, 'One user message');
  assert.equal(done.turns.length, 1, 'One turn');
  assert.equal(done.commandReceipts.length, 1, 'One receipt');
  assert.equal(calls, 1, 'Provider invoked once');
  await assert.rejects(coordinator.submitTurn({ ...cmd, text: 'different payload' }), /Command payload conflict/,
    'Same command ID with a different payload is a conflict');
});

test('subscription emits turn_accepted, attempt and completion revision updates', async () => {
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

test('TASK-479 AC3: Invalid participant, attachment reference, and permission choice are rejected before provider invocation; stale retry targets conflict', async () => {
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

test('TASK-479 AC3: stale retry targets return a conflict with fresh state and dispatch nothing', async () => {
  let calls = 0;
  let fail = true;
  const coordinator = new TeamChatCoordinator({
    repository: new MemoryTeamChatRepository([makeConversation()]),
    executionAdapter: { execute: async () => { calls++; if (fail) throw new Error('provider down'); return { text: 'ok' }; } }
  });
  const { turnId } = await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'c1', expectedRevision: 1, text: 'hi',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: {} });
  await until(() => turnState(coordinator, turnId) === 'failed');
  const failed = coordinator.getConversation('conv-1')!;
  const attempt = failed.turns[0].attempts.at(-1)!;
  const before = calls;
  const retry = { conversationId: 'conv-1', expectedRevision: failed.revision, action: 'retry' as const, turnId, attemptId: attempt.id, participantId: attempt.participantId };

  const staleRevision = await coordinator.controlWithOutcome({ ...retry, commandId: 'r-rev', expectedRevision: failed.revision - 1 });
  assert.deepEqual([staleRevision.status, staleRevision.status === 'conflict' && staleRevision.reason], ['conflict', 'stale-revision']);
  assert.equal(staleRevision.conversation.revision, failed.revision, 'conflict carries fresh state');
  const supersededAttempt = await coordinator.controlWithOutcome({ ...retry, commandId: 'r-att', attemptId: 'attempt-superseded' });
  assert.deepEqual([supersededAttempt.status, supersededAttempt.status === 'conflict' && supersededAttempt.reason], ['conflict', 'stale-target']);
  const wrongMember = await coordinator.controlWithOutcome({ ...retry, commandId: 'r-member', participantId: 'part-dev' });
  assert.deepEqual([wrongMember.status, wrongMember.status === 'conflict' && wrongMember.reason], ['conflict', 'stale-target']);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, before, 'no stale command dispatches');
  assert.equal(coordinator.getConversation('conv-1')!.revision, failed.revision, 'no stale command commits');

  fail = false;
  const applied = await coordinator.controlWithOutcome({ ...retry, commandId: 'r-ok' });
  assert.equal(applied.status, 'applied');
  assert.equal((await coordinator.controlWithOutcome({ ...retry, commandId: 'r-ok' })).status, 'duplicate');
  await until(() => turnState(coordinator, turnId) === 'completed');
  const completed = coordinator.getConversation('conv-1')!;
  const late = await coordinator.controlWithOutcome({ ...retry, commandId: 'r-late', expectedRevision: completed.revision,
    attemptId: completed.turns[0].attempts.at(-1)!.id });
  assert.deepEqual([late.status, late.status === 'conflict' && late.reason], ['conflict', 'not-actionable'], 'retry on a completed turn');
  assert.equal(calls, before + 1);
});

test('cancellation leaves the turn cancelled or, when execution is unresolved, outcome_unknown', async () => {
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
  const sessions = new Map<string, string>();
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: {
    prepare: async ({ conversation, participant }) => ({ conversationId: conversation.id, participantId: participant.id, providerRuntime: 'fixture', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: participant.instructionVersion, canonicalFolder: '/fixture', executionMode: 'chat', toolPolicy: 'read-only', permissionPolicy: 'manual' }),
    execute: async ({ attempt, conversation, nativePrompt }) => {
      const binding = conversation.bindings.find(b => b.id === attempt.bindingId)!;
      const previousSession = sessions.get(binding.id);
      if (previousSession) {
        assert.equal(binding.providerSessionId, previousSession, 'dispatch receives the persisted member session');
        assert.ok(nativePrompt, 'native continuation has a prepared prompt');
      }
      const providerSessionId = previousSession ?? `session:${binding.id}`;
      sessions.set(binding.id, providerSessionId);
      return { text: 'Reply', providerSessionId, contextDelivery: previousSession ? 'native' : 'reconstruction',
        usage: { inputTokens: 2, outputTokens: 3 }, usageReferences: [attempt.id, attempt.id] };
    }
  } });
  for (const [conversationId, commandId] of [['conv-1', 'first'], ['conv-1', 'second'], ['other', 'third']]) {
    await coordinator.submitTurn({ conversationId, commandId, expectedRevision: 1, text: 'Hello', selectedParticipantIds: ['part-dev', 'part-qa'], attachmentRefs: [], runtimeOptions: {} });
    await settled(coordinator, conversationId);
  }
  const conversation = coordinator.getConversation('conv-1')!;
  assert.equal(conversation.turns.flatMap(t => t.attempts).length, 4);
  assert.equal(conversation.bindings.length, 2);
  assert.equal(new Set(conversation.turns.flatMap(t => t.attempts).map(a => a.providerSessionId)).size, 2);
  for (const participantId of ['part-dev', 'part-qa']) {
    const [first, second] = conversation.turns.flatMap(t => t.attempts).filter(a => a.participantId === participantId);
    assert.equal(second.providerSessionId, first.providerSessionId);
    assert.equal(second.bindingId, first.bindingId);
    assert.deepEqual(second.contextReceipt, second.nativeContextReceipt, 'completion records the context actually delivered natively');
    assert.ok(!second.contextReceipt.messageIds.includes(conversation.turns[0].userMessageId), 'native receipt excludes history already delivered');
  }
  assert.equal(sessions.size, 4, 'the other conversation has independent member sessions');
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

for (const text of ['restart result', '']) test('startup imports durable results once across repeated coordinator replacements: ' + JSON.stringify(text), async () => {
  const { repo, turn, attempt } = await recoveryFixture('outcome_unknown');
  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'final', kind: 'final_result', result: { text } });
  let invocations = 0;
  for (let i = 0; i < 2; i++) {
    const coordinator = new TeamChatCoordinator({ repository: repo, idSource: () => 'epoch-' + i,
      executionAdapter: { execute: async () => { invocations++; return { text: 'unexpected' }; } } });
    await coordinator.initialize();
  }
  assert.equal(invocations, 0);
  assert.equal(repo.read().conversations[0].messages.filter(m => m.role === 'lead' && m.text === text).length, 1);
  assert.equal(repo.read().conversations[0].turns.find(t => t.id === turn.id)!.state, 'completed');
});

test('direct unknown-outcome retry requires informed resolution without dispatch', async () => {
  const { coordinator, turn, repo } = await recoveryFixture('outcome_unknown');
  const before = repo.read();
  await assert.rejects(coordinator.retryParticipant('conv-1', turn.id, 'part-lead'), /use resolveAttempt.*duplicate-risk acknowledgement/);
  assert.deepEqual(repo.read(), before);
});

test('startup imports a prepared attempt result without dispatching the provider', async () => {
  const { repo, turn, attempt } = await recoveryFixture('interrupted');
  turn.state = 'running';
  attempt.state = 'prepared';
  delete attempt.dispatchIntent;
  attempt.recoveryEvidence!.push({ ...attempt.recoveryEvidence![0], id: 'prepared-result', kind: 'final_result',
    result: { text: 'Prepared durable reply', usageReferences: ['paid-once'] } });
  let invocations = 0;
  let lastCoordinator!: TeamChatCoordinator;
  for (let i = 0; i < 2; i++) {
    lastCoordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: {
      execute: async () => { invocations++; throw new Error('must not replay'); }
    } });
    await lastCoordinator.initialize();
  }
  await lastCoordinator.resolveAttempt('conv-1', turn.id, attempt.id, 'accept');
  const current = repo.read().conversations[0];
  assert.equal(invocations, 0);
  assert.equal(current.messages.filter(m => m.text === 'Prepared durable reply').length, 1);
  assert.deepEqual(current.turns[0].attempts[0].usageReferences, ['paid-once']);
  assert.equal(current.turns[0].attempts[0].dispatchIntent, undefined);
});

test('revisioned controls reject stale targets and persist idempotent command outcomes', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: { execute: async () => ({ text: 'Done' }) } });
  await coordinator.initialize();
  const current = coordinator.getConversation('conv-1')!;
  current.messages.push({ id: 'decision', turnId: 'imported', role: 'dev', text: 'Keep this', createdAt: 'now', attachments: [], sequence: 1 });
  repo.snapshot.conversations[0] = current;
  const command = { conversationId: current.id, commandId: 'pin-1', expectedRevision: current.revision, action: 'pin' as const, messageId: 'decision' };
  const pinned = await coordinator.control(command);
  assert.deepEqual(pinned.pinnedMessageIds, ['decision']);
  const repeat = await coordinator.control(command);
  assert.equal(repeat.revision, pinned.revision);
  assert.equal(repeat.controlReceipts?.length, 1);
  await assert.rejects(coordinator.control({ ...command, messageId: 'other' }), /payload conflict/);
  const stale = await coordinator.control({ ...command, commandId: 'stale', action: 'unpin' });
  assert.deepEqual(stale.pinnedMessageIds, ['decision']);
  const unpinned = await coordinator.control({ ...command, commandId: 'unpin', expectedRevision: pinned.revision, action: 'unpin' });
  assert.deepEqual(unpinned.pinnedMessageIds, []);
});

test('deletion during dispatch fences late results and never recreates a conversation', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  let release!: (result: { text: string }) => void;
  let entered!: () => void;
  const executing = new Promise<void>(resolve => { entered = resolve; });
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: { execute: async () => {
    entered(); return new Promise(resolve => { release = resolve; });
  } } });
  await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'delete-race', expectedRevision: 1, text: 'Original', selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: {} });
  await executing;
  await coordinator.removeConversation('conv-1');
  release({ text: 'Late answer' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(coordinator.getConversation('conv-1'), undefined);
  assert.equal(repo.read().conversations.length, 0);
});

test('a structured execution result and original page identity survive completion', async () => {
  const repo = new MemoryTeamChatRepository([makeConversation()]);
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: { execute: async () => ({ text: 'Proposal', choices: [{ label: 'Next', prompt: 'Continue' }], proposedAction: { kind: 'update-ticket', label: 'Apply', summary: 'Details', description: 'New body' } }) } });
  await coordinator.submitTurn({ conversationId: 'conv-1', commandId: 'structured', expectedRevision: 1, text: 'Original', selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: {}, context: { pageType: 'issue', title: 'Issue P-1', issueKey: 'P-1', summary: 'Original' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const message = coordinator.getConversation('conv-1')!.messages.at(-1)!;
  assert.equal(message.context?.issueKey, 'P-1');
  assert.equal(message.proposedAction?.kind, 'update-ticket');
  assert.equal(message.choices?.[0].prompt, 'Continue');
});

test('queued page identity and attachment references survive caller mutation before dispatch', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  let captured: import('./teamChatCoordinator').TeamChatExecutionParams | undefined;
  const coordinator = new TeamChatCoordinator({ repository: new MemoryTeamChatRepository([makeConversation()]), executionAdapter: {
    validateAttachments: async () => {},
    execute: async params => {
      if (params.turn.commandId === 'first') { started(); await gate; }
      else captured = structuredClone({ ...params, signal: undefined, onAccepted: undefined, onEvidence: undefined });
      return { text: 'Reply' };
    }
  } });
  const command: SubmitConversationCommand = {
    conversationId: 'conv-1', commandId: 'first', expectedRevision: 1, text: 'First',
    selectedParticipantIds: ['part-dev'], attachmentRefs: [], runtimeOptions: {}
  };
  await coordinator.submitTurn(command);
  await running;
  try {
    const queued: SubmitConversationCommand = { ...command, commandId: 'queued', text: 'Captured question',
      context: { pageType: 'issue', entityId: 'original-issue', title: 'Original issue', summary: 'Original context' },
      attachmentRefs: [{ id: 'original-image', digest: 'original-digest', mediaType: 'image/png', size: 42 }] };
    await coordinator.submitTurn(queued);
    assert.equal(coordinator.getConversation('conv-1')!.turns[1].state, 'queued');
    queued.context!.entityId = 'navigated-issue';
    queued.context!.summary = 'Changed composer context';
    queued.attachmentRefs[0].digest = 'replacement-digest';
    queued.attachmentRefs.length = 0;
    queued.text = 'Changed draft';
  } finally { release(); }
  const conversation = await settled(coordinator, 'conv-1');
  assert.equal(conversation.turns[1].state, 'completed');
  assert.equal(captured!.turn.plan.context!.entityId, 'original-issue');
  const message = captured!.messages.find(message => message.text === 'Captured question')!;
  assert.equal(message.context!.summary, 'Original context');
  assert.deepEqual(message.attachments, [{ id: 'original-image', digest: 'original-digest', mediaType: 'image/png', size: 42 }]);
});
