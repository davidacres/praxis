import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNode,
  addOutput,
  connectNodes,
  designerFeedback,
  disconnect,
  duplicateNode,
  emptyWorkflowDefinition,
  moveNode,
  newNode,
  removeNode,
  removeOutput,
  setEntryNode,
  updateEdge,
  updateNode
} from './workflowDesignerState';
import { governedDeliveryTemplate } from './workflowTemplates';
import { validateWorkflow } from './workflowValidation';
import type { WorkflowDefinition } from './workflowTypes';

const T = '2026-09-02T10:00:00.000Z';

function blank(): WorkflowDefinition {
  return emptyWorkflowDefinition({ id: 'w1', name: 'W1', scope: 'global', at: T });
}

// ── Creation ─────────────────────────────────────────────────────────────

test('a blank workflow has one node, which is the entry', () => {
  const definition = blank();
  assert.equal(definition.nodes.length, 1);
  assert.equal(definition.entryNodeId, definition.nodes[0].id);
  assert.equal(definition.nodes[0].type, 'agent-task');
});

test('a project-scoped blank workflow carries its projectId', () => {
  const definition = emptyWorkflowDefinition({ id: 'w1', name: 'W1', scope: 'project', projectId: 'p1', at: T });
  assert.equal(definition.scope, 'project');
  assert.equal(definition.projectId, 'p1');
});

// ── Add / move / update ──────────────────────────────────────────────────

test('adding a node appends it and leaves the entry alone', () => {
  const definition = blank();
  const check = newNode('check', { x: 300, y: 80 });
  const next = addNode(definition, check);
  assert.equal(next.nodes.length, 2);
  assert.equal(next.entryNodeId, definition.entryNodeId);
});

test('adding a node with a colliding id is a no-op', () => {
  const definition = blank();
  const clash = { ...newNode('check', { x: 0, y: 0 }), id: definition.nodes[0].id };
  assert.equal(addNode(definition, clash), definition);
});

test('moving a node rounds and stores its coordinates', () => {
  const definition = blank();
  const moved = moveNode(definition, definition.nodes[0].id, { x: 12.7, y: 40.2 });
  assert.deepEqual([moved.nodes[0].x, moved.nodes[0].y], [13, 40]);
});

test('updateNode applies a shallow patch and bumps updatedAt', async () => {
  const definition = blank();
  await new Promise(resolve => setTimeout(resolve, 2));
  const renamed = updateNode(definition, definition.nodes[0].id, { name: 'Plan it' });
  assert.equal(renamed.nodes[0].name, 'Plan it');
  assert.notEqual(renamed.updatedAt, definition.updatedAt);
});

// ── Connect / disconnect ─────────────────────────────────────────────────

test('connecting two nodes adds a success edge by default', () => {
  let definition = blank();
  definition = addNode(definition, newNode('approval', { x: 300, y: 80 }));
  const [a, b] = definition.nodes;
  const linked = connectNodes(definition, { from: a.id, to: b.id });
  assert.equal(linked.edges.length, 1);
  assert.equal(linked.edges[0].on, 'success');
  assert.equal(linked.edges[0].required, true);
});

test('a self-loop is refused', () => {
  const definition = blank();
  const id = definition.nodes[0].id;
  assert.equal(connectNodes(definition, { from: id, to: id }), definition);
});

test('a duplicate edge with the same outcome is refused, a different outcome is allowed', () => {
  let definition = blank();
  definition = addNode(definition, newNode('check', { x: 300, y: 80 }));
  const [a, b] = definition.nodes;
  definition = connectNodes(definition, { from: a.id, to: b.id, on: 'success' });
  const dupe = connectNodes(definition, { from: a.id, to: b.id, on: 'success' });
  assert.equal(dupe, definition, 'the duplicate is rejected');
  const withFailure = connectNodes(definition, { from: a.id, to: b.id, on: 'failure' });
  assert.equal(withFailure.edges.length, 2, 'the failure edge is a distinct route');
});

test('a cycle is not blocked by connect — it is left for validation to report', () => {
  let definition = blank();
  definition = addNode(definition, newNode('check', { x: 300, y: 80 }));
  const [a, b] = definition.nodes;
  definition = connectNodes(definition, { from: a.id, to: b.id });
  definition = connectNodes(definition, { from: b.id, to: a.id });
  assert.equal(definition.edges.length, 2);
  assert.ok(validateWorkflow(definition).errors.some(issue => /cycle/.test(issue.message)));
});

