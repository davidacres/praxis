import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TeamChatCoordinator, makeParticipant, type TeamChatExecutionAdapter, type TeamChatExecutionParams } from './teamChatCoordinator';
import { advanceConversationAttempt } from './teamChatTransitions';
import type { DurableConversation, SubmitConversationCommand, TeamChatRepository, TeamChatSnapshot } from './assistantTypes';

/**
 * File-faithful in-memory repository: every read and commit is a deep clone, every
 * commit is kept in `history`, and `fault` can refuse a commit before it lands.
 * "Crashing" at a boundary means taking one committed snapshot from `history` and
 * starting a brand-new coordinator over it, which is what a process restart sees.
 */
class CrashableRepository implements TeamChatRepository {
  public snapshot: TeamChatSnapshot;
  public readonly history: TeamChatSnapshot[] = [];
  public fault?: (draft: TeamChatSnapshot) => boolean;
  public constructor(initial: TeamChatSnapshot) { this.snapshot = structuredClone(initial); }
  public read(): TeamChatSnapshot { return structuredClone(this.snapshot); }
  public async transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
    const draft = structuredClone(this.snapshot);
    const result = mutate(draft);
    if (this.fault?.(draft)) throw new Error('Injected commit fault.');
    draft.revision = this.snapshot.revision + 1;
    this.snapshot = structuredClone(draft);
    this.history.push(structuredClone(draft));
    return structuredClone(result);
  }
}

function conversation(): DurableConversation {
  return { id: 'conv', schemaVersion: 2, revision: 1, title: 'Crash', createdAt: 'then', updatedAt: 'then',
    coordinatorEpoch: 'epoch-origin', participants: ['dev', 'qa', 'lead'].map(role => makeParticipant(role as 'dev')),
    messages: [], turns: [], bindings: [], summaries: [], pinnedMessageIds: [], commandReceipts: [] };
}
function command(overrides: Partial<SubmitConversationCommand> = {}): SubmitConversationCommand {
  return { conversationId: 'conv', commandId: 'cmd-1', expectedRevision: 1, text: 'Ship it?',
    selectedParticipantIds: ['part-lead'], attachmentRefs: [], runtimeOptions: { permissionMode: 'manual' }, ...overrides };
}
const conv = (snapshot: TeamChatSnapshot) => snapshot.conversations[0];
const lastAttempt = (snapshot: TeamChatSnapshot) => conv(snapshot).turns[0]?.attempts.at(-1);
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Drive a first process until `boundary` is committed, then return that committed snapshot. */
async function crashAt(boundary: (snapshot: TeamChatSnapshot) => boolean, execute: TeamChatExecutionAdapter['execute'],
  submit: SubmitConversationCommand = command()): Promise<TeamChatSnapshot> {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  const first = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('first'), executionAdapter: { execute } });
  await first.submitTurn(submit);
  await until(() => repo.history.some(boundary), 'the crash boundary');
  return structuredClone(repo.history.find(boundary)!);
}
function sequenceIds(prefix: string): () => string { let n = 0; return () => `${prefix}-${++n}`; }
/** A second process: a fresh coordinator and a fresh epoch over the crashed bytes. */
function restart(snapshot: TeamChatSnapshot, execute: TeamChatExecutionAdapter['execute'], prefix = 'restart') {
  const repo = new CrashableRepository(snapshot);
  const calls: TeamChatExecutionParams[] = [];
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds(prefix),
    executionAdapter: { execute: async params => { calls.push(params); return execute(params); } } });
  return { repo, coordinator, calls };
}
const never = () => new Promise<never>(() => undefined);

test('crash after acceptance with no dispatch intent schedules the turn exactly once after startup', async () => {
  const crashed = await crashAt(s => conv(s).turns.length === 1 && conv(s).turns[0].state === 'queued', never);
  assert.equal(conv(crashed).turns[0].attempts.length, 0);
  const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'After restart' }));
  await coordinator.initialize();
  await until(() => conv(repo.snapshot).turns[0].state === 'completed', 'completion');
  assert.equal(calls.length, 1);
  assert.equal(conv(repo.snapshot).messages.filter(m => m.text === 'After restart').length, 1);
  assert.equal(conv(repo.snapshot).turns[0].attempts[0].coordinatorEpoch, 'restart-1');
  // A second restart over the completed bytes dispatches nothing.
  const again = restart(repo.read(), async () => ({ text: 'unexpected' }), 'second-restart');
  await again.coordinator.initialize();
  await tick(20);
  assert.equal(again.calls.length, 0);
});

