#!/usr/bin/env node
// Generates `run-parity.json.gz`: seeded random operation sequences driven through the
// TypeScript workflow engine (`packages/core/out/workflows`), with the schedule and
// status after every step and the final run. `tests/run_parity.rs` replays the same
// operations through the Rust engine and asserts it reaches identical results.
//
// Regenerate after changing either engine (build `@praxis/core` first):
//   npm run build:core && node crates/praxis-workflows/tests/parity/generate-run-parity.mjs

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = join(here, '../../../../packages/core/out/workflows');
const run = require(join(out, 'workflowRun.js'));
const scheduler = require(join(out, 'workflowScheduler.js'));
const edges = require(join(out, 'workflowEdges.js'));
const gates = require(join(out, 'workflowGates.js'));
const recovery = require(join(out, 'workflowRecovery.js'));

/** A composed policy: adds a gate, sets thresholds, allows bypass, and waives one finding. */
const POLICY = {
  schemaVersion: 1, id: 'policy', name: 'Policy', scope: 'global', requiredGates: ['review', 'qa'], requireHumanApproval: true,
  allowGateBypass: true, requireTrustedAgents: false, maxAttemptsPerNode: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  gateThresholds: {
    security: [{ type: 'severity', severityLevel: 'critical', maxCount: 0 }],
    review: [{ type: 'metric', metric: 'score', operator: '>=', value: 50 }, { type: 'severity', maxCount: 1 }]
  },
  waivers: [{ fingerprint: 'fp-security-1', reason: 'accepted risk', actor: 'sec', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]
};
const TIMEOUT_NOW = '2026-09-02T09:10:00.000Z';

const SCENARIOS_PER_DEFINITION = 16;
const STEPS = 36;

// ── Deterministic randomness ─────────────────────────────────────────────
function rng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    int: n => Math.floor(next() * n),
    pick: items => items[Math.floor(next() * items.length)],
    chance: p => next() < p
  };
}

const T = step => new Date(Date.UTC(2026, 8, 2, 9, 0, step)).toISOString();
const agent = toolMode => ({ agentId: 'a', scope: 'global', toolMode });
const base = (id, name) => ({ id, name, x: 0, y: 0, inputs: [] });

