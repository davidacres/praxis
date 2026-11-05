import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TeamChatCoordinator, makeParticipant, type TeamChatExecutionAdapter, type TeamChatExecutionParams } from './teamChatCoordinator';
import { recordAttemptApproval, resolveAttemptApproval, restoreAttemptApproval } from './teamChatTransitions';
import type { DurableConversation, SubmitConversationCommand, TeamChatRepository, TeamChatSnapshot } from './assistantTypes';

class MemoryRepository implements TeamChatRepository {
  public snapshot: TeamChatSnapshot;
  public constructor(initial: TeamChatSnapshot) { this.snapshot = structuredClone(initial); }
  public read(): TeamChatSnapshot { return structuredClone(this.snapshot); }
  public async transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
    const draft = structuredClone(this.snapshot);
    const result = mutate(draft);
    draft.revision = this.snapshot.revision + 1;
    this.snapshot = structuredClone(draft);
    return structuredClone(result);
  }
}

function conversation(id = 'conv'): DurableConversation {
  return { id, schemaVersion: 2, revision: 1, title: id, createdAt: 'then', updatedAt: 'then', coordinatorEpoch: 'epoch-origin',
    participants: ['dev', 'qa', 'lead'].map(role => makeParticipant(role as 'dev')), messages: [], turns: [], bindings: [],
    summaries: [], pinnedMessageIds: [], commandReceipts: [] };
}
function command(overrides: Partial<SubmitConversationCommand> = {}): SubmitConversationCommand {
  return { conversationId: 'conv', commandId: 'cmd-1', expectedRevision: 1, text: 'Review this', selectedParticipantIds: ['part-dev', 'part-qa', 'part-lead'],
    attachmentRefs: [], runtimeOptions: { permissionMode: 'manual', toolMode: 'full' }, ...overrides };
}
function sequenceIds(prefix: string): () => string { let n = 0; return () => `${prefix}-${++n}`; }
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) { if (check()) return; await tick(); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const never = () => new Promise<never>(() => undefined);
const turn0 = (repo: MemoryRepository, id = 'conv') => repo.snapshot.conversations.find(c => c.id === id)!.turns[0];
const attemptsOf = (repo: MemoryRepository, participantId: string) => turn0(repo).attempts.filter(a => a.participantId === participantId);

test('cancel keeps completed replies, skips remaining members, cancels queued turns and leaves other conversations alone', async () => {
  const repo = new MemoryRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation(), conversation('other')] });
  const executed: string[] = [];
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('a'), executionAdapter: {
    execute: async (params: TeamChatExecutionParams) => {
      executed.push(`${params.conversation.id}:${params.participant.id}`);
      if (params.conversation.id === 'conv' && params.participant.id === 'part-qa') {
        await params.onAccepted!();
        await params.onEvidence!({ kind: 'partial_output', provenance: 'adapter', data: { text: 'half a review' } });
        return never();
      }
      return { text: `${params.participant.id} reply` };
    } } });
  await coordinator.submitTurn(command());
  await coordinator.submitTurn(command({ commandId: 'cmd-2', expectedRevision: repo.snapshot.conversations[0].revision, text: 'Queued follow-up' }));
  await coordinator.submitTurn(command({ conversationId: 'other', commandId: 'cmd-o', selectedParticipantIds: ['part-dev'] }));
  await until(() => attemptsOf(repo, 'part-qa')[0]?.state === 'running', 'qa running');
  await until(() => turn0(repo, 'other').state === 'completed', 'other conversation completes');
  const turnId = turn0(repo).id;
  await coordinator.cancelTurn('conv', turnId);
  const cancelling = turn0(repo);
  assert.equal(cancelling.state, 'cancelling', 'a running attempt stays cancelling until it settles');
  assert.deepEqual(cancelling.completedParticipantIds, ['part-dev']);
  assert.deepEqual(cancelling.skippedParticipantIds, ['part-lead']);
  assert.equal(repo.snapshot.conversations[0].turns[1].state, 'cancelled');
  assert.equal(repo.snapshot.conversations[0].messages.filter(m => m.role === 'dev').length, 1, 'completed reply is retained');
  assert.equal(turn0(repo, 'other').state, 'completed');
});