test('crash with prepared context but no dispatch intent re-prepares without invoking the provider before reconciliation', async () => {
  const crashed = await crashAt(s => lastAttempt(s)?.state === 'prepared', never);
  assert.equal(lastAttempt(crashed)!.dispatchIntent, undefined);
  const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'Retried' }));
  await coordinator.initialize();
  await tick(20);
  assert.equal(calls.length, 0, 'startup reconciliation must not dispatch');
  assert.equal(conv(repo.snapshot).turns[0].state, 'interrupted');
  assert.equal(lastAttempt(repo.snapshot)!.state, 'interrupted');
  await coordinator.retryParticipant('conv', conv(repo.snapshot).turns[0].id, 'part-lead');
  await until(() => conv(repo.snapshot).turns[0].state === 'completed', 'retry completion');
  assert.equal(calls.length, 1);
  const attempts = conv(repo.snapshot).turns[0].attempts;
  assert.deepEqual(attempts.map(a => [a.ordinal, a.state]), [[1, 'interrupted'], [2, 'completed']]);
  assert.ok(calls[0].preparedPrompt?.includes('Ship it?'), 'the replacement attempt prepares its own context');
});

for (const capability of ['text', 'tools', 'opaque'] as const) {
  test(`crash after dispatch intent marks text-only attempts interrupted and tool-capable or opaque attempts outcome_unknown: ${capability}`, async () => {
    const crashed = await crashAt(s => Boolean(lastAttempt(s)?.dispatchIntent) &&
      (capability === 'opaque' || Boolean(lastAttempt(s)?.recoveryEvidence?.some(e => e.kind === 'runtime_identity'))), async params => {
      if (capability !== 'opaque') await params.onEvidence!({ kind: 'runtime_identity', provenance: 'adapter', data: { toolCapable: capability === 'tools' } });
      return never();
    });
    const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'unexpected' }));
    await coordinator.initialize();
    await tick(20);
    const expected = capability === 'text' ? 'interrupted' : 'outcome_unknown';
    assert.equal(lastAttempt(repo.snapshot)!.state, expected);
    assert.equal(conv(repo.snapshot).turns[0].state, expected);
    assert.equal(calls.length, 0);
    assert.ok(lastAttempt(repo.snapshot)!.recoveryEvidence!.some(e => e.kind === 'reconciliation' && e.observingEpoch === 'restart-1'));
  });
}

test('a persisted final result for the attempt imports once and continues pending members', async () => {
  const crashed = await crashAt(s => {
    const attempt = conv(s).turns[0]?.attempts[0];
    return Boolean(attempt?.recoveryEvidence?.some(e => e.kind === 'final_result')) && attempt!.state !== 'completed';
  }, async params => ({ text: `${params.participant.role} answer`, usage: { inputTokens: 10, outputTokens: 5 }, usageReferences: ['usage-dev'] }),
  command({ selectedParticipantIds: ['part-dev', 'part-lead'] }));
  assert.equal(conv(crashed).messages.length, 1, 'no reply message was committed before the crash');
  const { repo, coordinator, calls } = restart(crashed, async params => ({ text: `${params.participant.role} after restart` }));
  await coordinator.initialize();
  await until(() => conv(repo.snapshot).turns[0].state === 'completed', 'completion');
  const after = conv(repo.snapshot);
  assert.deepEqual(calls.map(c => c.participant.role), ['lead'], 'only the pending member executes');
  assert.equal(after.messages.filter(m => m.text === 'dev answer').length, 1);
  assert.deepEqual(after.turns[0].attempts[0].usageReferences, ['usage-dev']);
  assert.deepEqual(after.turns[0].attempts[0].usage, { inputTokens: 10, outputTokens: 5 });
});

