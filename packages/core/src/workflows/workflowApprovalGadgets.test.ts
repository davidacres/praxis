import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceGadgetBlock, type ApprovalGadgetPayload, type ChatBlock, type GadgetLifecycleState, type RawChatBlockInput } from '../ai/gadgets';
import { approveStage } from './workflowGates';
import { approvalGadgetId, planApprovalGadgetSync } from './workflowApprovalGadgets';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';

const T = (m: number): string => new Date(Date.UTC(2026, 8, 2, 9, m)).toISOString();
const SCOPE = { hostId: 'h1', sessionId: 's1' };

/** implement → review → approve-a (gated on review), and implement → approve-b (ungated). */
function definitionWithTwoApprovals(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'd', name: 'D', scope: 'global', version: 1, entryNodeId: 'implement',
    createdAt: T(0), updatedAt: T(0),
    nodes: [
      {
        type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: [],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Build.', outputs: [], mutatesWorktree: true
      },
      {
        type: 'check', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
        command: 'npm', successExitCodes: [0], outputs: [], satisfiesGate: 'review'
      },
      { type: 'approval', id: 'approve-a', name: 'Approve A', x: 0, y: 0, inputs: [], prompt: 'Ship A?', requiredGates: ['review'], allowBypass: false },
      { type: 'approval', id: 'approve-b', name: 'Approve B', x: 0, y: 0, inputs: [], prompt: 'Ship B?', requiredGates: [], allowBypass: false }
    ],
    edges: [
      { id: 'e1', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e2', from: 'review', to: 'approve-a', on: 'success', required: true },
      { id: 'e3', from: 'implement', to: 'approve-b', on: 'success', required: true }
    ]
  };
}

function runReadyForApprovals(): WorkflowRun {
  const started = createWorkflowRun({ runId: 'r1', projectId: 'p1', definition: definitionWithTwoApprovals(), at: T(0) });
  let next = applyWorkflowRunCommand(started, { kind: 'node-started', nodeId: 'implement', at: T(1), sessionId: 's-implement' });
  next = applyWorkflowRunCommand(next, { kind: 'node-succeeded', nodeId: 'implement', at: T(2) });
  next = applyWorkflowRunCommand(next, { kind: 'node-started', nodeId: 'review', at: T(2) });
  next = applyWorkflowRunCommand(next, { kind: 'node-succeeded', nodeId: 'review', at: T(3) });
  return next;
}

/** What `GadgetService.getBlocks` would hand back for a just-published raw block, with a given lifecycle state. */
function asChatBlock(input: RawChatBlockInput, index: number, state: GadgetLifecycleState): ChatBlock {
  assert.equal(input.type, 'gadget');
  if (input.type !== 'gadget') throw new Error('unreachable');
  const coerced = coerceGadgetBlock(input.gadget, `b${index}`);
  assert.equal(coerced.type, 'gadget');
  if (coerced.type !== 'gadget') throw new Error('unreachable');
  return { ...coerced, gadget: { ...coerced.gadget, state } };
}

function nodeIdOf(block: ChatBlock): string | undefined {
  assert.equal(block.type, 'gadget');
  if (block.type !== 'gadget') throw new Error('unreachable');
  return (block.gadget.payload as ApprovalGadgetPayload).nodeId;
}

test('publishes one gadget per node awaiting approval, with its gate and nodeId in the payload', () => {
  const run = runReadyForApprovals();
  const plan = planApprovalGadgetSync(run, SCOPE, [], T(3));

  assert.equal(plan.revoke.length, 0);
  assert.equal(plan.publish.length, 2);

  const byNode = new Map(
    plan.publish.map((block, index) => {
      const chatBlock = asChatBlock(block, index, 'active');
      return [nodeIdOf(chatBlock), chatBlock] as const;
    })
  );
  const a = byNode.get('approve-a');
  assert.ok(a && a.type === 'gadget');
  if (!a || a.type !== 'gadget') throw new Error('unreachable');
  assert.equal(a.gadget.gadgetId, approvalGadgetId('r1', 'approve-a'));
  assert.equal(a.gadget.kind, 'approval');
  assert.equal(a.gadget.scope.workId, 'r1');
  assert.equal((a.gadget.payload as ApprovalGadgetPayload).gate, 'review');

  const b = byNode.get('approve-b');
  assert.ok(b && b.type === 'gadget');
  if (!b || b.type !== 'gadget') throw new Error('unreachable');
  // No required gate declared — falls back to a generic, still-required gate string.
  assert.equal((b.gadget.payload as ApprovalGadgetPayload).gate, 'workflow.approval');
});

test('does not republish a gadget for a node still awaiting approval', () => {
  const run = runReadyForApprovals();
  const first = planApprovalGadgetSync(run, SCOPE, [], T(3));
  const existing = first.publish.map((block, index) => asChatBlock(block, index, 'active'));

  const second = planApprovalGadgetSync(run, SCOPE, existing, T(4));
  assert.deepEqual(second.publish, []);
  assert.deepEqual(second.revoke, []);
});

test('revokes an untouched gadget once its node is approved elsewhere', () => {
  const run = runReadyForApprovals();
  const published = planApprovalGadgetSync(run, SCOPE, [], T(3)).publish;
  const existing = published.map((block, index) => asChatBlock(block, index, 'active'));

  const approved = approveStage(run, 'approve-a', { actor: 'run-monitor', at: T(5) });
  assert.equal(approved.ok, true);

  const plan = planApprovalGadgetSync(approved.run, SCOPE, existing, T(6));
  assert.deepEqual(plan.revoke, [approvalGadgetId('r1', 'approve-a')]);
  // approve-b is still awaiting, and was already published — nothing new to do for it.
  assert.equal(plan.publish.length, 0);
});

test('never revokes a gadget that already carries a recorded answer', () => {
  const run = runReadyForApprovals();
  const published = planApprovalGadgetSync(run, SCOPE, [], T(3)).publish;
  // Simulate the ledger having already completed this gadget's own submission —
  // the state GadgetService.getBlocks would report is 'completed', not 'active'.
  const existing = published.map((block, index) => asChatBlock(block, index, 'completed'));

  const approved = approveStage(run, 'approve-a', { actor: 'desktop-user', at: T(5) });
  assert.equal(approved.ok, true);

  const plan = planApprovalGadgetSync(approved.run, SCOPE, existing, T(6));
  assert.deepEqual(plan.revoke, []);
});

test('ignores approval gadgets scoped to a different run', () => {
  const run = runReadyForApprovals();
  const foreignInput: RawChatBlockInput = {
    type: 'gadget',
    gadget: {
      version: 1,
      kind: 'approval',
      gadgetId: approvalGadgetId('other-run', 'approve-a'),
      scope: { hostId: 'h1', sessionId: 's1', workId: 'other-run' },
      issuedAt: T(0),
      payload: { title: 'Approve', summary: 'x', gate: 'review', nodeId: 'approve-a' },
      actions: [{ actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'review' }]
    }
  };
  const foreign = asChatBlock(foreignInput, 0, 'active');

  const plan = planApprovalGadgetSync(run, SCOPE, [foreign], T(3));
  // Both nodes still need a gadget of their own — the foreign block for the same
  // nodeId under a different run must not be mistaken for one already issued.
  assert.equal(plan.publish.length, 2);
  assert.equal(plan.revoke.length, 0);
});
