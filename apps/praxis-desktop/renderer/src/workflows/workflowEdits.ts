/**
 * Browser-safe workflow editor mutations.
 *
 * A renderer-local copy of core's `workflowDesignerState` helpers, kept here for
 * the same reason `taskDesigner` keeps its own: the renderer may import only
 * *types* from `@praxis/core` at runtime (the package is CommonJS and pulls in
 * chokidar / markdown-it, so its barrel cannot enter the browser bundle).
 *
 * These keep the graph coherent — no dangling edges, no duplicate ids. Validity
 * (cycles, gates, reachability) is answered by `window.praxis.workflows.validate`
 * over IPC, which runs core's real validator.
 */

import type {
  WorkflowArtifactContract,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEdgeOutcome,
  WorkflowNode,
  WorkflowNodeType
} from '@praxis/core';

let counter = 0;
function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

const producesOutputs = (node: WorkflowNode): node is Extract<WorkflowNode, { outputs: WorkflowArtifactContract[] }> =>
  node.type === 'agent-task' || node.type === 'check' || node.type === 'deployment';

export function newNode(type: WorkflowNodeType, at: { x: number; y: number }): WorkflowNode {
  const base = { id: freshId(type), x: at.x, y: at.y, inputs: [] as string[] };
  switch (type) {
    case 'agent-task':
      return {
        ...base,
        type: 'agent-task',
        name: 'Agent stage',
        agent: { agentId: '', profileId: '', hostId: '', scope: 'global', toolMode: 'read-only' },
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

function touch(definition: WorkflowDefinition, nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
  return { ...definition, nodes, edges, updatedAt: new Date().toISOString() };
}

export function addNode(definition: WorkflowDefinition, node: WorkflowNode): WorkflowDefinition {
  if (definition.nodes.some(candidate => candidate.id === node.id)) return definition;
  const entryNodeId = definition.nodes.length === 0 ? node.id : definition.entryNodeId;
  return { ...touch(definition, [...definition.nodes, node], definition.edges), entryNodeId };
}

export function updateNode(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>
): WorkflowDefinition {
  const nodes = definition.nodes.map(node => (node.id === nodeId ? ({ ...node, ...patch } as WorkflowNode) : node));
  return touch(definition, nodes, definition.edges);
}

/** Repositions a node on the canvas; coordinates are rounded and clamped to non-negative. */
export function moveNode(definition: WorkflowDefinition, nodeId: string, to: { x: number; y: number }): WorkflowDefinition {
  const nodes = definition.nodes.map(node =>
    node.id === nodeId ? { ...node, x: Math.max(0, Math.round(to.x)), y: Math.max(0, Math.round(to.y)) } : node
  );
  return touch(definition, nodes, definition.edges);
}

export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const nodes = definition.nodes.filter(node => node.id !== nodeId);
  const edges = definition.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);

  const producedElsewhere = new Set(nodes.flatMap(node => (producesOutputs(node) ? node.outputs.map(o => o.id) : [])));
  const cleaned = nodes.map(node => ({ ...node, inputs: node.inputs.filter(input => producedElsewhere.has(input)) }));

  let entryNodeId = definition.entryNodeId;
  if (entryNodeId === nodeId) {
    const rootless = cleaned.find(node => !edges.some(edge => edge.to === node.id));
    entryNodeId = rootless?.id ?? cleaned[0]?.id ?? '';
  }
  return { ...touch(definition, cleaned, edges), entryNodeId };
}

export function duplicateNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const source = definition.nodes.find(node => node.id === nodeId);
  if (!source) return definition;

  const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode;
  copy.id = freshId(source.type);
  copy.x = source.x + 40;
  copy.y = source.y + 40;
  copy.inputs = [];
  if (producesOutputs(copy)) {
    copy.outputs = copy.outputs.map(output => ({ ...output, id: `${output.id}-${copy.id}` }));
    copy.satisfiesGate = undefined;
  }
  return touch(definition, [...definition.nodes, copy], definition.edges);
}

export function connectNodes(
  definition: WorkflowDefinition,
  input: { from: string; to: string; on?: WorkflowEdgeOutcome; required?: boolean }
): WorkflowDefinition {
  if (input.from === input.to) return definition;
  const on = input.on ?? 'success';
  if (definition.edges.some(edge => edge.from === input.from && edge.to === input.to && edge.on === on)) return definition;
  if (!definition.nodes.some(n => n.id === input.from) || !definition.nodes.some(n => n.id === input.to)) return definition;

  const edge: WorkflowEdge = { id: freshId('edge'), from: input.from, to: input.to, on, required: input.required ?? true };
  return touch(definition, definition.nodes, [...definition.edges, edge]);
}

