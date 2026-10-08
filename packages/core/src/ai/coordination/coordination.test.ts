import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCoordination,
  claimsConflict,
  COORDINATION_LEASE_MS,
  COORDINATION_RESERVATION_MS,
  emptyCoordinationState,
  resourcesOverlap,
  scopedSnapshot,
  assessChangeScope,
  type CoordinationCommand,
  type CoordinationOwner,
  type CoordinationResource,
  type CoordinationState
} from './index';

const WT = '/repo/wt-a';
const file = (path: string, worktree = WT): CoordinationResource => ({ kind: 'file', worktree, path });
const dir = (path: string, worktree = WT): CoordinationResource => ({ kind: 'directory', worktree, path });

function run(state: CoordinationState, command: CoordinationCommand, now = 1000) {
  return applyCoordination(state, command, now);
}

function registered(keys: string[], scope?: Record<string, string>): CoordinationState {
  let state = emptyCoordinationState('epoch-1');
  for (const sessionKey of keys) {
    state = run(state, { kind: 'register', session: { sessionKey, runtime: 'gateway', coverage: 'enforced', ...(scope?.[sessionKey] ? { scope: scope[sessionKey] } : {}) } }).state;
  }
  return state;
}

function acquire(state: CoordinationState, owner: CoordinationOwner | string, requestId: string, items: Array<{ resource: CoordinationResource; mode?: 'exclusive' | 'shared' }>, wait: false | { untilMs?: number } = {}, now = 1000) {
  const who = typeof owner === 'string' ? { sessionKey: owner } : owner;
  return run(state, { kind: 'acquire', requestId, owner: who, items: items.map(item => ({ resource: item.resource, mode: item.mode ?? 'exclusive' })), reason: `work ${requestId}`, lifetime: 'tool', wait }, now);
}

// ── Policy (TASK-391 / TASK-263 overlap detection) ─────────────────────────

test('files, folders and worktrees overlap the way an edit would collide', () => {
  assert.equal(resourcesOverlap(file('src/a.ts'), file('src/a.ts')), true);
  assert.equal(resourcesOverlap(file('src/a.ts'), file('./src/a.ts')), true, 'canonical paths compare equal');
  assert.equal(resourcesOverlap(file('src/a.ts'), file('src/b.ts')), false);
  assert.equal(resourcesOverlap(dir('src'), file('src/deep/a.ts')), true, 'a folder covers its descendants');
  assert.equal(resourcesOverlap(dir('src/a'), dir('src')), true);
  assert.equal(resourcesOverlap(dir('src'), file('srcs/a.ts')), false, 'a prefix that is not a folder boundary does not count');
  assert.equal(resourcesOverlap(file('src/a.ts'), file('src/a.ts', '/repo/wt-b')), false, 'different worktrees are separate checkouts');
  assert.equal(resourcesOverlap({ kind: 'worktree', worktree: WT }, file('x.ts')), true);
  assert.equal(resourcesOverlap({ kind: 'checkout', worktree: WT }, { kind: 'git-index', worktree: WT }), true);
  assert.equal(resourcesOverlap({ kind: 'git-index', worktree: WT }, file('x.ts')), false, 'staging does not block edits');
  assert.equal(resourcesOverlap(file('Src/A.ts'), file('src/a.ts'), true), true, 'case-insensitive file systems');
  assert.equal(resourcesOverlap({ kind: 'desktop' }, { kind: 'desktop' }), true);
  assert.equal(resourcesOverlap({ kind: 'app-ui', instance: 'a' }, { kind: 'app-ui', instance: 'b' }), false, 'isolated app instances do not serialise');
  assert.equal(resourcesOverlap({ kind: 'build-output', dir: 'out' }, { kind: 'build-output', dir: 'out/renderer' }), true);
  assert.equal(claimsConflict({ resource: { kind: 'worktree', worktree: WT }, mode: 'shared' }, { resource: { kind: 'worktree', worktree: WT }, mode: 'shared' }), false, 'two stable reads share');
  assert.equal(claimsConflict({ resource: { kind: 'worktree', worktree: WT }, mode: 'shared' }, { resource: file('a.ts'), mode: 'exclusive' }), true, 'a stable read blocks edits');
});

// ── Acquisition ───────────────────────────────────────────────────────────

test('two sessions cannot hold overlapping write claims; independent ones proceed at once', () => {
  let state = registered(['A', 'B', 'C']);
  const a = acquire(state, 'A', 'a1', [{ resource: dir('src') }]);
  assert.equal(a.result.ok && a.result.acquire?.status, 'granted');
  state = a.state;
  const b = acquire(state, 'B', 'b1', [{ resource: file('src/x.ts') }], false);
  assert.equal(b.result.ok && b.result.acquire?.status, 'blocked');
  assert.match(b.result.ok && b.result.acquire?.status === 'blocked' ? b.result.acquire.reason : '', /folder src\/ is held by A \(work a1\)/);
  const c = acquire(b.state, 'C', 'c1', [{ resource: file('docs/readme.md') }]);
  assert.equal(c.result.ok && c.result.acquire?.status, 'granted', 'an unrelated file is not held up');
});