test('disconnect removes exactly one edge', () => {
  let definition = blank();
  definition = addNode(definition, newNode('approval', { x: 300, y: 80 }));
  const [a, b] = definition.nodes;
  definition = connectNodes(definition, { from: a.id, to: b.id });
  const edgeId = definition.edges[0].id;
  assert.equal(disconnect(definition, edgeId).edges.length, 0);
});

test('updateEdge changes an outcome or required flag in place', () => {
  let definition = blank();
  definition = addNode(definition, newNode('check', { x: 300, y: 80 }));
  const [a, b] = definition.nodes;
  definition = connectNodes(definition, { from: a.id, to: b.id });
  const next = updateEdge(definition, definition.edges[0].id, { required: false, on: 'always' });
  assert.equal(next.edges[0].required, false);
  assert.equal(next.edges[0].on, 'always');
});

// ── Remove ───────────────────────────────────────────────────────────────

test('removing a node drops every edge that touched it', () => {
  const template = governedDeliveryTemplate();
  const next = removeNode(template, 'implement');
  assert.equal(next.nodes.some(node => node.id === 'implement'), false);
  assert.equal(next.edges.some(edge => edge.from === 'implement' || edge.to === 'implement'), false);
});

test('removing a node clears now-dangling inputs on the survivors', () => {
  const template = governedDeliveryTemplate();
  // implement produces change-diff, which test-contracts consumes.
  const next = removeNode(template, 'implement');
  const contracts = next.nodes.find(node => node.id === 'test-contracts');
  assert.deepEqual(contracts?.inputs, [], 'the change-diff input is gone with its producer');
});

test('removing the entry node promotes a node with no inbound edge', () => {
  const template = governedDeliveryTemplate();
  const next = removeNode(template, 'plan');
  assert.equal(next.entryNodeId, 'implement', 'the next rootless node becomes the entry');
});

// ── Duplicate ────────────────────────────────────────────────────────────

test('duplicating a node gives it a fresh id, an offset, and no edges', () => {
  const template = governedDeliveryTemplate();
  const before = template.nodes.length;
  const next = duplicateNode(template, 'qa');
  assert.equal(next.nodes.length, before + 1);
  const copy = next.nodes[next.nodes.length - 1];
  assert.notEqual(copy.id, 'qa');
  assert.deepEqual(copy.inputs, []);
  assert.equal(next.edges.some(edge => edge.from === copy.id || edge.to === copy.id), false);
});

test('a duplicated node does not carry the original gate or artifact ids', () => {
  const template = governedDeliveryTemplate();
  const next = duplicateNode(template, 'review');
  const copy = next.nodes[next.nodes.length - 1];
  assert.equal(copy.type === 'agent-task' && copy.satisfiesGate, undefined);
  assert.equal(
    copy.type === 'agent-task' && copy.outputs[0].id !== 'review-report',
    true,
    'the copy gets fresh artifact ids so contracts do not collide'
  );
});

// ── Outputs ──────────────────────────────────────────────────────────────

test('adding then removing an output also cleans up any consumer input', () => {
  let definition = blank();
  definition = addNode(definition, newNode('check', { x: 300, y: 80 }));
  const [producer, consumer] = definition.nodes;
  definition = addOutput(definition, producer.id, { id: 'art-1', kind: 'report', required: true });
  definition = updateNode(definition, consumer.id, { inputs: ['art-1'] });
  assert.deepEqual(definition.nodes[1].inputs, ['art-1']);

  definition = removeOutput(definition, producer.id, 'art-1');
  const producerNode = definition.nodes.find(node => node.id === producer.id);
  assert.deepEqual(producerNode?.type === 'agent-task' ? producerNode.outputs : ['x'], []);
  const consumerNode = definition.nodes.find(node => node.id === consumer.id);
  assert.deepEqual(consumerNode?.inputs, [], 'the consumer input went with the artifact');
});

// ── Deployment nodes (FX-BE-058 / TASK-155) ─────────────────────────────