test('a tool that may have run with no final reply stays outcome_unknown and is never replayed automatically', async () => {
  const crashed = await crashAt(s => Boolean(lastAttempt(s)?.recoveryEvidence?.some(e => e.kind === 'tool_activity')), async params => {
    await params.onAccepted!();
    await params.onEvidence!({ kind: 'tool_activity', provenance: 'adapter', data: { tool: 'write_file' } });
    return never();
  });
  for (let restartCount = 0; restartCount < 2; restartCount++) {
    const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'replayed' }));
    await coordinator.initialize();
    await tick(20);
    assert.equal(calls.length, 0);
    assert.equal(lastAttempt(repo.snapshot)!.state, 'outcome_unknown');
    const turn = conv(repo.snapshot).turns[0];
    await assert.rejects(coordinator.retryParticipant('conv', turn.id, 'part-lead'), /reconciliation evidence/);
    await assert.rejects(coordinator.resolveAttempt('conv', turn.id, lastAttempt(repo.snapshot)!.id, 'retry'), /duplicate-action risk/);
    assert.equal(calls.length, 0);
  }
});

test('a committed final reply whose acknowledgement was lost replays display events only', async () => {
  const crashed = await crashAt(s => conv(s).turns[0]?.state === 'completed', async () => ({ text: 'Committed reply' }));
  const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'unexpected' }));
  const updates: string[] = [];
  coordinator.subscribe('conv', update => updates.push(update.type));
  await coordinator.initialize();
  // The renderer resubmits the command whose acknowledgement it never saw.
  const resubmitted = await coordinator.submitTurn(command());
  await tick(20);
  assert.equal(calls.length, 0, 'the provider is never invoked again');
  assert.equal(resubmitted.turnId, conv(crashed).turns[0].id);
  assert.equal(resubmitted.state, 'completed');
  assert.equal(conv(repo.snapshot).messages.filter(m => m.text === 'Committed reply').length, 1);
  assert.equal(conv(repo.snapshot).turns.length, 1);
  assert.ok(!updates.includes('turn_accepted'));
});

test('a pending approval at crash is never reused by the replacement attempt', async () => {
  // Production never projects awaiting_approval onto the attempt (the runtime record holds it),
  // so a crash during a permission prompt is seen as a running, dispatched attempt. Cover both
  // that real shape and the design's awaiting_approval projection.
  for (const projected of [false, true]) {
    let crashed = await crashAt(s => lastAttempt(s)?.state === 'running', async params => {
      await params.onAccepted!();
      return never();
    }, command({ runtimeOptions: { permissionMode: 'manual', toolMode: 'full' } }));
    if (projected) {
      const c = conv(crashed);
      crashed = { ...crashed, conversations: [advanceConversationAttempt(c, c.revision, c.turns[0].id, lastAttempt(crashed)!.id,
        c.coordinatorEpoch, 'awaiting_approval', 'later')] };
    }
    const { repo, coordinator, calls } = restart(crashed, async () => ({ text: 'Replacement reply' }));
    await coordinator.initialize();
    await tick(20);
    const recovered = lastAttempt(repo.snapshot)!;
    // A pending prompt cannot exclude earlier tool activity in this attempt. Without
    // durable no-action evidence the replacement must require informed reconciliation.
    assert.equal(recovered.state, 'outcome_unknown');
    assert.equal(calls.length, 0);
    const observation = recovered.recoveryEvidence!.find(e => e.kind === 'reconciliation')!;
    await coordinator.resolveAttempt('conv', conv(repo.snapshot).turns[0].id, recovered.id, 'retry',
      { acknowledgeDuplicateActionRisk: true, reconciliationEvidenceId: observation.id });
    await until(() => conv(repo.snapshot).turns[0].state === 'completed', 'replacement completion');
    assert.equal(calls.length, 1);
    const replacement = calls[0];
    assert.notEqual(replacement.attempt.id, recovered.id);
    assert.equal(replacement.attempt.ordinal, 2);
    assert.equal(replacement.turn.plan.runtimeOptions.permissionMode, 'manual');
    assert.equal('autoApprovePermissions' in replacement.turn.plan.runtimeOptions, false);
    assert.equal(replacement.attempt.recoveryEvidence, undefined, 'no approval or evidence is carried to the replacement');
  }
});