test('a multi-resource request is all or none', () => {
  let state = registered(['A', 'B']);
  state = acquire(state, 'A', 'a1', [{ resource: { kind: 'browser', surface: 'main' } }]).state;
  const b = acquire(state, 'B', 'b1', [{ resource: file('x.ts') }, { resource: { kind: 'browser', surface: 'main' } }], false);
  assert.equal(b.result.ok && b.result.acquire?.status, 'blocked');
  assert.equal(b.state.claims.filter(claim => claim.owner.sessionKey === 'B').length, 0, 'it did not take x.ts on its own');
});

test('a repeated request id is idempotent', () => {
  const state = registered(['A']);
  const first = acquire(state, 'A', 'a1', [{ resource: file('x.ts') }]);
  const again = acquire(first.state, 'A', 'a1', [{ resource: file('x.ts') }]);
  assert.equal(again.state, first.state);
  assert.deepEqual(again.result.ok && again.result.acquire, first.result.ok && first.result.acquire);
});

test('waiters are served first come, first served, with a reservation they must start before it lapses', () => {
  let state = registered(['A', 'B', 'C']);
  state = acquire(state, 'A', 'a1', [{ resource: file('x.ts') }]).state;
  const b = acquire(state, 'B', 'b1', [{ resource: file('x.ts') }]);
  assert.deepEqual(b.result.ok && b.result.acquire && { status: b.result.acquire.status }, { status: 'queued' });
  state = b.state;
  // C's request conflicts with B's earlier wait, so C queues behind it even after A releases.
  state = acquire(state, 'C', 'c1', [{ resource: dir('') }]).state;
  state = run(state, { kind: 'release', owner: { sessionKey: 'A' }, requestId: 'a1' }, 2000).state;
  const bClaim = state.claims.find(claim => claim.owner.sessionKey === 'B');
  assert.equal(bClaim?.state, 'reserved', 'B is offered x.ts first');
  assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'C'), false);
  assert.ok(state.events.some(event => event.type === 'resource-available' && event.toSessionKey === 'B'));

  // B does not start in time: the reservation lapses and C gets its turn.
  state = run(state, { kind: 'tick' }, 2000 + COORDINATION_RESERVATION_MS + 1).state;
  assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'B'), false);
  assert.equal(state.claims.find(claim => claim.owner.sessionKey === 'C')?.state, 'reserved');
});

test('starting a reservation needs its owner and its generation', () => {
  let state = registered(['A', 'B']);
  state = acquire(state, 'A', 'a1', [{ resource: file('x.ts') }]).state;
  state = acquire(state, 'B', 'b1', [{ resource: file('x.ts') }]).state;
  state = run(state, { kind: 'release', owner: { sessionKey: 'A' }, requestId: 'a1' }).state;
  const claim = state.claims.find(candidate => candidate.owner.sessionKey === 'B')!;
  assert.equal(run(state, { kind: 'start', owner: { sessionKey: 'A' }, claimIds: [claim.claimId] }).result.ok, false, 'not A\'s');
  assert.equal(run(state, { kind: 'start', owner: { sessionKey: 'B' }, claimIds: [claim.claimId], generation: claim.generation + 7 }).result.ok, false, 'a stale capability');
  const started = run(state, { kind: 'start', owner: { sessionKey: 'B' }, claimIds: [claim.claimId], generation: claim.generation });
  assert.equal(started.state.claims.find(candidate => candidate.claimId === claim.claimId)?.state, 'executing');
});

test('an owner that goes silent while executing blocks its resource for recovery — never reassigned', () => {
  let state = registered(['A', 'B']);
  state = acquire(state, 'A', 'a1', [{ resource: { kind: 'app-ui', instance: 'live' } }]).state;
  state = acquire(state, 'B', 'b1', [{ resource: { kind: 'app-ui', instance: 'live' } }]).state;
  state = run(state, { kind: 'tick' }, 1000 + COORDINATION_LEASE_MS + 1).state;
  assert.equal(state.claims.find(claim => claim.owner.sessionKey === 'A')?.state, 'recovery-required');
  assert.equal(state.claims.some(claim => claim.owner.sessionKey === 'B'), false, 'B waits; the app may still be in A\'s hands');
  assert.equal(run(state, { kind: 'recover', claimId: 'a1#0', actor: '', note: '' }).result.ok, false, 'recovery is attributed');
  state = run(state, { kind: 'recover', claimId: 'a1#0', actor: 'host', note: 'the agent process exited' }, 200_000).state;
  assert.equal(state.claims.find(claim => claim.owner.sessionKey === 'B')?.state, 'reserved');
});