export function disconnect(definition: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  return touch(definition, definition.nodes, definition.edges.filter(edge => edge.id !== edgeId));
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

// ── Feedback bucketing ───────────────────────────────────────────────────

const NODE_PATH = /^nodes\[(\d+)\]/;

export interface BucketedFeedback {
  valid: boolean;
  byNode: Record<string, Array<{ path: string; message: string }>>;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
}

/** Buckets a `WorkflowValidationResult` from IPC under the node id each issue points at. */
export function bucketFeedback(
  definition: WorkflowDefinition,
  result: { valid: boolean; errors: Array<{ path: string; message: string }>; warnings: Array<{ path: string; message: string }> }
): BucketedFeedback {
  const byNode: Record<string, Array<{ path: string; message: string }>> = {};
  for (const issue of [...result.errors, ...result.warnings]) {
    const match = NODE_PATH.exec(issue.path);
    const key = match ? definition.nodes[Number(match[1])]?.id ?? '' : '';
    byNode[key] = [...(byNode[key] ?? []), issue];
  }
  return { valid: result.valid, byNode, errors: result.errors, warnings: result.warnings };
}

export type ValidationCategoryKind = 'connections' | 'flow' | 'configuration' | 'gates' | 'policy';

export interface WorkflowValidationCategory {
  kind: ValidationCategoryKind;
  title: string;
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  summary: string;
}

export interface WorkflowValidationReport {
  valid: boolean;
  totalStages: number;
  totalConnections: number;
  entryNodeId?: string;
  entryNodeName?: string;
  categories: WorkflowValidationCategory[];
  allErrors: Array<{ path: string; message: string; targetNodeId?: string; targetNodeName?: string; category: ValidationCategoryKind }>;
  allWarnings: Array<{ path: string; message: string; targetNodeId?: string; targetNodeName?: string; category: ValidationCategoryKind }>;
}

export function categorizeWorkflowIssue(issue: { path: string; message: string }): ValidationCategoryKind {
  const p = issue.path.toLowerCase();
  const m = issue.message.toLowerCase();

  if (
    p.startsWith('edges') ||
    m.includes('connection') ||
    m.includes('edge') ||
    m.includes('concurrent parent') ||
    m.includes('join')
  ) {
    return 'connections';
  }
  if (
    p.startsWith('entrynodeid') ||
    m.includes('cycle') ||
    m.includes('unreachable') ||
    m.includes('entry node') ||
    m.includes('inbound edge') ||
    m.includes('ancestor') ||
    m.includes('artifact') ||
    p.includes('outputs') ||
    p.includes('inputs')
  ) {
    return 'flow';
  }
  if (p.includes('gate') || m.includes('gate') || m.includes('finding')) {
    return 'gates';
  }
  if (p.includes('policy') || m.includes('policy')) {
    return 'policy';
  }
  return 'configuration';
}

export function analyzeWorkflowValidation(
  definition: WorkflowDefinition,
  feedback: BucketedFeedback | undefined
): WorkflowValidationReport {
  const errors = feedback?.errors ?? [];
  const warnings = feedback?.warnings ?? [];
  const valid = feedback?.valid ?? false;
  const entryNode = definition.nodes.find(n => n.id === definition.entryNodeId);

  const resolveTarget = (path: string): { targetNodeId?: string; targetNodeName?: string } => {
    const match = NODE_PATH.exec(path);
    if (match) {
      const node = definition.nodes[Number(match[1])];
      if (node) return { targetNodeId: node.id, targetNodeName: node.name };
    }
    return {};
  };

  const enrichedErrors = errors.map(e => ({
    ...e,
    ...resolveTarget(e.path),
    category: categorizeWorkflowIssue(e)
  }));

  const enrichedWarnings = warnings.map(w => ({
    ...w,
    ...resolveTarget(w.path),
    category: categorizeWorkflowIssue(w)
  }));

  const filterCat = (cat: ValidationCategoryKind) => ({
    errors: enrichedErrors.filter(e => e.category === cat),
    warnings: enrichedWarnings.filter(w => w.category === cat)
  });

  const conn = filterCat('connections');
  const flow = filterCat('flow');
  const config = filterCat('configuration');
  const gates = filterCat('gates');
  const policy = filterCat('policy');

  const categories: WorkflowValidationCategory[] = [
    {
      kind: 'connections',
      title: 'Connections & Edges',
      valid: conn.errors.length === 0,
      errors: conn.errors,
      warnings: conn.warnings,
      summary: conn.errors.length === 0
        ? `All ${definition.edges.length} connection${definition.edges.length === 1 ? '' : 's'} are properly linked and valid.`
        : `${conn.errors.length} connection issue${conn.errors.length === 1 ? '' : 's'} found.`
    },
    {
      kind: 'flow',
      title: 'Flow & Topology',
      valid: flow.errors.length === 0,
      errors: flow.errors,
      warnings: flow.warnings,
      summary: flow.errors.length === 0
        ? `Entry stage "${entryNode?.name ?? definition.entryNodeId}" is set, graph is acyclic, and all stages are reachable.`
        : `${flow.errors.length} flow / reachability issue${flow.errors.length === 1 ? '' : 's'} found.`
    },
    {
      kind: 'configuration',
      title: 'Stage Configuration',
      valid: config.errors.length === 0,
      errors: config.errors,
      warnings: config.warnings,
      summary: config.errors.length === 0
        ? `All ${definition.nodes.length} stage${definition.nodes.length === 1 ? '' : 's'} have valid parameters, profiles, and commands.`
        : `${config.errors.length} stage configuration issue${config.errors.length === 1 ? '' : 's'} found.`
    },
    {
      kind: 'gates',
      title: 'Gates & Policies',
      valid: gates.errors.length === 0 && policy.errors.length === 0,
      errors: [...gates.errors, ...policy.errors],
      warnings: [...gates.warnings, ...policy.warnings],
      summary: gates.errors.length === 0 && policy.errors.length === 0
        ? 'Quality gates, security requirements, and delivery policies are satisfied.'
        : `${gates.errors.length + policy.errors.length} gate / policy issue${gates.errors.length + policy.errors.length === 1 ? '' : 's'} found.`
    }
  ];

  return {
    valid,
    totalStages: definition.nodes.length,
    totalConnections: definition.edges.length,
    entryNodeId: definition.entryNodeId,
    entryNodeName: entryNode?.name,
    categories,
    allErrors: enrichedErrors,
    allWarnings: enrichedWarnings
  };
}
