/**
 * Workflow designer editor model — host-agnostic (FX-BE-021 / TASK-102).
 *
 * Pure operations the canvas calls: add, configure, move, duplicate, connect,
 * and remove. Each takes a `WorkflowDefinition` and returns a new one, so the
 * React page holds a single definition in state and undo/redo is a stack of
 * these values — the same shape `taskDesignerState` uses for the ticket graph,
 * kept as separate types because a workflow carries execution semantics a
 * ticket graph never does.
 *
 * These helpers keep the graph *coherent* (no dangling edges, no duplicate
 * ids); they do not keep it *valid*. Validity is `validateWorkflow`, run live
 * by the page so the author sees a cycle or an unsatisfied gate as they build.
 */

import {
  isAgentTaskNode,
  isCheckNode,
  isDeploymentNode,
  nodeOutputs,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowArtifactContract,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowEdgeOutcome,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowScope
} from './workflowTypes';
import { validateWorkflow, type WorkflowIssue } from './workflowValidation';

export interface CreateDefinitionInput {
  id: string;
  name: string;
  scope: WorkflowScope;
  projectId?: string;
  at: string;
}

/** A blank workflow: one agent stage, marked as the entry, nothing else. */
export function emptyWorkflowDefinition(input: CreateDefinitionInput): WorkflowDefinition {
  const entry = newNode('agent-task', { x: 80, y: 80 });
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    scope: input.scope,
    ...(input.scope === 'project' && input.projectId ? { projectId: input.projectId } : {}),
    version: 1,
    nodes: [entry],
    edges: [],
    entryNodeId: entry.id,
    createdAt: input.at,
    updatedAt: input.at
  };
}

// ── Node factory ─────────────────────────────────────────────────────────

let nodeCounter = 0;