test('heartbeats keep an executing claim alive', () => {
  let state = registered(['A']);
  state = acquire(state, 'A', 'a1', [{ resource: file('x.ts') }]).state;
  state = run(state, { kind: 'heartbeat', sessionKey: 'A' }, 60_000).state;
  state = run(state, { kind: 'tick' }, 60_000 + COORDINATION_LEASE_MS - 1).state;
  assert.equal(state.claims[0].state, 'executing');
});

test('a wait that would deadlock is refused with an explanation', () => {
  let state = registered(['parent', 'child']);
  state = acquire(state, 'parent', 'p1', [{ resource: file('a.ts') }]).state;
  state = acquire(state, 'child', 'c1', [{ resource: file('b.ts') }]).state;
  state = acquire(state, 'child', 'c2', [{ resource: file('a.ts') }]).state; // child waits on parent
  const cycle = acquire(state, 'parent', 'p2', [{ resource: file('b.ts') }]);
  assert.equal(cycle.result.ok && cycle.result.acquire?.status, 'blocked');
  assert.match(cycle.result.ok && cycle.result.acquire?.status === 'blocked' ? cycle.result.acquire.reason : '', /would deadlock/);
});

test('sibling executions of one session still conflict, and queue rather than deadlock', () => {
  let state = registered(['S']);
  state = acquire(state, { sessionKey: 'S', executionId: 'one' }, 'x1', [{ resource: file('a.ts') }]).state;
  const sibling = acquire(state, { sessionKey: 'S', executionId: 'two' }, 'x2', [{ resource: file('a.ts') }]);
  assert.equal(sibling.result.ok && sibling.result.acquire?.status, 'queued');
  const reuse = acquire(state, { sessionKey: 'S', executionId: 'one' }, 'x3', [{ resource: file('a.ts') }]);
  assert.equal(reuse.result.ok && reuse.result.acquire?.status, 'granted', 'the same execution owner reuses its claim sequentially');
});

test('ending a turn releases its claims but keeps a service claim; ending a session sends executing claims to recovery', () => {
  let state = registered(['A', 'B']);
  state = run(state, { kind: 'acquire', requestId: 'svc', owner: { sessionKey: 'A', turnId: 't1' }, items: [{ resource: { kind: 'port', port: 5173 }, mode: 'exclusive' }], reason: 'dev server', lifetime: 'service', wait: false }).state;
  state = run(state, { kind: 'acquire', requestId: 'edit', owner: { sessionKey: 'A', turnId: 't1' }, items: [{ resource: file('x.ts'), mode: 'exclusive' }], reason: 'edit', lifetime: 'tool', wait: false }).state;
  state = run(state, { kind: 'end-turn', owner: { sessionKey: 'A', turnId: 't1' }, summary: 'done editing' }).state;
  assert.deepEqual(state.claims.map(claim => claim.requestId), ['svc']);
  assert.equal(state.sessions.A.state, 'idle');

  state = acquire(state, 'B', 'b1', [{ resource: { kind: 'browser', surface: 'main' } }]).state;
  state = run(state, { kind: 'end-session', sessionKey: 'B' }).state;
  assert.equal(state.claims.find(claim => claim.owner.sessionKey === 'B')?.state, 'recovery-required');
});

test('delegation hands a claim to one child; the parent no longer holds it', () => {
  let state = registered(['parent', 'child']);
  state = acquire(state, 'parent', 'p1', [{ resource: { kind: 'browser', surface: 'main' } }]).state;
  state = run(state, { kind: 'delegate', owner: { sessionKey: 'parent' }, claimId: 'p1#0', to: { sessionKey: 'child' } }).state;
  assert.equal(state.claims[0].owner.sessionKey, 'child');
  assert.equal(acquire(state, 'parent', 'p2', [{ resource: { kind: 'browser', surface: 'main' } }], false).result.ok && 'blocked', 'blocked');
});

test('another project sees only that a resource is busy', () => {
  let state = registered(['A', 'B'], { A: 'project-a', B: 'project-b' });
  state = acquire(state, 'A', 'a1', [{ resource: { kind: 'desktop' } }]).state;
  const b = acquire(state, 'B', 'b1', [{ resource: { kind: 'desktop' } }], false);
  const blockers = b.result.ok && b.result.acquire?.status === 'blocked' ? b.result.acquire.blockers : [];
  assert.deepEqual(blockers.map(blocker => [blocker.ownerSessionKey, blocker.reason, blocker.redacted]), [['another project', 'in use', true]]);
  const view = scopedSnapshot(state, 'B');
  assert.equal(view.sessions.some(session => session.sessionKey === 'A'), false);
  assert.equal(view.claims[0].owner.sessionKey, 'another project');
});