test('cancel retains partial output as evidence and an unsettled tool becomes outcome_unknown', async () => {
  const repo = new MemoryRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('b'), executionAdapter: {
    execute: async params => {
      await params.onAccepted!();
      await params.onEvidence!({ kind: 'partial_output', provenance: 'adapter', data: { text: 'partial' } });
      await new Promise<void>(resolve => params.signal!.addEventListener('abort', () => resolve()));
      await params.onEvidence!({ kind: 'partial_output', provenance: 'adapter', data: { text: 'partial after abort' } });
      throw new Error('aborted');
    } } });
  await coordinator.submitTurn(command({ selectedParticipantIds: ['part-dev'] }));
  await until(() => attemptsOf(repo, 'part-dev')[0]?.state === 'running', 'running');
  await coordinator.cancelTurn('conv', turn0(repo).id);
  await until(() => turn0(repo).state !== 'cancelling', 'settlement');
  const attempt = attemptsOf(repo, 'part-dev')[0];
  assert.equal(attempt.state, 'outcome_unknown');
  assert.equal(turn0(repo).state, 'outcome_unknown');
  assert.deepEqual(attempt.recoveryEvidence!.filter(e => e.kind === 'partial_output').map(e => e.data?.text), ['partial', 'partial after abort']);
});

test('retry appends one attempt for the failed member, keeps predecessors and resumes successors exactly once', async () => {
  const repo = new MemoryRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  const calls: string[] = [];
  let qaFails = true;
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('c'), executionAdapter: {
    execute: async params => {
      calls.push(params.participant.id);
      if (params.participant.id === 'part-qa' && qaFails) { qaFails = false; throw new Error('provider down'); }
      return { text: `${params.participant.id} reply` };
    } } });
  await coordinator.submitTurn(command());
  await until(() => turn0(repo).state === 'failed', 'qa failure');
  assert.deepEqual(calls, ['part-dev', 'part-qa']);
  const turnId = turn0(repo).id;
  await assert.rejects(coordinator.retryParticipant('conv', turnId, 'part-dev'), /Stale or invalid retry target/);
  await coordinator.retryParticipant('conv', turnId, 'part-qa');
  await until(() => turn0(repo).state === 'completed', 'completion');
  assert.deepEqual(calls, ['part-dev', 'part-qa', 'part-qa', 'part-lead']);
  assert.equal(attemptsOf(repo, 'part-dev').length, 1);
  assert.deepEqual(attemptsOf(repo, 'part-qa').map(a => [a.ordinal, a.state]), [[1, 'failed'], [2, 'completed']]);
  assert.equal(attemptsOf(repo, 'part-lead').length, 1);
});

test('approval identity is recorded on the attempt, fenced, and resolvable only by its request id', async () => {
  const repo = new MemoryRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  let release!: () => void;
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('d'), executionAdapter: {
    execute: async params => {
      await params.onAccepted!();
      await params.onApproval!({ runtimeRequestId: 'req-1' });
      await new Promise<void>(resolve => { release = resolve; });
      await assert.rejects(params.onApproval!({ runtimeRequestId: 'other', resolved: true }), /fenced approval resolution/);
      await params.onApproval!({ runtimeRequestId: 'req-1', resolved: true });
      return { text: 'done' };
    } } });
  await coordinator.submitTurn(command({ selectedParticipantIds: ['part-dev'] }));
  await until(() => attemptsOf(repo, 'part-dev')[0]?.state === 'awaiting_approval', 'awaiting approval');
  assert.equal(attemptsOf(repo, 'part-dev')[0].pendingApproval?.runtimeRequestId, 'req-1');
  release();
  await until(() => turn0(repo).state === 'completed', 'completion');
  assert.equal(attemptsOf(repo, 'part-dev')[0].pendingApproval?.status, 'resolved');
});

async function crashedWithApproval(): Promise<TeamChatSnapshot> {
  const repo = new MemoryRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  const first = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('first'), executionAdapter: {
    execute: async params => { await params.onAccepted!(); await params.onApproval!({ runtimeRequestId: 'req-1' }); return never(); } } });
  await first.submitTurn(command({ selectedParticipantIds: ['part-dev'] }));
  await until(() => attemptsOf(repo, 'part-dev')[0]?.state === 'awaiting_approval', 'awaiting approval');
  return repo.read();
}

async function restartWith(snapshot: TeamChatSnapshot, live: TeamChatExecutionAdapter['listLiveApprovals']) {
  const repo = new MemoryRepository(snapshot);
  const updates: string[] = [];
  const calls: string[] = [];
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('second'), onUpdate: u => updates.push(u.type), executionAdapter: {
    execute: async params => { calls.push(params.attempt.id); return { text: 'replacement' }; }, listLiveApprovals: live } });
  await coordinator.initialize();
  await tick(20);
  return { repo, updates, calls, coordinator };
}