test('late callbacks from a previous epoch never double-commit', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  let releaseOld!: (value: { text: string }) => void;
  const old = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('old'), executionAdapter: {
    execute: async params => { await params.onAccepted!(); return new Promise(resolve => { releaseOld = resolve; }); }
  } });
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  try {
    await old.submitTurn(command());
    await until(() => lastAttempt(repo.snapshot)?.state === 'running', 'old dispatch');
    // The new process shares the same bytes; the old process is still alive enough to call back.
    let replacementCalls = 0;
    const replacement = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('new'),
      executionAdapter: { execute: async () => { replacementCalls++; return { text: 'replacement' }; } } });
    await replacement.initialize();
    const fenced = repo.read();
    releaseOld({ text: 'Late reply' });
    await tick(30);
    assert.equal(replacementCalls, 0);
    assert.equal(conv(repo.snapshot).messages.filter(m => m.role === 'lead').length, 0);
    assert.equal(lastAttempt(repo.snapshot)!.state, 'outcome_unknown');
    assert.deepEqual(conv(repo.snapshot).turns, conv(fenced).turns, 'the late callback changed nothing');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, [], 'a fenced late callback settles without an unhandled rejection');
});

test('duplicate runtime events and a duplicate submit command converge to one turn and one usage reference', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  let calls = 0;
  const coordinator = new TeamChatCoordinator({ repository: repo, executionAdapter: { execute: async params => {
    calls++;
    await Promise.all([params.onAccepted!(), params.onAccepted!()]);
    await params.onAccepted!();
    return { text: 'Once', usage: { inputTokens: 100, outputTokens: 20 }, usageReferences: ['usage-1', 'usage-1'], toolEvidenceReferences: ['tool-1', 'tool-1'] };
  } } });
  const [a, b] = await Promise.all([coordinator.submitTurn(command()), coordinator.submitTurn(command())]);
  const c = await coordinator.submitTurn(command());
  assert.equal(a.turnId, b.turnId);
  assert.equal(a.turnId, c.turnId);
  await until(() => conv(repo.snapshot).turns[0]?.state === 'completed', 'completion');
  await tick(20);
  const after = conv(repo.snapshot);
  assert.equal(calls, 1);
  assert.equal(after.turns.length, 1);
  assert.equal(after.commandReceipts.length, 1);
  assert.equal(after.messages.filter(m => m.text === 'Once').length, 1);
  const attempt = after.turns[0].attempts[0];
  assert.deepEqual(attempt.usageReferences, ['usage-1']);
  assert.deepEqual(attempt.toolEvidenceReferences, ['tool-1']);
  const totals = after.turns.flatMap(t => t.attempts).reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0), 0);
  assert.equal(totals, 120, 'token totals are counted once');
  await assert.rejects(coordinator.submitTurn(command({ text: 'Different payload' })), /payload conflict/);
});

test('a fault between reserve and complete leaves the snapshot at the prior committed revision', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  repo.fault = draft => conv(draft).turns[0]?.attempts[0]?.state === 'completed';
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  let calls = 0;
  const failures: (string | undefined)[] = [];
  try {
    const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('fault'),
      executionAdapter: { execute: async params => { calls++; await params.onAccepted!(); return { text: 'Durable answer' }; } } });
    coordinator.subscribe('conv', update => { if (update.type === 'turn_failed') failures.push(update.error); });
    await coordinator.submitTurn(command());
    await until(() => Boolean(lastAttempt(repo.snapshot)?.recoveryEvidence?.some(e => e.kind === 'final_result')), 'final result evidence');
    await tick(20);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  const prior = repo.history.at(-1)!;
  assert.deepEqual(repo.snapshot, prior, 'the faulted transaction committed nothing');
  assert.equal(lastAttempt(repo.snapshot)!.state, 'running');
  assert.equal(conv(repo.snapshot).messages.length, 1);
  repo.fault = undefined;
  const { repo: restarted, coordinator, calls: replays } = restart(repo.read(), async () => ({ text: 'unexpected' }));
  await coordinator.initialize();
  await until(() => conv(restarted.snapshot).turns[0].state === 'completed', 'import after restart');
  assert.equal(calls + replays.length, 1, 'the provider ran exactly once across the fault and restart');
  assert.equal(conv(restarted.snapshot).messages.filter(m => m.text === 'Durable answer').length, 1);
  assert.deepEqual(rejections, [], 'the detached loop reports the fault instead of rejecting unhandled');
  assert.deepEqual(failures, ['Injected commit fault. Restart Praxis to recover this team chat.'], 'subscribers are told the turn stopped');
});