test('messages are bounded, redacted and acknowledged', () => {
  let state = registered(['A', 'B']);
  assert.equal(run(state, { kind: 'message', from: 'A', text: 'x'.repeat(5000) }).result.ok, false);
  const sent = run(state, { kind: 'message', from: 'A', to: 'B', text: 'Done with the app. token: abc123', needsAck: true });
  state = sent.state;
  const message = state.events.at(-1)!;
  assert.match(message.text, /\[redacted\]/);
  state = run(state, { kind: 'ack', sessionKey: 'B', sequence: message.sequence }).state;
  assert.deepEqual(state.events.find(event => event.sequence === message.sequence)?.ackedBy, ['B']);
});

test('property: across random interleavings no two conflicting claims are ever held at once', () => {
  const resources: CoordinationResource[] = [file('a.ts'), file('b.ts'), dir('src'), file('src/c.ts'), { kind: 'worktree', worktree: WT }, { kind: 'browser', surface: 'main' }, { kind: 'desktop' }];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sessions = ['A', 'B', 'C', 'D'];
  let state = registered(sessions);
  let now = 1000;
  for (let step = 0; step < 3000; step += 1) {
    now += Math.floor(random() * 5000);
    const who = sessions[Math.floor(random() * sessions.length)];
    const roll = random();
    if (roll < 0.45) {
      const count = 1 + Math.floor(random() * 2);
      const items = Array.from({ length: count }, () => ({ resource: resources[Math.floor(random() * resources.length)], mode: random() < 0.3 ? 'shared' as const : 'exclusive' as const }));
      state = run(state, { kind: 'acquire', requestId: `r${step}`, owner: { sessionKey: who }, items, reason: 'r', lifetime: 'tool', wait: random() < 0.5 ? false : {} }, now).state;
    } else if (roll < 0.7) {
      const mine = state.claims.filter(claim => claim.owner.sessionKey === who && claim.state !== 'recovery-required');
      if (mine.length) state = run(state, { kind: 'release', owner: { sessionKey: who }, claimIds: [mine[0].claimId] }, now).state;
    } else if (roll < 0.8) {
      const reserved = state.claims.filter(claim => claim.owner.sessionKey === who && claim.state === 'reserved');
      if (reserved.length) state = run(state, { kind: 'start', owner: { sessionKey: who }, claimIds: reserved.map(claim => claim.claimId) }, now).state;
    } else if (roll < 0.9) {
      state = run(state, { kind: 'heartbeat', sessionKey: who }, now).state;
    } else if (roll < 0.95) {
      state = run(state, { kind: 'tick' }, now).state;
      for (const claim of state.claims.filter(candidate => candidate.state === 'recovery-required')) {
        state = run(state, { kind: 'recover', claimId: claim.claimId, actor: 'test', note: 'stopped' }, now).state;
      }
    } else {
      state = run(state, { kind: 'end-turn', owner: { sessionKey: who } }, now).state;
    }
    for (let i = 0; i < state.claims.length; i += 1) {
      for (let j = i + 1; j < state.claims.length; j += 1) {
        const left = state.claims[i];
        const right = state.claims[j];
        if (left.owner.sessionKey === right.owner.sessionKey) continue;
        assert.equal(claimsConflict(left, right), false, `step ${step}: ${left.claimId} and ${right.claimId} conflict`);
      }
    }
  }
});

// ── Out-of-scope changes (FX-BE-094 / TASK-265) ───────────────────────────

test('changes outside what a session claimed are blocked or escalated by policy', () => {
  const declared = [file('src/pay.ts'), dir('src/pay')];
  const block = assessChangeScope(['src/pay.ts', 'src/pay/card.ts', 'src/auth.ts', 'package.json'], declared, WT, 'block');
  assert.deepEqual([block.action, block.outOfScope], ['block', ['src/auth.ts', 'package.json']]);
  assert.match(block.message ?? '', /Held back: 2 changed paths outside what this session claimed/);
  assert.equal(assessChangeScope(['src/auth.ts'], declared, WT, 'escalate').action, 'escalate');
  assert.equal(assessChangeScope(['src/pay.ts'], declared, WT, 'block').action, 'none');
  assert.equal(assessChangeScope(['anything.ts'], [{ kind: 'worktree', worktree: WT }], WT, 'block').action, 'none', 'a coarse claim has no narrower scope');
  assert.equal(assessChangeScope(['anything.ts'], [], WT, 'block').scoped, false);
});