test('newNode creates a deployment stage with an empty profile id and no outputs', () => {
  const node = newNode('deployment', { x: 10, y: 20 });
  assert.equal(node.type, 'deployment');
  assert.equal(node.type === 'deployment' && node.deploymentProfileId, '');
  assert.deepEqual(node.type === 'deployment' ? node.outputs : undefined, []);
});

test('addOutput and removeOutput work on a deployment node the same as a check node', () => {
  let definition = blank();
  definition = addNode(definition, newNode('deployment', { x: 300, y: 80 }));
  const [, deploy] = definition.nodes;
  definition = addOutput(definition, deploy.id, { id: 'deploy-report', kind: 'report', required: true });
  const withOutput = definition.nodes.find(node => node.id === deploy.id);
  assert.deepEqual(withOutput?.type === 'deployment' ? withOutput.outputs.map(o => o.id) : [], ['deploy-report']);

  definition = removeOutput(definition, deploy.id, 'deploy-report');
  const withoutOutput = definition.nodes.find(node => node.id === deploy.id);
  assert.deepEqual(withoutOutput?.type === 'deployment' ? withoutOutput.outputs : ['x'], []);
});

test('removing a node that produced a deployment stage input clears that input', () => {
  let definition = blank();
  definition = addNode(definition, newNode('deployment', { x: 300, y: 80 }));
  const [producer, deploy] = definition.nodes;
  definition = addOutput(definition, producer.id, { id: 'build-artifact', kind: 'diff', required: true });
  definition = updateNode(definition, deploy.id, { inputs: ['build-artifact'] });

  const next = removeNode(definition, producer.id);
  const survivor = next.nodes.find(node => node.id === deploy.id);
  assert.deepEqual(survivor?.inputs, [], 'the input went with its producer, the same rule check/agent-task nodes follow');
});

test('a duplicated deployment node does not carry the original gate or artifact ids', () => {
  let definition = blank();
  definition = addNode(definition, newNode('deployment', { x: 300, y: 80 }));
  const [, deploy] = definition.nodes;
  definition = addOutput(definition, deploy.id, { id: 'deploy-report', kind: 'report', required: true });
  definition = updateNode(definition, deploy.id, { satisfiesGate: 'security' } as never);

  const next = duplicateNode(definition, deploy.id);
  const copy = next.nodes[next.nodes.length - 1];
  assert.equal(copy.type, 'deployment');
  assert.equal(copy.type === 'deployment' && copy.satisfiesGate, undefined);
  assert.equal(
    copy.type === 'deployment' && copy.outputs[0].id !== 'deploy-report',
    true,
    'the copy gets a fresh artifact id so contracts do not collide'
  );
});

// ── setEntryNode ─────────────────────────────────────────────────────────

test('setEntryNode only accepts a node that exists', () => {
  const definition = blank();
  assert.equal(setEntryNode(definition, 'ghost'), definition);
  const check = newNode('check', { x: 0, y: 0 });
  const withCheck = addNode(definition, check);
  assert.equal(setEntryNode(withCheck, check.id).entryNodeId, check.id);
});

// ── Live feedback ────────────────────────────────────────────────────────

test('feedback buckets each issue under the node it concerns', () => {
  let definition = blank();
  // An agent stage with no agent id and no instructions: two node-level errors.
  const feedback = designerFeedback(definition);
  assert.equal(feedback.valid, false);
  const nodeId = definition.nodes[0].id;
  assert.ok(feedback.byNode[nodeId]?.length >= 1);
  assert.ok(feedback.byNode[nodeId].every(issue => issue.path.startsWith('nodes[0]')));
});

test('graph-level issues land under the empty key', () => {
  const template = governedDeliveryTemplate();
  const broken = { ...template, edges: [...template.edges, { id: 'loop', from: 'approve', to: 'plan', on: 'always' as const, required: false }] };
  const feedback = designerFeedback(broken);
  assert.ok((feedback.byNode[''] ?? []).some(issue => /cycle/.test(issue.message) || issue.path === 'entryNodeId'));
});

test('a clean template reports valid with no bucketed issues', () => {
  const feedback = designerFeedback(governedDeliveryTemplate());
  assert.equal(feedback.valid, true);
  assert.deepEqual(feedback.errors, []);
});