/** Deterministic-ish id; the page may override with its own scheme. */
function freshId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nodeCounter}`;
}

export function newNode(type: WorkflowNodeType, at: { x: number; y: number }): WorkflowNode {
  const base = { id: freshId(type), x: at.x, y: at.y, inputs: [] as string[] };
  switch (type) {
    case 'agent-task':
      return {
        ...base,
        type: 'agent-task',
        name: 'Agent stage',
        agent: { agentId: '', scope: 'global', toolMode: 'read-only' },
        instructions: '',
        outputs: [],
        mutatesWorktree: true
      };
    case 'check':
      return { ...base, type: 'check', name: 'Check', command: '', successExitCodes: [0], outputs: [] };
    case 'deployment':
      return { ...base, type: 'deployment', name: 'Deployment', deploymentProfileId: '', outputs: [] };
    case 'approval':
      return { ...base, type: 'approval', name: 'Approval', prompt: '', requiredGates: [], allowBypass: false };
    case 'join':
      return { ...base, type: 'join', name: 'Join', mode: 'all' };
  }
}

// ── Mutations ────────────────────────────────────────────────────────────

function touch(definition: WorkflowDefinition, nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
  return { ...definition, nodes, edges, updatedAt: new Date().toISOString() };
}

export function addNode(definition: WorkflowDefinition, node: WorkflowNode): WorkflowDefinition {
  if (definition.nodes.some(candidate => candidate.id === node.id)) return definition;
  const nodes = [...definition.nodes, node];
  // The very first node added to an empty graph becomes the entry.
  const entryNodeId = definition.nodes.length === 0 ? node.id : definition.entryNodeId;
  return { ...touch(definition, nodes, definition.edges), entryNodeId };
}

export function moveNode(definition: WorkflowDefinition, nodeId: string, to: { x: number; y: number }): WorkflowDefinition {
  const nodes = definition.nodes.map(node =>
    node.id === nodeId ? { ...node, x: Math.round(to.x), y: Math.round(to.y) } : node
  );
  return touch(definition, nodes, definition.edges);
}

/**
 * Applies a shallow patch to one node.
 *
 * Type is never patched — changing a node's kind means removing it and adding
 * the new kind, so its now-meaningless fields cannot linger.
 */
export function updateNode(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>
): WorkflowDefinition {
  const nodes = definition.nodes.map(node =>
    node.id === nodeId ? ({ ...node, ...patch } as WorkflowNode) : node
  );
  return touch(definition, nodes, definition.edges);
}

/**
 * Removes a node and every edge touching it.
 *
 * If the entry node goes, the entry falls to the first remaining node with no
 * inbound edge, or the first node, or empty — the page surfaces the resulting
 * validation error rather than this silently picking a wrong root.
 */
export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const nodes = definition.nodes.filter(node => node.id !== nodeId);
  const edges = definition.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);

  // Inputs that named an artifact only this node produced are now dangling;
  // drop them so the graph stays coherent.
  const producedElsewhere = new Set(nodes.flatMap(node => nodeOutputs(node).map(o => o.id)));
  const cleanedNodes = nodes.map(node => ({
    ...node,
    inputs: node.inputs.filter(input => producedElsewhere.has(input))
  }));

  let entryNodeId = definition.entryNodeId;
  if (entryNodeId === nodeId) {
    const withoutInbound = cleanedNodes.find(node => !edges.some(edge => edge.to === node.id));
    entryNodeId = withoutInbound?.id ?? cleanedNodes[0]?.id ?? '';
  }

  return { ...touch(definition, cleanedNodes, edges), entryNodeId };
}

/**
 * Copies a node a short offset away, with a fresh id and no edges. Its output
 * artifact ids are regenerated so the duplicate does not collide with the
 * original's contracts.
 */
export function duplicateNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const source = definition.nodes.find(node => node.id === nodeId);
  if (!source) return definition;

  const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode;
  copy.id = freshId(source.type);
  copy.x = source.x + 40;
  copy.y = source.y + 40;
  copy.inputs = [];
  if (isAgentTaskNode(copy) || isCheckNode(copy) || isDeploymentNode(copy)) {
    copy.outputs = copy.outputs.map(output => ({ ...output, id: `${output.id}-${copy.id}` }));
    copy.satisfiesGate = undefined;
  }

  return touch(definition, [...definition.nodes, copy], definition.edges);
}

export interface ConnectInput {
  from: string;
  to: string;
  on?: WorkflowEdgeOutcome;
  required?: boolean;
}

/**
 * Adds an edge.
 *
 * Refuses a self-loop and a duplicate (same from/to/outcome). Does *not* refuse
 * a cycle or a second concurrent parent — those are validation errors the page
 * shows, not something to silently swallow, because the author may be mid-way
 * through a rearrangement.
 */
export function connectNodes(definition: WorkflowDefinition, input: ConnectInput): WorkflowDefinition {
  if (input.from === input.to) return definition;
  const on = input.on ?? 'success';
  const exists = definition.edges.some(
    edge => edge.from === input.from && edge.to === input.to && edge.on === on
  );
  if (exists) return definition;
  if (!definition.nodes.some(n => n.id === input.from) || !definition.nodes.some(n => n.id === input.to)) {
    return definition;
  }

  const edge: WorkflowEdge = {
    id: freshId('edge'),
    from: input.from,
    to: input.to,
    on,
    required: input.required ?? true
  };
  return touch(definition, definition.nodes, [...definition.edges, edge]);
}

export function disconnect(definition: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  return touch(
    definition,
    definition.nodes,
    definition.edges.filter(edge => edge.id !== edgeId)
  );
}

export function updateEdge(
  definition: WorkflowDefinition,
  edgeId: string,
  patch: Partial<Pick<WorkflowEdge, 'on' | 'required'>>
): WorkflowDefinition {
  return touch(
    definition,
    definition.nodes,
    definition.edges.map(edge => (edge.id === edgeId ? { ...edge, ...patch } : edge))
  );
}

export function setEntryNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  if (!definition.nodes.some(node => node.id === nodeId)) return definition;
  return { ...definition, entryNodeId: nodeId, updatedAt: new Date().toISOString() };
}

/** Adds a declared output artifact to an agent, check, or deployment node. */
export function addOutput(
  definition: WorkflowDefinition,
  nodeId: string,
  artifact: WorkflowArtifactContract
): WorkflowDefinition {
  const nodes = definition.nodes.map(node => {
    if (node.id !== nodeId || !(isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node))) return node;
    if (node.outputs.some(output => output.id === artifact.id)) return node;
    return { ...node, outputs: [...node.outputs, artifact] };
  });
  return touch(definition, nodes, definition.edges);
}

export function removeOutput(definition: WorkflowDefinition, nodeId: string, artifactId: string): WorkflowDefinition {
  const nodes = definition.nodes.map(node => {
    if (node.id !== nodeId || !(isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node))) return node;
    return { ...node, outputs: node.outputs.filter(output => output.id !== artifactId) };
  });
  // Any node consuming the removed artifact loses that input.
  const cleaned = nodes.map(node => ({ ...node, inputs: node.inputs.filter(input => input !== artifactId) }));
  return touch(definition, cleaned, definition.edges);
}

// ── Live feedback ────────────────────────────────────────────────────────

export interface DesignerFeedback {
  valid: boolean;
  /** Issues keyed by the node id they concern; `''` holds graph-level issues. */
  byNode: Record<string, WorkflowIssue[]>;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
}

const NODE_PATH = /^nodes\[(\d+)\]/;

/**
 * Runs validation and buckets each issue under the node it points at, so the
 * canvas can badge the offending node instead of showing a flat list.
 */
export function designerFeedback(definition: WorkflowDefinition): DesignerFeedback {
  const result = validateWorkflow(definition);
  const byNode: Record<string, WorkflowIssue[]> = {};

  for (const issue of [...result.errors, ...result.warnings]) {
    const match = NODE_PATH.exec(issue.path);
    const key = match ? definition.nodes[Number(match[1])]?.id ?? '' : '';
    byNode[key] = [...(byNode[key] ?? []), issue];
  }

  return { valid: result.valid, byNode, errors: result.errors, warnings: result.warnings };
}