// ── Definitions ──────────────────────────────────────────────────────────
const definitions = [
  {
    // plan → implement → (review ∥ qa ∥ security, advisory docs) → join → approval
    schemaVersion: 1, id: 'delivery', name: 'Delivery', scope: 'global', version: 1, entryNodeId: 'plan',
    createdAt: T(0), updatedAt: T(0),
    nodes: [
      { ...base('plan', 'Plan'), type: 'agent-task', agent: agent('read-only'), instructions: 'p', outputs: [{ id: 'plan-doc', kind: 'plan', required: true }], mutatesWorktree: false },
      { ...base('implement', 'Implement'), type: 'agent-task', agent: agent('full'), instructions: 'i', outputs: [{ id: 'diff', kind: 'diff', required: true }], mutatesWorktree: true, maxAttempts: 2 },
      { ...base('review', 'Review'), type: 'agent-task', agent: agent('read-only'), instructions: 'r', outputs: [{ id: 'review-report', kind: 'report', required: true }], mutatesWorktree: false, satisfiesGate: 'review' },
      { ...base('qa', 'QA'), type: 'check', command: 'npm', outputs: [{ id: 'qa-results', kind: 'test-results', required: true }], satisfiesGate: 'qa', maxAttempts: 2, timeoutMs: 5000 },
      { ...base('deps', 'Deps'), type: 'check', command: 'osv', outputs: [], satisfiesGate: 'security' },
      { ...base('security', 'Security'), type: 'check', command: 'npm', outputs: [{ id: 'sec', kind: 'findings', required: true }], satisfiesGate: 'security' },
      { ...base('docs', 'Docs'), type: 'agent-task', agent: agent('full'), instructions: 'd', outputs: [], mutatesWorktree: true },
      { ...base('gates', 'Gates'), type: 'join', mode: 'all-required' },
      { ...base('approve', 'Approve'), type: 'approval', prompt: 'Ship?', requiredGates: ['review', 'qa', 'security'], allowBypass: true }
    ],
    edges: [
      { id: 'e1', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e2', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e3', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e4', from: 'implement', to: 'security', on: 'success', required: true },
      { id: 'e4b', from: 'implement', to: 'docs', on: 'success', required: false },
      { id: 'e4c', from: 'implement', to: 'deps', on: 'success', required: true },
      { id: 'e7c', from: 'deps', to: 'gates', on: 'success', required: true },
      { id: 'e5', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e6', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e7', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e7b', from: 'docs', to: 'gates', on: 'success', required: false },
      { id: 'e8', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  },
  {
    // implement → review(findings) ⟲ implement (findings loop, keep-best), → approve
    schemaVersion: 1, id: 'improve', name: 'Improve', scope: 'global', version: 1, entryNodeId: 'implement',
    createdAt: T(0), updatedAt: T(0),
    parameters: [{ id: 'rounds', label: 'Rounds', kind: 'integer', bindsLoopEdge: 'loop' }],
    nodes: [
      { ...base('implement', 'Implement'), type: 'agent-task', agent: agent('full'), instructions: 'i', outputs: [], mutatesWorktree: true, maxAttempts: 2 },
      { ...base('review', 'Review'), type: 'agent-task', agent: agent('read-only'), instructions: 'r', outputs: [{ id: 'findings', kind: 'findings', required: true }], mutatesWorktree: false, satisfiesGate: 'review' },
      { ...base('skeptic', 'Skeptic'), type: 'agent-task', agent: agent('read-only'), instructions: 's', outputs: [], mutatesWorktree: false, refutes: 'review' },
      { ...base('approve', 'Approve'), type: 'approval', prompt: 'Ok?', requiredGates: ['review'], allowBypass: false, optional: true,
        waivers: [{ fingerprint: 'fp-waived', reason: 'known', actor: 'lead', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }] }
    ],
    edges: [
      { id: 'e1', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e2', from: 'review', to: 'skeptic', on: 'success', required: true },
      { id: 'loop', from: 'review', to: 'implement', on: 'findings', required: true,
        when: { severity: 'high', metric: { metric: 'score', operator: '<', value: 90, valueFromParameter: 'target' } },
        loop: { maxIterations: 3, keepBest: { metric: 'score', higherIsBetter: true, patience: 2 } } },
      { id: 'e3', from: 'skeptic', to: 'approve', on: 'success', required: true }
    ]
  },
  {
    // build → test (check with repair) –failure→ repair; test → merge; failure loop on merge
    schemaVersion: 1, id: 'repair', name: 'Repair', scope: 'project', projectId: 'p', version: 1, entryNodeId: 'build',
    createdAt: T(0), updatedAt: T(0),
    nodes: [
      { ...base('build', 'Build'), type: 'check', command: 'make', outputs: [], mutatesWorktree: true },
      { ...base('test', 'Test'), type: 'check', command: 'npm', outputs: [], satisfiesGate: 'qa', maxAttempts: 3,
        failureRecovery: { repairNodeId: 'fix', maxAttempts: 1 } },
      { ...base('fix', 'Fix'), type: 'agent-task', agent: agent('full'), instructions: 'f', outputs: [], mutatesWorktree: true, providerId: undefined },
      { ...base('merge', 'Merge'), type: 'merge', maxAttempts: 2 },
      { ...base('notify', 'Notify'), type: 'agent-task', agent: { ...agent('read-only'), providerId: 'openai' }, instructions: 'n', outputs: [], mutatesWorktree: false }
    ],
    edges: [
      { id: 'e1', from: 'build', to: 'test', on: 'success', required: true },
      { id: 'e2', from: 'test', to: 'fix', on: 'failure', required: true },
      { id: 'e3', from: 'test', to: 'merge', on: 'success', required: true },
      { id: 'e4', from: 'merge', to: 'notify', on: 'always', required: false },
      { id: 'mloop', from: 'merge', to: 'build', on: 'failure', required: true, loop: { maxIterations: 1 } }
    ]
  }
];

// ── Operation generation ─────────────────────────────────────────────────
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const PROVIDERS = ['anthropic', 'openai', 'codex-cli', 'claude-code-cli'];

function findingsFor(r, nodeId) {
  const count = r.int(4);
  const findings = [];
  for (let i = 0; i < count; i += 1) {
    findings.push({
      fingerprint: r.chance(0.2) ? 'fp-waived' : `fp-${nodeId}-${r.int(5)}`,
      severity: r.pick(SEVERITIES),
      category: r.pick(['security', 'style', 'bug']),
      message: `m${i}`,
      ...(r.chance(0.3) ? { verdict: r.pick(['confirmed', 'refuted']), verdictReason: 'checked' } : {})
    });
  }
  return { findings, metrics: r.chance(0.8) ? { score: r.int(100) } : {} };
}

function chooseOperation(r, current, definition, step) {
  const at = T(step);
  const schedule = scheduler.scheduleWorkflowRun(current);
  const ids = definition.nodes.map(node => node.id);
  const nodeOf = id => definition.nodes.find(node => node.id === id);
  const loop = edges.pendingLoop(current);
  const roll = r.next();

  if (loop && roll < 0.7) {
    if (loop.kind === 'take') return { op: 'command', command: { kind: 'loop-taken', edgeId: loop.status.edge.id, at } };
    const decision = r.pick(['accept', 'grant', 'stop', 'grant']);
    return { op: 'command', command: { kind: 'loop-decided', edgeId: loop.status.edge.id, at, actor: r.chance(0.9) ? 'dana' : ' ',
      decision, ...(r.chance(0.85) ? { reason: 'because' } : {}), ...(decision === 'grant' ? { extraIterations: r.int(4) } : {}) } };
  }
  if (schedule.awaitingApproval.length > 0 && schedule.ready.length === 0 && schedule.running.length === 0 && roll < 0.6) {
    // Answering an approval: the orchestrator starts and settles the approval node.
    return { op: 'command', command: { kind: 'node-started', nodeId: r.pick(schedule.awaitingApproval), at } };
  }
  if (schedule.ready.length > 0 && roll < 0.55) {
    return { op: 'command', command: { kind: 'node-started', nodeId: r.pick(schedule.ready), at, ...(r.chance(0.5) ? { sessionId: `s${step}` } : {}) } };
  }
  if (schedule.running.length > 0 && roll < 0.9) {
    const nodeId = r.pick(schedule.running);
    const node = nodeOf(nodeId);
    const outputs = node.outputs ?? [];
    const kind = r.next();
    if (kind < 0.65) {
      return { op: 'command', command: {
        kind: 'node-succeeded', nodeId, at,
        artifacts: outputs.filter(() => r.chance(0.95)).map(o => ({ contractId: o.id, kind: o.kind, ...(r.chance(0.3) ? { path: `${o.id}.md` } : {}) }))
          .concat(r.chance(0.1) ? [{ contractId: 'invented', kind: 'note' }] : []),
        ...(r.chance(0.4) ? { snapshotRef: `sha${step}abcdef` } : {}),
        ...(outputs.some(o => o.kind === 'findings') || r.chance(0.3) ? { findings: findingsFor(r, nodeId) } : {}),
        ...(r.chance(0.4) ? { provider: r.pick(PROVIDERS), model: r.chance(0.5) ? 'm1' : undefined } : {}),
        ...(r.chance(0.2) ? { exitCode: 0 } : {}),
        ...(r.chance(0.15) ? { independence: { independent: r.chance(0.5), reason: 'same model' } } : {})
      } };
    }
    if (kind < 0.85) {
      return { op: 'command', command: {
        kind: 'node-failed', nodeId, at, error: r.chance(0.3) ? 'line one\nline two' : 'boom',
        ...(r.chance(0.25) ? { pause: r.pick(['provider-limit', 'environment']) } : {}),
        ...(r.chance(0.4) ? { provider: r.pick(PROVIDERS) } : {}),
        ...(r.chance(0.3) ? { findings: findingsFor(r, nodeId) } : {}),
        ...(node.type === 'merge' && r.chance(0.6) ? { conflictFiles: ['a.ts', 'b.ts'] } : {}),
        ...(r.chance(0.3) ? { exitCode: 1 } : {})
      } };
    }
    if (kind < 0.9) return { op: 'command', command: { kind: 'node-timed-out', nodeId, at } };
    if (kind < 0.95) return { op: 'command', command: { kind: 'node-progress', nodeId, at, phase: r.pick(['deploying', 'verifying']), ...(r.chance(0.3) ? { message: 'phase msg' } : {}) } };
    return { op: 'command', command: { kind: 'node-interrupted', nodeId, at } };
  }

  const approvals = definition.nodes.filter(node => node.type === 'approval').map(node => node.id);
  if (approvals.length > 0 && r.chance(0.25)) {
    const nodeId = r.pick(approvals);
    const which = r.next();
    if (which < 0.4) return { op: 'approve', nodeId, at, actor: 'dana', policy: r.chance(0.5) };
    if (which < 0.65) return { op: 'bypass', nodeId, at, gate: r.pick(['review', 'qa', 'security']), actor: 'dana', reason: 'urgent', policy: r.chance(0.7) };
    if (which < 0.85) return { op: 'reject', nodeId, at, actor: 'dana', reason: 'not yet' };
    return { op: 'skipApproval', nodeId, at, actor: 'dana' };
  }
  if (r.chance(0.04)) return { op: 'recover', at };
  const extra = r.next();
  if (extra < 0.4) return { op: 'advanceJoins', at };
  const failed = ids.filter(id => current.nodes[id]?.outcome === 'failed');
  if (extra < 0.5) return { op: 'command', command: { kind: 'node-retry', nodeId: failed.length && r.chance(0.85) ? r.pick(failed) : r.pick(ids), at } };
  if (extra < 0.55) return { op: 'command', command: { kind: 'stage-provider-switched', nodeId: r.pick(ids), at, provider: r.pick(PROVIDERS), ...(r.chance(0.5) ? { model: ' m2 ' } : {}), ...(r.chance(0.5) ? { automatic: true } : {}) } };
  if (extra < 0.62) {
    const gate = r.pick(['review', 'qa', 'security']);
    const bypassed = r.chance(0.3);
    return { op: 'command', command: { kind: 'gate-decided', at, decision: { gate, nodeId: r.pick(ids), passed: r.chance(0.6), bypassed,
      ...(bypassed ? { bypassedBy: 'dana', reason: 'urgent' } : {}), ...(r.chance(0.4) ? { assessedSnapshotRef: 'snap1' } : {}), decidedAt: at } } };
  }
  if (extra < 0.7) return { op: 'rework', nodeId: r.pick(ids), at, options: {
    ...(r.chance(0.3) ? { byPerson: true } : {}), ...(r.chance(0.2) ? { rerunSource: false } : {}), ...(r.chance(0.2) ? { freshAttempts: true } : {}),
    ...(r.chance(0.3) ? { carryFindings: [{ stage: 'Review', finding: { fingerprint: 'f', severity: 'high', category: 'bug', message: 'x' } }] } : {}) } };
  if (extra < 0.75) return { op: 'allowAiMergeResolution', nodeId: r.pick(ids), at };
  if (extra < 0.8) return { op: 'command', command: { kind: 'provider-limit-stop', nodeId: r.pick(ids), at, ...(r.chance(0.5) ? { detail: 'quota' } : {}) } };
  if (extra < 0.84) return { op: 'command', command: { kind: 'node-stopped', nodeId: r.pick(ids), at, ...(r.chance(0.5) ? { reason: 'run ended' } : {}) } };
  if (extra < 0.88) return { op: 'command', command: { kind: 'node-skipped', nodeId: r.pick(ids), at, reason: 'not needed' } };
  if (extra < 0.92) return { op: 'command', command: { kind: 'loop-restored', at, ok: r.chance(0.5), ...(r.chance(0.5) ? { detail: 'dirty tree' } : {}) } };
  if (extra < 0.94) return { op: 'command', command: { kind: 'cancel', at, ...(r.chance(0.5) ? { reason: 'changed my mind' } : {}) } };
  return { op: 'normalize' };
}

function applyOperation(current, operation) {
  switch (operation.op) {
    case 'command': return run.applyWorkflowRunCommand(current, operation.command);
    case 'advanceJoins': return scheduler.advanceJoins(current, operation.at);
    case 'rework': return run.reworkWorkflowRun(current, operation.nodeId, operation.at, operation.options).run;
    case 'allowAiMergeResolution': return run.allowAiMergeResolution(current, operation.nodeId, operation.at);
    case 'normalize': return run.normalizeWorkflowRun(JSON.parse(JSON.stringify(current)));
    case 'approve': return gates.approveStage(current, operation.nodeId, { actor: operation.actor, at: operation.at }, operation.policy ? POLICY : undefined).run;
    case 'bypass': return gates.bypassGate(current, operation.nodeId, { gate: operation.gate, actor: operation.actor, reason: operation.reason, at: operation.at }, operation.policy ? POLICY : undefined).run;
    case 'reject': return gates.rejectStage(current, operation.nodeId, { actor: operation.actor, reason: operation.reason, at: operation.at });
    case 'skipApproval': return gates.skipApproval(current, operation.nodeId, { actor: operation.actor, at: operation.at }).run;
    case 'recover': return recovery.recoverWorkflowRun(current, operation.at).run;
    default: throw new Error(`unknown op ${operation.op}`);
  }
}

function observe(current) {
  const loop = edges.pendingLoop(current);
  const { ready, autoAdvance, skip, awaitingApproval, running, blocked } = scheduler.scheduleWorkflowRun(current);
  return {
    schedule: { ready, autoAdvance, skip, awaitingApproval, running, ...(blocked ? { blocked } : {}) },
    status: scheduler.deriveRunStatus(current),
    events: current.events.length,
    pendingLoop: loop ? { kind: loop.kind, edgeId: loop.status.edge.id, budget: loop.status.budget, taken: loop.status.iterationsTaken } : null,
    canRetry: Object.keys(current.nodes).filter(id => run.canRetry(current, id)),
    stageProvider: Object.keys(current.nodes).map(id => run.stageProvider(current, id, 'fallback-ai')),
    gates: current.definition.nodes.filter(node => node.type === 'approval').map(node => ({
      approval: node.id,
      plain: gates.evaluateGates(current, node.id),
      withPolicy: gates.approvalReadiness(current, node.id, POLICY)
    })),
    nextActions: recovery.nextActions(current),
    timedOut: recovery.findTimedOutNodes(current, TIMEOUT_NOW),
    failingFindings: gates.failingGateFindings(current, POLICY),
    repairStage: gates.repairStageForFindings(current, gates.failingGateFindings(current, POLICY)) ?? null
  };
}

const scenarios = [];
definitions.forEach((definition, defIndex) => {
  for (let i = 0; i < SCENARIOS_PER_DEFINITION; i += 1) {
    const seed = 1000 * (defIndex + 1) + i;
    const r = rng(seed);
    const parameters = definition.parameters && r.chance(0.6) ? { rounds: r.pick([1, 2, 5, 2.5]), target: r.pick([50, 80]) } : undefined;
    const create = {
      runId: `run-${seed}`, projectId: 'p', at: T(0),
      ...(r.chance(0.3) ? { permissionMode: 'auto' } : {}),
      ...(r.chance(0.3) ? { aiProvider: 'anthropic', aiModel: 'm0' } : {}),
      ...(r.chance(0.2) ? { providerLimitPolicy: r.pick(['ask', 'switch', 'stop']) } : {}),
      ...(r.chance(0.2) ? { issueKey: 'TASK-1' } : {}),
      ...(parameters ? { parameters } : {})
    };
    let current = run.createWorkflowRun({ ...create, definition });
    const steps = [];
    let previous = '';
    for (let step = 1; step <= STEPS; step += 1) {
      const operation = chooseOperation(r, current, definition, step);
      current = applyOperation(current, operation) ?? current;
      // Only observations that changed are stored; the Rust replay checks exactly those.
      const observation = observe(current);
      const serialized = JSON.stringify(observation);
      steps.push(serialized === previous ? { operation } : { operation, observation });
      previous = serialized;
    }
    const { definition: _definition, ...final } = JSON.parse(JSON.stringify(current));
    scenarios.push({ seed, definition: definition.id, create, steps, final });
  }
});

// ── Scripted scenarios: paths random sequences rarely reach ───────────────
const cmd = command => ({ op: 'command', command });
const finish = (nodeId, at, extra = {}) => [cmd({ kind: 'node-started', nodeId, at }), cmd({ kind: 'node-succeeded', nodeId, at, ...extra })];
const reviewFindings = (score, severity = 'high') => ({
  artifacts: [{ contractId: 'findings', kind: 'findings' }],
  findings: { findings: [{ fingerprint: 'fp-1', severity, category: 'bug', message: 'off by one' }, { fingerprint: 'fp-waived', severity: 'critical', category: 'bug', message: 'waived' }], metrics: { score } }
});
const skepticVerdict = verdict => ({ findings: { findings: [{ fingerprint: 'fp-1', severity: 'medium', category: 'bug', message: 'off by one', verdict, verdictReason: 'checked it' }], metrics: {} } });
function improveRound(at, score, sha, verdict = 'confirmed') {
  return [
    ...finish('implement', at, { snapshotRef: sha }),
    ...finish('review', at, reviewFindings(score)),
    ...finish('skeptic', at, skepticVerdict(verdict)),
    { op: 'advanceJoins', at }
  ];
}
const take = at => cmd({ kind: 'loop-taken', edgeId: 'loop', at });
const decide = (at, decision, extra = {}) => cmd({ kind: 'loop-decided', edgeId: 'loop', at, actor: 'dana', decision, ...extra });

const scriptedRuns = [
  { definition: 'improve', create: { runId: 'run-loop-grant-accept', projectId: 'p', at: T(0) }, ops: [
    ...improveRound(T(1), 60, 'sha-aaaaaaa1'), take(T(2)),
    ...improveRound(T(3), 75, 'sha-aaaaaaa2'), take(T(4)),
    ...improveRound(T(5), 70, 'sha-aaaaaaa3'), take(T(6)),
    ...improveRound(T(7), 72, 'sha-aaaaaaa4'),
    decide(T(8), 'accept'), decide(T(8), 'grant', { extraIterations: 1 }), take(T(9)),
    ...improveRound(T(10), 40, 'sha-aaaaaaa5'),
    decide(T(11), 'accept', { reason: 'good enough' }),
    cmd({ kind: 'loop-restored', at: T(12), ok: true }),
    { op: 'approve', nodeId: 'approve', at: T(13), actor: 'dana', policy: false }
  ] },
  { definition: 'improve', create: { runId: 'run-loop-stop', projectId: 'p', at: T(0), parameters: { rounds: 1 } }, ops: [
    ...improveRound(T(1), 10, 'sha-bbbbbbb1'), take(T(2)),
    ...improveRound(T(3), 20, 'sha-bbbbbbb2'),
    decide(T(4), 'grant', { extraIterations: 20 }), take(T(5)),
    ...improveRound(T(6), 5, 'sha-bbbbbbb3'),
    decide(T(7), 'stop'), decide(T(7), 'stop', { reason: 'not converging' }),
    cmd({ kind: 'loop-restored', at: T(8), ok: false, detail: 'worktree dirty' })
  ] },
  { definition: 'improve', create: { runId: 'run-loop-patience', projectId: 'p', at: T(0), parameters: { rounds: 5, target: 50 } }, ops: [
    ...improveRound(T(1), 30, 'sha-ccccccc1'), take(T(2)),
    ...improveRound(T(3), 20, 'sha-ccccccc2'), take(T(4)),
    ...improveRound(T(5), 25, 'sha-ccccccc3'), take(T(6)),
    ...improveRound(T(7), 10, 'sha-ccccccc4'),
    cmd({ kind: 'loop-restored', at: T(8), ok: true }),
    { op: 'approve', nodeId: 'approve', at: T(9), actor: 'dana', policy: false }
  ] },
  { definition: 'improve', create: { runId: 'run-skeptic-refutes', projectId: 'p', at: T(0) }, ops: [
    ...improveRound(T(1), 95, 'sha-ddddddd1', 'refuted'),
    { op: 'bypass', nodeId: 'approve', at: T(2), gate: 'review', actor: 'dana', reason: 'ok', policy: true }, { op: 'skipApproval', nodeId: 'approve', at: T(2), actor: 'dana' }
  ] },
  { definition: 'repair', create: { runId: 'run-repair-merge', projectId: 'p', at: T(0), permissionMode: 'auto' }, ops: [
    ...finish('build', T(1), { snapshotRef: 'sha-eeeeeee1' }),
    cmd({ kind: 'node-started', nodeId: 'test', at: T(2) }), cmd({ kind: 'node-failed', nodeId: 'test', at: T(2), error: 'tests failed', exitCode: 1 }),
    ...finish('fix', T(3), { snapshotRef: 'sha-eeeeeee2' }),
    cmd({ kind: 'node-retry', nodeId: 'test', at: T(4) }),
    ...finish('test', T(5)),
    cmd({ kind: 'node-started', nodeId: 'merge', at: T(6) }),
    cmd({ kind: 'node-failed', nodeId: 'merge', at: T(6), error: 'conflict', conflictFiles: ['src/a.ts'] }),
    { op: 'allowAiMergeResolution', nodeId: 'merge', at: T(7) },
    cmd({ kind: 'node-started', nodeId: 'merge', at: T(8) }),
    cmd({ kind: 'node-failed', nodeId: 'merge', at: T(8), error: 'conflict again', conflictFiles: ['src/a.ts'] }),
    take(T(9)), cmd({ kind: 'loop-taken', edgeId: 'mloop', at: T(9) }),
    ...finish('build', T(10), { snapshotRef: 'sha-eeeeeee3' }), ...finish('test', T(11)), ...finish('merge', T(12)),
    { op: 'advanceJoins', at: T(13) }, ...finish('notify', T(14)), { op: 'normalize' }
  ] },
  { definition: 'repair', create: { runId: 'run-provider-limit', projectId: 'p', at: T(0), providerLimitPolicy: 'switch' }, ops: [
    ...finish('build', T(1)), ...finish('test', T(2)), ...finish('merge', T(3)), { op: 'advanceJoins', at: T(3) },
    cmd({ kind: 'node-started', nodeId: 'notify', at: T(4) }),
    cmd({ kind: 'node-failed', nodeId: 'notify', at: T(4), error: 'quota', pause: 'provider-limit', provider: 'openai' }),
    cmd({ kind: 'stage-provider-switched', nodeId: 'notify', at: T(5), provider: 'anthropic', model: 'claude-x', automatic: true }),
    cmd({ kind: 'node-started', nodeId: 'notify', at: T(6) }),
    cmd({ kind: 'node-failed', nodeId: 'notify', at: T(6), error: 'quota', pause: 'provider-limit', provider: 'anthropic' }),
    cmd({ kind: 'provider-limit-stop', nodeId: 'notify', at: T(7), detail: 'both out' })
  ] }
];
for (const script of scriptedRuns) {
  const definition = definitions.find(d => d.id === script.definition);
  let current = run.createWorkflowRun({ ...script.create, definition });
  const steps = [];
  for (const operation of script.ops) {
    current = applyOperation(current, operation) ?? current;
    steps.push({ operation, observation: observe(current) });
  }
  const { definition: _definition, ...final } = JSON.parse(JSON.stringify(current));
  scenarios.push({ seed: script.create.runId, definition: definition.id, create: script.create, steps, final });
}

writeFileSync(join(here, 'run-parity.json.gz'), gzipSync(JSON.stringify({ definitions, policy: POLICY, timeoutNow: TIMEOUT_NOW, scenarios }), { level: 9 }));
console.log(`wrote ${scenarios.length} scenarios × ${STEPS} steps`);
