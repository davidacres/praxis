import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMapOutcome, formatMapItemBrief, mapItemsFor, plannedMapItems } from './workflowMap';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { normalizeWorkflow, validateWorkflow } from './workflowValidation';
import { WorkflowOrchestrator, type WorkflowRunPersistence } from './workflowOrchestrator';
import { scheduleWorkflowRun } from './workflowScheduler';
import { WORKFLOW_SCHEMA_VERSION, type CheckFinding, type WorkflowDefinition, type WorkflowMapNode } from './workflowTypes';

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 9, 8, 14, 0, clock++)).toISOString();

const finding = (fingerprint: string, severity: CheckFinding['severity'], message: string, extra: Partial<CheckFinding> = {}): CheckFinding =>
  ({ fingerprint, severity, category: 'bug', message, file: `src/${fingerprint}.ts`, ...extra });

function definition(map: Partial<WorkflowMapNode> = {}): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION, id: 'fan', name: 'Fan', scope: 'global', version: 1, entryNodeId: 'review',
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    nodes: [
      {
        type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' }, instructions: 'Review.',
        outputs: [{ id: 'review-findings', kind: 'findings', required: true }], mutatesWorktree: false
      },
      {
        type: 'map', id: 'fix', name: 'Fix each finding', x: 0, y: 0, inputs: ['review-findings'], over: 'review-findings', itemSource: 'findings',
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' }, instructions: 'Fix the finding you are given.', mutatesWorktree: true,
        concurrency: 2, maxItems: 2, onItemFailure: 'collect', outputs: [{ id: 'fixes', kind: 'diff', required: true }],
        ...map
      }
    ],
    edges: [{ id: 'e', from: 'review', to: 'fix', on: 'success', required: true }]
  };
}

function reviewed(findings: CheckFinding[], def = definition()): WorkflowRun {
  let r = createWorkflowRun({ runId: 'run-map', projectId: 'p1', definition: def, at: now() });
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'review', at: now() });
  return applyWorkflowRunCommand(r, {
    kind: 'node-succeeded', nodeId: 'review', at: now(),
    artifacts: [{ contractId: 'review-findings', kind: 'findings' }], findings: { findings, metrics: {} }
  });
}

test('a map node validates and round-trips; its list must be one of its inputs, and fan-out is bounded', () => {
  assert.deepEqual(validateWorkflow(normalizeWorkflow(definition())).errors, []);
  assert.deepEqual(normalizeWorkflow(JSON.parse(JSON.stringify(definition()))), JSON.parse(JSON.stringify(definition())));
  const bad = validateWorkflow(normalizeWorkflow(definition({ inputs: [], concurrency: 0, maxItems: 500 }))).errors.map(error => error.path).sort();
  assert.deepEqual(bad, ['nodes[1].concurrency', 'nodes[1].maxItems', 'nodes[1].over']);
});

test('items are the countable findings, most severe first, one per fingerprint', () => {
  const r = reviewed([
    finding('a', 'low', 'Minor'),
    finding('b', 'critical', 'Injection'),
    finding('b', 'critical', 'Injection'),
    finding('c', 'high', 'Refuted', { verdict: 'refuted' })
  ]);
  const items = mapItemsFor(r, r.definition.nodes[1] as WorkflowMapNode);
  assert.deepEqual(items.map(item => item.key), ['b', 'a']);
  assert.match(items[0].label, /^critical: Injection/);
});

test('beyond the item cap, items are deferred — never dropped — and the node fails saying so', () => {
  const r = reviewed([finding('a', 'high', 'A'), finding('b', 'high', 'B'), finding('c', 'high', 'C')]);
  const node = r.definition.nodes[1] as WorkflowMapNode;
  const planned = plannedMapItems(r, node);
  assert.deepEqual(planned.toRun.map(item => item.key), ['a', 'b']);
  assert.deepEqual(planned.deferred.map(item => item.key), ['c']);

  const outcome = aggregateMapOutcome(node, [
    { key: 'a', label: 'A', outcome: 'succeeded' },
    { key: 'b', label: 'B', outcome: 'succeeded' },
    { key: 'c', label: 'C', outcome: 'deferred' }
  ], { deferred: 1, mergedSnapshotRef: 'abc1234' });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /1 more item was deferred by the 2-item cap — retry to run it/);

  // A retry runs only what has not succeeded.
  let after = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'fix', at: now() });
  after = applyWorkflowRunCommand(after, { kind: 'node-failed', nodeId: 'fix', at: now(), error: outcome.error!, mapItems: outcome.mapItems });
  after = applyWorkflowRunCommand(after, { kind: 'node-retry', nodeId: 'fix', at: now() });
  const again = plannedMapItems(after, node);
  assert.deepEqual(again.toRun.map(item => item.key), ['c']);
  assert.deepEqual(again.done.map(item => item.key), ['a', 'b']);
});