test('restart invalidates the approval and restores it on the same attempt only for a live matching request', async () => {
  const crashed = await crashedWithApproval();
  const originalId = crashed.conversations[0].turns[0].attempts[0].id;
  const restored = await restartWith(crashed, async attempt => [{ requestId: 'req-1', attemptId: attempt.id }]);
  const attempt = attemptsOf(restored.repo, 'part-dev')[0];
  assert.equal(attempt.pendingApproval?.status, 'restored');
  assert.equal(attempt.pendingApproval?.restoredEpoch, 'second-1');
  assert.equal(attempt.id, originalId);
  assert.equal(attemptsOf(restored.repo, 'part-dev').length, 1, 'no new attempt is created');
  assert.ok(restored.updates.includes('approval_restored'));
  assert.equal(restored.calls.length, 0);
  assert.equal(attempt.state, 'outcome_unknown', 'restoration never makes the attempt look safe');
});

test('without a live matching request the approval stays invalidated and is never transferred', async () => {
  const crashed = await crashedWithApproval();
  const cases: Array<[string, TeamChatExecutionAdapter['listLiveApprovals']]> = [
    ['no adapter hook', undefined],
    ['empty queue', async () => []],
    ['different request id', async attempt => [{ requestId: 'req-2', attemptId: attempt.id }]],
    ['different attempt', async () => [{ requestId: 'req-1', attemptId: 'someone-else' }]],
    ['enumeration failure', async () => { throw new Error('runtime gone'); }]
  ];
  for (const [label, live] of cases) {
    const result = await restartWith(structuredClone(crashed), live);
    const attempt = attemptsOf(result.repo, 'part-dev')[0];
    assert.equal(attempt.pendingApproval?.status, 'invalidated', label);
    assert.ok(['interrupted', 'outcome_unknown'].includes(attempt.state), label);
    assert.equal(attemptsOf(result.repo, 'part-dev').length, 1, label);
    assert.equal(result.calls.length, 0, label);
    assert.ok(result.updates.includes('approval_invalidated') && !result.updates.includes('approval_restored'), label);
  }
});

test('approval callbacks and restoration from a stale epoch are rejected', async () => {
  const crashed = await crashedWithApproval();
  const c = crashed.conversations[0];
  const attempt = c.turns[0].attempts[0];
  assert.throws(() => resolveAttemptApproval(c, c.revision, c.turns[0].id, attempt.id, 'epoch-other', 'req-1'), /fenced approval resolution/);
  assert.throws(() => recordAttemptApproval(c, c.revision, c.turns[0].id, attempt.id, 'epoch-other', 'req-9', 'now'), /fenced approval request/);
  const { repo } = await restartWith(crashed, undefined);
  const next = repo.snapshot.conversations[0];
  assert.throws(() => resolveAttemptApproval(next, next.revision, next.turns[0].id, attempt.id, c.coordinatorEpoch, 'req-1'), /fenced approval resolution/);
  assert.throws(() => restoreAttemptApproval(next, next.revision, next.turns[0].id, attempt.id, next.coordinatorEpoch, 'req-wrong', 'now'), /cannot be restored/);
});

test('an unknown-outcome retry needs acknowledgement and evidence and is marked as user-authorized', async () => {
  const crashed = await crashedWithApproval();
  const { repo, calls, coordinator } = await restartWith(crashed, undefined);
  const turnId = turn0(repo).id;
  const unknown = attemptsOf(repo, 'part-dev')[0];
  assert.equal(unknown.state, 'outcome_unknown');
  await assert.rejects(coordinator.retryParticipant('conv', turnId, 'part-dev'), /Unknown outcome/);
  await assert.rejects(coordinator.resolveAttempt('conv', turnId, unknown.id, 'retry'), /requires reconciliation evidence/);
  await assert.rejects(coordinator.resolveAttempt('conv', turnId, unknown.id, 'retry',
    { acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: 'missing' }), /requires reconciliation evidence/);
  assert.equal(calls.length, 0, 'no provider runs before the user acts');
  const evidence = unknown.recoveryEvidence!.find(e => e.kind === 'reconciliation')!;
  await coordinator.resolveAttempt('conv', turnId, unknown.id, 'retry', { acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: evidence.id });
  await until(() => turn0(repo).state === 'completed', 'completion');
  const decision = attemptsOf(repo, 'part-dev')[0].recoveryEvidence!.find(e => e.kind === 'decision')!;
  assert.equal(decision.provenance, 'user');
  assert.deepEqual([decision.data?.retryKind, decision.data?.acknowledgeDuplicateActionRisk, decision.data?.reconciliationEvidenceId],
    ['user-authorized-unknown', true, evidence.id]);
  assert.equal(attemptsOf(repo, 'part-dev').length, 2);
  assert.equal(calls.length, 1);
});