test('after a loop fault, later queued turns stay queued and never re-dispatch the unknown attempt until startup recovery', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  repo.fault = draft => conv(draft).turns[0]?.attempts[0]?.state === 'completed';
  let calls = 0;
  const failures: (string | undefined)[] = [];
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('halt'),
    executionAdapter: { execute: async params => { calls++; await params.onAccepted!(); return { text: `Answer ${calls}` }; } } });
  coordinator.subscribe('conv', update => {
    if (update.type === 'turn_failed') failures.push(update.error);
    // A throwing listener must not escape the detached loop.
    if (update.type === 'turn_failed') throw new Error('listener broke');
  });
  await coordinator.submitTurn(command());
  await until(() => failures.length === 1, 'the loop fault');
  repo.fault = undefined;
  // Storage works again; the command commits but dispatch stays halted in this process.
  await coordinator.submitTurn(command({ commandId: 'cmd-2', expectedRevision: conv(repo.snapshot).revision, text: 'And then?' }));
  await tick(20);
  assert.equal(calls, 1, 'the running attempt with an unknown outcome was not dispatched again');
  assert.equal(conv(repo.snapshot).turns[0].state, 'running');
  assert.equal(conv(repo.snapshot).turns[1].state, 'queued', 'the later turn is kept, not failed');
  assert.equal(failures.length, 2, 'the halted conversation reports again when new work arrives');
  const { repo: restarted, coordinator: next, calls: replays } = restart(repo.read(), async params => ({ text: `After restart ${params.turn.id}` }));
  await next.initialize();
  await until(() => conv(restarted.snapshot).turns[1]?.state === 'completed', 'the queued turn after restart');
  assert.equal(conv(restarted.snapshot).turns[0].state === 'running', false, 'startup reconciled the faulted turn');
  assert.equal(replays.filter(p => p.turn.id === conv(restarted.snapshot).turns[0].id).length, 0, 'the faulted turn was never replayed');
});

test('a late completion after cancel never restarts the turn or appends a reply, and cancel aborts the attempt claim', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  let release!: (value: { text: string }) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('cancel'), executionAdapter: { execute: async params => {
    calls++;
    signal = params.signal;
    await params.onAccepted!();
    return new Promise<{ text: string }>(resolve => { release = resolve; });
  } } });
  await coordinator.submitTurn(command());
  await until(() => lastAttempt(repo.snapshot)?.state === 'running', 'running attempt');
  const turnId = conv(repo.snapshot).turns[0].id;
  await coordinator.cancelTurn('conv', turnId);
  assert.equal(signal?.aborted, true, 'cancel aborts the current attempt by its turn');
  release({ text: 'Late reply' });
  await tick(30);
  const after = conv(repo.snapshot);
  assert.notEqual(after.turns[0].state, 'running', 'a late completion never restarts the cancelled turn');
  assert.ok(after.messages.filter(m => m.text === 'Late reply').length <= 1, 'the late result is imported at most once');
  release({ text: 'Late reply' });
  await tick(20);
  assert.equal(conv(repo.snapshot).messages.filter(m => m.text === 'Late reply').length, after.messages.filter(m => m.text === 'Late reply').length);
  assert.equal(after.turns[0].attempts.length, 1);
  assert.equal(calls, 1);
});

test('a settled attempt releases only its own abort claim', async () => {
  const repo = new CrashableRepository({ schemaVersion: 2, revision: 0, teamChats: [], conversations: [conversation()] });
  const coordinator = new TeamChatCoordinator({ repository: repo, idSource: sequenceIds('claim'),
    executionAdapter: { execute: async params => { await params.onAccepted!(); return { text: 'Done' }; } } });
  await coordinator.submitTurn(command());
  await until(() => conv(repo.snapshot).turns[0]?.state === 'completed', 'completion');
  const claims = (coordinator as unknown as { abortControllers: Map<string, AbortController> }).abortControllers;
  const stranger = new AbortController();
  claims.set('conv:other-turn:other-attempt', stranger);
  await coordinator.cancelTurn('conv', conv(repo.snapshot).turns[0].id);
  assert.equal(stranger.signal.aborted, false, 'a different turn/attempt claim is untouched');
  assert.equal(claims.size, 1);
});