test('item results fold into one outcome: findings deduplicated, failures named, the merged commit as the diff', () => {
  const node = definition({ mutatesWorktree: false, agent: { agentId: 'r', scope: 'global', toolMode: 'read-only' }, outputs: [{ id: 'notes', kind: 'findings', required: true }] }).nodes[1] as WorkflowMapNode;
  const shared = finding('x', 'medium', 'Shared');
  const ok = aggregateMapOutcome(node, [
    { key: 'a', label: 'A', outcome: 'succeeded', findings: { findings: [shared], metrics: { checked: 1 } } },
    { key: 'b', label: 'B', outcome: 'succeeded', findings: { findings: [shared, finding('y', 'low', 'Other')], metrics: { checked: 2 } } }
  ], { deferred: 0 });
  assert.equal(ok.status, 'succeeded');
  assert.deepEqual(ok.findings?.findings.map(item => item.fingerprint), ['x', 'y']);
  assert.equal(ok.findings?.metrics.checked, 3);

  const failed = aggregateMapOutcome(node, [
    { key: 'a', label: 'A', outcome: 'succeeded' },
    { key: 'b', label: 'B', outcome: 'failed', error: 'Merge conflict' }
  ], { deferred: 0 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /1 of 2 items failed: B \(Merge conflict\)/);
});

test('an item brief carries its one finding and says it works alone', () => {
  const node = definition().nodes[1] as WorkflowMapNode;
  const brief = formatMapItemBrief(node, { key: 'b', label: 'x', finding: finding('b', 'critical', 'SQL injection', { line: 9, suggestion: 'Parameterise it.' }) }, 0, 3);
  assert.match(brief, /Your item \(1 of 3\)/);
  assert.match(brief, /\[critical\] bug: SQL injection/);
  assert.match(brief, /Where: src\/b\.ts:9/);
  assert.match(brief, /own checkout/);
});

test('the orchestrator dispatches a map node to its host and records the items', async () => {
  const byId = new Map<string, WorkflowRun>();
  const runs: WorkflowRunPersistence = { get: id => byId.get(id), async save(saved) { byId.set(saved.runId, saved); return saved; } };
  const mapped: string[] = [];
  const orchestrator = new WorkflowOrchestrator({
    runs,
    now,
    dispatcher: {
      runCheck: async () => ({ status: 'succeeded' }),
      runAgentStage: async () => ({ status: 'succeeded', artifacts: [{ contractId: 'review-findings', kind: 'findings' }], findings: { findings: [finding('a', 'high', 'A')], metrics: {} } }),
      runMap: async (node, context) => {
        mapped.push(node.id);
        const items = plannedMapItems(context.run, node).toRun.map(item => ({ key: item.key, label: item.label, outcome: 'succeeded' as const }));
        return aggregateMapOutcome(node, items, { deferred: 0, mergedSnapshotRef: 'def5678' });
      }
    }
  });
  await runs.save(createWorkflowRun({ runId: 'run-map', projectId: 'p1', definition: definition(), at: now() }));
  await orchestrator.step('run-map');
  for (let i = 0; i < 30; i += 1) await new Promise(resolve => setImmediate(resolve));
  const r = runs.get('run-map')!;
  assert.deepEqual(mapped, ['fix']);
  assert.equal(r.nodes.fix.outcome, 'succeeded');
  assert.equal(r.nodes.fix.snapshotRef, 'def5678');
  assert.deepEqual(r.nodes.fix.mapItems?.map(item => [item.key, item.outcome]), [['a', 'succeeded']]);
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(scheduleWorkflowRun(r).ready, []);
});

test('an item that stopped on a provider limit pauses the map rather than failing it', () => {
  const node = definition().nodes[1] as WorkflowMapNode;
  const outcome = aggregateMapOutcome(node, [
    { key: 'a', label: 'A', outcome: 'succeeded' },
    { key: 'b', label: 'B', outcome: 'failed', pause: 'provider-limit', error: 'Out of credits' }
  ], { deferred: 0 });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.pause, 'provider-limit');
  assert.match(outcome.error ?? '', /1 item could not run .*Out of credits.*finished items are kept/);
});
