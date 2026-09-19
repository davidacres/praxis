/**
 * Workflow normalization, validation, and migration (FX-BE-018 / TASK-093).
 *
 * Everything here fails closed. A definition that cannot be proven safe is
 * rejected rather than repaired into something that merely runs, because the
 * cost of a workflow that silently drops a security gate is far higher than the
 * cost of refusing to save it.
 *
 * Errors carry a JSON-ish `path` (`nodes[2].outputs[0].id`) so the designer can
 * put the message on the offending field instead of in a banner.
 */

import type { AgentToolMode } from '../ai/agentTypes';
import {
  WORKFLOW_SCHEMA_VERSION,
  isAgentTaskNode,
  isApprovalNode,
  isCheckNode,
  isDeploymentNode,
  isJoinNode,
  nodeGate,
  nodeOutputs,
  type WorkflowArtifactContract,
  type WorkflowArtifactKind,
  type WorkflowCapabilityRequirement,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowEdgeOutcome,
  type WorkflowGateKind,
  type WorkflowNode,
  type WorkflowPolicyProfile,
  type WorkflowScope
} from './workflowTypes';

export interface WorkflowIssue {
  /** Path to the offending field, e.g. `nodes[2].agent.agentId`. */
  path: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowIssue[];
  /** Non-blocking observations — unreachable advisory branches, drift, etc. */
  warnings: WorkflowIssue[];
}

export interface WorkflowMigrationResult {
  /** Absent when the payload could not be read as a workflow at all. */
  definition?: WorkflowDefinition;
  /** True when the payload was written against an older schema version. */
  migrated: boolean;
  errors: WorkflowIssue[];
}

const NODE_TYPES = new Set(['agent-task', 'check', 'deployment', 'approval', 'join']);
const EDGE_OUTCOMES = new Set<WorkflowEdgeOutcome>(['success', 'failure', 'always']);
const GATE_KINDS = new Set<WorkflowGateKind>(['review', 'qa', 'security']);
const ARTIFACT_KINDS = new Set<WorkflowArtifactKind>(['plan', 'diff', 'report', 'test-results', 'log', 'note', 'findings']);
const TOOL_MODES = new Set(['read-only', 'full', 'project-only']);
const SCOPES = new Set<WorkflowScope>(['global', 'project']);

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// ── Migration ────────────────────────────────────────────────────────────

/**
 * Lifts a stored payload to the current schema version.
 *
 * There is only one version today, so this is a guard rather than a ladder —
 * but it is shaped as a ladder on purpose: adding v2 means adding one step and
 * one test, not restructuring every caller.
 */
export function migrateWorkflow(value: unknown): WorkflowMigrationResult {
  if (!isObject(value)) {
    return { migrated: false, errors: [{ path: '', message: 'Workflow must be a JSON object.' }] };
  }

  const rawVersion = value.schemaVersion;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    return {
      migrated: false,
      errors: [{ path: 'schemaVersion', message: 'schemaVersion must be a positive integer.' }]
    };
  }

  if (rawVersion > WORKFLOW_SCHEMA_VERSION) {
    return {
      migrated: false,
      errors: [
        {
          path: 'schemaVersion',
          message: `Workflow was written by a newer app (schema ${rawVersion}; this build supports ${WORKFLOW_SCHEMA_VERSION}).`
        }
      ]
    };
  }

  // Future versions insert their lift steps here, oldest first.
  const definition = normalizeWorkflow({ ...value, schemaVersion: WORKFLOW_SCHEMA_VERSION });
  return { definition, migrated: rawVersion < WORKFLOW_SCHEMA_VERSION, errors: [] };
}

// ── Normalization ────────────────────────────────────────────────────────

/**
 * Fills defaults and coerces shape so validation can read plain fields without
 * defending against `undefined` at every step.
 *
 * Normalization never invents identity — a missing id stays missing so that
 * validation can report it — and never drops a field it does not understand
 * being absent; it only supplies documented defaults.
 */
export function normalizeWorkflow(value: unknown): WorkflowDefinition {
  const raw = isObject(value) ? value : {};
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(normalizeNode) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.map(normalizeEdge) : [];

  const definition: WorkflowDefinition = {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : WORKFLOW_SCHEMA_VERSION,
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    scope: raw.scope === 'project' ? 'project' : 'global',
    version: typeof raw.version === 'number' && raw.version >= 1 ? Math.floor(raw.version) : 1,
    nodes,
    edges,
    entryNodeId: typeof raw.entryNodeId === 'string' ? raw.entryNodeId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  };

  if (isText(raw.description)) definition.description = raw.description;
  if (raw.trigger === 'ticket' || raw.trigger === 'on-demand') definition.trigger = raw.trigger;
  if (isText(raw.projectId)) definition.projectId = raw.projectId;
  if (raw.builtIn === true) definition.builtIn = true;

  return definition;
}

function normalizeNode(value: unknown): WorkflowNode {
  const raw = isObject(value) ? value : {};
  const base = {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    x: typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0,
    y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : 0,
    inputs: Array.isArray(raw.inputs) ? raw.inputs.filter((item): item is string => typeof item === 'string') : [],
    ...(raw.enabled === false ? { enabled: false } : {})
  };

  switch (raw.type) {
    case 'agent-task': {
      const agentRaw = isObject(raw.agent) ? raw.agent : {};
      const node: WorkflowNode = {
        ...base,
        type: 'agent-task',
        agent: {
          agentId: typeof agentRaw.agentId === 'string' ? agentRaw.agentId : typeof agentRaw.hostId === 'string' ? agentRaw.hostId : '',
          ...(typeof agentRaw.profileId === 'string' ? { profileId: agentRaw.profileId } : {}),
          ...(typeof agentRaw.hostId === 'string' ? { hostId: agentRaw.hostId } : {}),
          ...(typeof agentRaw.providerId === 'string' ? { providerId: agentRaw.providerId } : {}),
          scope: agentRaw.scope === 'project' ? 'project' : 'global',
          // Defaults to the narrowest mode: an unreadable value must never
          // grant a stage more tool access than it was authored with.
          toolMode: TOOL_MODES.has(agentRaw.toolMode as string) ? (agentRaw.toolMode as AgentToolMode) : 'read-only',
          ...(Array.isArray(agentRaw.skillNames)
            ? { skillNames: agentRaw.skillNames.filter((item): item is string => typeof item === 'string') }
            : {}),
          ...(isObject(agentRaw.skillFingerprints)
            ? { skillFingerprints: agentRaw.skillFingerprints as Record<string, string> }
            : {}),
          ...(isObject(agentRaw.requiredCapabilities)
            ? { requiredCapabilities: agentRaw.requiredCapabilities as WorkflowCapabilityRequirement }
            : {})
        },
        instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
        outputs: Array.isArray(raw.outputs) ? raw.outputs.map(normalizeArtifact) : [],
        // Absent means mutating: assuming a stage is read-only when it is not
        // would let the scheduler run two writers against one worktree.
        mutatesWorktree: raw.mutatesWorktree !== false
      };
      if (isText(raw.workflowPackId)) node.workflowPackId = raw.workflowPackId;
      if (GATE_KINDS.has(raw.satisfiesGate as WorkflowGateKind)) node.satisfiesGate = raw.satisfiesGate as WorkflowGateKind;
      if (typeof raw.timeoutMs === 'number') node.timeoutMs = raw.timeoutMs;
      if (typeof raw.maxAttempts === 'number') node.maxAttempts = raw.maxAttempts;
      return node;
    }
    case 'check': {
      const node: WorkflowNode = {
        ...base,
        type: 'check',
        command: typeof raw.command === 'string' ? raw.command : '',
        outputs: Array.isArray(raw.outputs) ? raw.outputs.map(normalizeArtifact) : [],
        successExitCodes: Array.isArray(raw.successExitCodes)
          ? raw.successExitCodes.filter((item): item is number => typeof item === 'number')
          : [0]
      };
      if (Array.isArray(raw.args)) node.args = raw.args.filter((item): item is string => typeof item === 'string');
      if (raw.mutatesWorktree === true) node.mutatesWorktree = true;
      if (GATE_KINDS.has(raw.satisfiesGate as WorkflowGateKind)) node.satisfiesGate = raw.satisfiesGate as WorkflowGateKind;
      if (typeof raw.timeoutMs === 'number') node.timeoutMs = raw.timeoutMs;
      if (typeof raw.maxAttempts === 'number') node.maxAttempts = raw.maxAttempts;
      return node;
    }
    case 'deployment': {
      const node: WorkflowNode = {
        ...base,
        type: 'deployment',
        deploymentProfileId: typeof raw.deploymentProfileId === 'string' ? raw.deploymentProfileId : '',
        outputs: Array.isArray(raw.outputs) ? raw.outputs.map(normalizeArtifact) : []
      };
      if (GATE_KINDS.has(raw.satisfiesGate as WorkflowGateKind)) node.satisfiesGate = raw.satisfiesGate as WorkflowGateKind;
      if (typeof raw.timeoutMs === 'number') node.timeoutMs = raw.timeoutMs;
      if (typeof raw.maxAttempts === 'number') node.maxAttempts = raw.maxAttempts;
      return node;
    }
    case 'approval':
      return {
        ...base,
        type: 'approval',
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        requiredGates: Array.isArray(raw.requiredGates)
          ? raw.requiredGates.filter((item): item is WorkflowGateKind => GATE_KINDS.has(item as WorkflowGateKind))
          : [],
        // Bypass is opt-in: an unreadable flag must not widen what an
        // approver is allowed to override.
        allowBypass: raw.allowBypass === true
      };
    case 'join':
      return { ...base, type: 'join', mode: raw.mode === 'all-required' ? 'all-required' : 'all' };
    default:
      // Preserve the unusable node so validation can name it rather than
      // silently shrinking the graph under the author's feet.
      return { ...base, type: (raw.type as 'join') ?? 'join', mode: 'all' };
  }
}

function normalizeArtifact(value: unknown): WorkflowArtifactContract {
  const raw = isObject(value) ? value : {};
  const artifact: WorkflowArtifactContract = {
    id: typeof raw.id === 'string' ? raw.id : '',
    kind: ARTIFACT_KINDS.has(raw.kind as WorkflowArtifactKind) ? (raw.kind as WorkflowArtifactKind) : 'note',
    required: raw.required !== false
  };
  if (isText(raw.description)) artifact.description = raw.description;
  return artifact;
}

function normalizeEdge(value: unknown): WorkflowEdge {
  const raw = isObject(value) ? value : {};
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    on: EDGE_OUTCOMES.has(raw.on as WorkflowEdgeOutcome) ? (raw.on as WorkflowEdgeOutcome) : 'success',
    required: raw.required !== false
  };
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validates a normalized definition. Pass a policy to additionally enforce the
 * project's rules; without one, only structural safety is checked.
 */
export function validateWorkflow(
  definition: WorkflowDefinition,
  policy?: WorkflowPolicyProfile
): WorkflowValidationResult {
  const errors: WorkflowIssue[] = [];
  const warnings: WorkflowIssue[] = [];

  validateHeader(definition, errors);
  const nodesById = validateNodes(definition, errors);
  validateEdges(definition, nodesById, errors);
  validateEntryAndShape(definition, nodesById, errors, warnings);
  validateArtifacts(definition, errors);
  validateGates(definition, errors);
  if (policy) validatePolicy(definition, policy, errors);

  return { valid: errors.length === 0, errors, warnings };
}

function validateHeader(definition: WorkflowDefinition, errors: WorkflowIssue[]): void {
  if (definition.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    errors.push({ path: 'schemaVersion', message: `Expected schema ${WORKFLOW_SCHEMA_VERSION}.` });
  }
  if (!isText(definition.id)) errors.push({ path: 'id', message: 'id is required.' });
  if (!isText(definition.name)) errors.push({ path: 'name', message: 'name is required.' });
  if (!SCOPES.has(definition.scope)) errors.push({ path: 'scope', message: 'scope must be global or project.' });
  if (definition.version < 1) errors.push({ path: 'version', message: 'version must be 1 or greater.' });

  // Scope and ownership must agree, or the store cannot decide precedence.
  if (definition.scope === 'project' && !isText(definition.projectId)) {
    errors.push({ path: 'projectId', message: 'A project-scoped workflow requires projectId.' });
  }
  if (definition.scope === 'global' && isText(definition.projectId)) {
    errors.push({ path: 'projectId', message: 'A global workflow must not carry projectId.' });
  }
}

function validateNodes(definition: WorkflowDefinition, errors: WorkflowIssue[]): Map<string, WorkflowNode> {
  const nodesById = new Map<string, WorkflowNode>();

  if (definition.nodes.length === 0) {
    errors.push({ path: 'nodes', message: 'A workflow needs at least one node.' });
  }

  definition.nodes.forEach((node, index) => {
    const at = `nodes[${index}]`;
    if (!isText(node.id)) errors.push({ path: `${at}.id`, message: 'Node id is required.' });
    else if (nodesById.has(node.id)) errors.push({ path: `${at}.id`, message: `Duplicate node id: ${node.id}` });
    else nodesById.set(node.id, node);

    if (!isText(node.name)) errors.push({ path: `${at}.name`, message: 'Node name is required.' });
    if (!NODE_TYPES.has(node.type)) {
      errors.push({ path: `${at}.type`, message: `Unsupported node type: ${String(node.type)}` });
      return;
    }

    if (isAgentTaskNode(node)) validateAgentTaskNode(node, at, errors);
    if (isCheckNode(node)) validateCheckNode(node, at, errors);
    if (isDeploymentNode(node)) validateDeploymentNode(node, at, errors);
    if (isApprovalNode(node) && !isText(node.prompt)) {
      errors.push({ path: `${at}.prompt`, message: 'An approval node needs a prompt.' });
    }
    validateNodeOutputs(node, at, errors);
  });

  return nodesById;
}

function validateAgentTaskNode(
  node: Extract<WorkflowNode, { type: 'agent-task' }>,
  at: string,
  errors: WorkflowIssue[]
): void {
  if (!isText(node.agent.agentId)) {
    errors.push({ path: `${at}.agent.agentId`, message: 'An agent stage must name an Agent Hub agent id.' });
  }
  if (!SCOPES.has(node.agent.scope)) {
    errors.push({ path: `${at}.agent.scope`, message: 'Agent scope must be global or project.' });
  }
  if (!TOOL_MODES.has(node.agent.toolMode)) {
    errors.push({ path: `${at}.agent.toolMode`, message: 'toolMode must be read-only, project-only, or full.' });
  }
  if (!isText(node.instructions)) {
    errors.push({ path: `${at}.instructions`, message: 'An agent stage needs instructions.' });
  }

  // A stage that declares it will not touch the worktree must not hold write
  // tools. Otherwise the scheduler's read-only fan-out would let several
  // "read-only" agents write to one tree in parallel.
  if (!node.mutatesWorktree && node.agent.toolMode === 'full') {
    errors.push({
      path: `${at}.agent.toolMode`,
      message: 'A non-mutating stage cannot request full tool mode; use read-only or project-only.'
    });
  }

  // A pinned fingerprint that names no requested skill is dead configuration
  // and, worse, reads as protection that is not there.
  for (const name of Object.keys(node.agent.skillFingerprints ?? {})) {
    if (!(node.agent.skillNames ?? []).includes(name)) {
      errors.push({
        path: `${at}.agent.skillFingerprints.${name}`,
        message: `Fingerprint pins skill "${name}", which the stage does not request.`
      });
    }
  }

  if (node.maxAttempts !== undefined && node.maxAttempts < 1) {
    errors.push({ path: `${at}.maxAttempts`, message: 'maxAttempts must be 1 or greater.' });
  }
  if (node.timeoutMs !== undefined && node.timeoutMs <= 0) {
    errors.push({ path: `${at}.timeoutMs`, message: 'timeoutMs must be greater than zero.' });
  }
}

function validateCheckNode(
  node: Extract<WorkflowNode, { type: 'check' }>,
  at: string,
  errors: WorkflowIssue[]
): void {
  if (!isText(node.command)) {
    errors.push({ path: `${at}.command`, message: 'A check node needs a command.' });
  }
  if (node.successExitCodes && node.successExitCodes.length === 0) {
    errors.push({ path: `${at}.successExitCodes`, message: 'successExitCodes cannot be empty; omit it to default to [0].' });
  }
  if (node.maxAttempts !== undefined && node.maxAttempts < 1) {
    errors.push({ path: `${at}.maxAttempts`, message: 'maxAttempts must be 1 or greater.' });
  }
  if (node.timeoutMs !== undefined && node.timeoutMs <= 0) {
    errors.push({ path: `${at}.timeoutMs`, message: 'timeoutMs must be greater than zero.' });
  }
}

function validateDeploymentNode(
  node: Extract<WorkflowNode, { type: 'deployment' }>,
  at: string,
  errors: WorkflowIssue[]
): void {
  if (!isText(node.deploymentProfileId)) {
    errors.push({ path: `${at}.deploymentProfileId`, message: 'A deployment stage must name a deployment profile id.' });
  }
  if (node.maxAttempts !== undefined && node.maxAttempts < 1) {
    errors.push({ path: `${at}.maxAttempts`, message: 'maxAttempts must be 1 or greater.' });
  }
  if (node.timeoutMs !== undefined && node.timeoutMs <= 0) {
    errors.push({ path: `${at}.timeoutMs`, message: 'timeoutMs must be greater than zero.' });
  }
}

function validateNodeOutputs(node: WorkflowNode, at: string, errors: WorkflowIssue[]): void {
  const seen = new Set<string>();
  nodeOutputs(node).forEach((artifact, index) => {
    const path = `${at}.outputs[${index}]`;
    if (!isText(artifact.id)) errors.push({ path: `${path}.id`, message: 'Artifact id is required.' });
    else if (seen.has(artifact.id)) errors.push({ path: `${path}.id`, message: `Duplicate artifact id on node: ${artifact.id}` });
    else seen.add(artifact.id);
    if (!ARTIFACT_KINDS.has(artifact.kind)) {
      errors.push({ path: `${path}.kind`, message: `Unsupported artifact kind: ${String(artifact.kind)}` });
    }
  });
}

function validateEdges(
  definition: WorkflowDefinition,
  nodesById: Map<string, WorkflowNode>,
  errors: WorkflowIssue[]
): void {
  const seen = new Set<string>();
  definition.edges.forEach((edge, index) => {
    const at = `edges[${index}]`;
    if (!isText(edge.id)) errors.push({ path: `${at}.id`, message: 'Edge id is required.' });
    else if (seen.has(edge.id)) errors.push({ path: `${at}.id`, message: `Duplicate edge id: ${edge.id}` });
    else seen.add(edge.id);

    if (!nodesById.has(edge.from)) {
      errors.push({ path: `${at}.from`, message: `Edge references unknown node: ${edge.from || '(empty)'}` });
    }
    if (!nodesById.has(edge.to)) {
      errors.push({ path: `${at}.to`, message: `Edge references unknown node: ${edge.to || '(empty)'}` });
    }
    if (edge.from && edge.from === edge.to) {
      errors.push({ path: `${at}.to`, message: 'An edge cannot loop a node to itself.' });
    }
    if (!EDGE_OUTCOMES.has(edge.on)) {
      errors.push({ path: `${at}.on`, message: 'Edge outcome must be success, failure, or always.' });
    }
  });

  definition.nodes.forEach((node, index) => {
    const inbound = definition.edges.filter(edge => edge.to === node.id);

    if (isJoinNode(node)) {
      // A join that waits on one branch is a no-op the author almost certainly
      // did not mean, and `all-required` with nothing required never releases.
      if (inbound.length < 2) {
        errors.push({ path: `nodes[${index}]`, message: `Join "${node.id}" needs at least two inbound edges.` });
      }
      if (node.mode === 'all-required' && !inbound.some(edge => edge.required)) {
        errors.push({
          path: `nodes[${index}].mode`,
          message: `Join "${node.id}" is all-required but no inbound edge is required; it would never release.`
        });
      }
      return;
    }

    // A join is the only node that may wait on several branches: anything else
    // with two *concurrent* parents would race their artifact inputs.
    //
    // Concurrency is what matters, not edge count. Several edges from one
    // source node are mutually exclusive outcomes — `success` and `failure`
    // both routing to a cleanup stage is a normal shape, and only ever one of
    // them fires — so parents are counted by distinct source node.
    const sources = new Set(inbound.map(edge => edge.from));
    if (sources.size > 1) {
      errors.push({
        path: `nodes[${index}]`,
        message: `Node "${node.id}" has ${sources.size} concurrent parents (${[...sources].sort().join(', ')}); converge them through a join node.`
      });
    }
  });
}

function validateEntryAndShape(
  definition: WorkflowDefinition,
  nodesById: Map<string, WorkflowNode>,
  errors: WorkflowIssue[],
  warnings: WorkflowIssue[]
): void {
  if (!isText(definition.entryNodeId)) {
    errors.push({ path: 'entryNodeId', message: 'entryNodeId is required.' });
    return;
  }
  if (!nodesById.has(definition.entryNodeId)) {
    errors.push({ path: 'entryNodeId', message: `entryNodeId references unknown node: ${definition.entryNodeId}` });
    return;
  }
  if (definition.edges.some(edge => edge.to === definition.entryNodeId)) {
    errors.push({ path: 'entryNodeId', message: 'The entry node cannot have inbound edges.' });
  }

  const cycle = findCycle(definition, nodesById);
  if (cycle) {
    errors.push({ path: 'edges', message: `Workflow contains a cycle: ${cycle.join(' → ')}` });
    return; // Reachability on a cyclic graph reports noise, not signal.
  }

  const reachable = reachableFrom(definition, definition.entryNodeId);
  for (const [id] of nodesById) {
    if (reachable.has(id)) continue;
    const index = definition.nodes.findIndex(node => node.id === id);
    errors.push({ path: `nodes[${index}]`, message: `Node "${id}" is unreachable from the entry node.` });
  }

  // Terminal advisory branches are legal but usually an oversight, so they
  // surface as a warning the designer can show without blocking a save.
  for (const [id, node] of nodesById) {
    if (isApprovalNode(node)) continue;
    if (definition.edges.some(edge => edge.from === id)) continue;
    if (!reachable.has(id)) continue;
    warnings.push({ path: `nodes[${definition.nodes.findIndex(n => n.id === id)}]`, message: `Node "${id}" has no outbound edges; the run ends here.` });
  }
}

/** Returns the node ids forming the first cycle found, or undefined. */
function findCycle(definition: WorkflowDefinition, nodesById: Map<string, WorkflowNode>): string[] | undefined {
  const outbound = new Map<string, string[]>();
  for (const edge of definition.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge.to]);
  }

  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const walk = (id: string): string[] | undefined => {
    visited.add(id);
    stack.push(id);
    onStack.add(id);
    for (const next of outbound.get(id) ?? []) {
      if (onStack.has(next)) return [...stack.slice(stack.indexOf(next)), next];
      if (!visited.has(next)) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    onStack.delete(id);
    return undefined;
  };

  for (const [id] of nodesById) {
    if (visited.has(id)) continue;
    const found = walk(id);
    if (found) return found;
  }
  return undefined;
}

function reachableFrom(definition: WorkflowDefinition, entryNodeId: string): Set<string> {
  const outbound = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge.to]);
  }
  const reachable = new Set<string>();
  const queue = [entryNodeId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(outbound.get(id) ?? []));
  }
  return reachable;
}

/** Node ids that can run before `nodeId`, following edges backwards. */
function ancestorsOf(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const inbound = new Map<string, string[]>();
  for (const edge of definition.edges) {
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set<string>();
  const queue = [...(inbound.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(inbound.get(id) ?? []));
  }
  return seen;
}

function validateArtifacts(definition: WorkflowDefinition, errors: WorkflowIssue[]): void {
  // Artifact ids are workflow-global so an input can name one without also
  // naming the node that produced it.
  const producedBy = new Map<string, string>();
  for (const node of definition.nodes) {
    for (const artifact of nodeOutputs(node)) {
      if (!isText(artifact.id)) continue;
      const owner = producedBy.get(artifact.id);
      if (owner && owner !== node.id) {
        const index = definition.nodes.indexOf(node);
        errors.push({
          path: `nodes[${index}].outputs`,
          message: `Artifact "${artifact.id}" is already produced by node "${owner}".`
        });
        continue;
      }
      producedBy.set(artifact.id, node.id);
    }
  }

  definition.nodes.forEach((node, index) => {
    if (node.inputs.length === 0) return;
    const ancestors = ancestorsOf(definition, node.id);
    node.inputs.forEach((input, inputIndex) => {
      const path = `nodes[${index}].inputs[${inputIndex}]`;
      const owner = producedBy.get(input);
      if (!owner) {
        errors.push({ path, message: `Input "${input}" is not produced by any node.` });
        return;
      }
      if (owner === node.id) {
        errors.push({ path, message: `Node "${node.id}" cannot consume its own output "${input}".` });
        return;
      }
      // Consuming an artifact from a node that cannot have run yet is the
      // failure that turns into an empty file at run time.
      if (!ancestors.has(owner)) {
        errors.push({
          path,
          message: `Input "${input}" comes from node "${owner}", which is not upstream of "${node.id}".`
        });
      }
    });
  });

}

function validateGates(definition: WorkflowDefinition, errors: WorkflowIssue[]): void {
  definition.nodes.forEach((node, index) => {
    if (!isApprovalNode(node)) return;
    if (node.requiredGates.length === 0) return;

    const ancestors = ancestorsOf(definition, node.id);
    const satisfied = new Set<WorkflowGateKind>();
    for (const id of ancestors) {
      const gate = nodeGate(definition.nodes.find(candidate => candidate.id === id) as WorkflowNode);
      if (gate) satisfied.add(gate);
    }

    node.requiredGates.forEach((gate, gateIndex) => {
      if (satisfied.has(gate)) return;
      errors.push({
        path: `nodes[${index}].requiredGates[${gateIndex}]`,
        message: `No upstream node satisfies the required "${gate}" gate.`
      });
    });

    if (node.gateThresholds) {
      for (const gate of Object.keys(node.gateThresholds) as WorkflowGateKind[]) {
        const owners = definition.nodes.filter(n => nodeGate(n) === gate);
        for (const owner of owners) {
          const hasFindings = nodeOutputs(owner).some(o => o.kind === 'findings');
          if (!hasFindings) {
            errors.push({
              path: `nodes[${index}].gateThresholds.${gate}`,
              message: `Gate "${gate}" has a threshold but its stage "${owner.name}" does not produce findings.`
            });
          }
        }
      }
    }
  });
}

function validatePolicy(
  definition: WorkflowDefinition,
  policy: WorkflowPolicyProfile,
  errors: WorkflowIssue[]
): void {
  const approvals = definition.nodes.filter(isApprovalNode);

  if (policy.requireHumanApproval && approvals.length === 0) {
    errors.push({
      path: 'nodes',
      message: `Policy "${policy.name}" requires a human approval stage, but this workflow has none.`
    });
  }

  // Policy gates are additive: the definition may ask for more, never fewer.
  const satisfiedAnywhere = new Set<WorkflowGateKind>();
  for (const node of definition.nodes) {
    const gate = nodeGate(node);
    if (gate) satisfiedAnywhere.add(gate);
  }
  policy.requiredGates.forEach((gate, index) => {
    if (satisfiedAnywhere.has(gate)) return;
    errors.push({
      path: `policy.requiredGates[${index}]`,
      message: `Policy "${policy.name}" requires a "${gate}" gate, which no node in this workflow satisfies.`
    });
  });

  if (policy.gateThresholds) {
    for (const gate of Object.keys(policy.gateThresholds) as WorkflowGateKind[]) {
      const owner = definition.nodes.find(n => nodeGate(n) === gate);
      if (owner) {
        const hasFindings = nodeOutputs(owner).some(o => o.kind === 'findings');
        if (!hasFindings) {
          errors.push({
            path: `policy.gateThresholds.${gate}`,
            message: `Gate "${gate}" has a threshold but its stage "${owner.name}" does not produce findings.`
          });
        }
      }
    }
  }

  approvals.forEach(node => {
    const index = definition.nodes.indexOf(node);
    if (!policy.allowGateBypass && node.allowBypass) {
      errors.push({
        path: `nodes[${index}].allowBypass`,
        message: `Policy "${policy.name}" forbids gate bypass.`
      });
    }
    for (const gate of policy.requiredGates) {
      if (node.requiredGates.includes(gate)) continue;
      errors.push({
        path: `nodes[${index}].requiredGates`,
        message: `Policy "${policy.name}" requires approval to wait on the "${gate}" gate.`
      });
    }
  });

  definition.nodes.forEach((node, index) => {
    const maxAttempts =
      isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) ? node.maxAttempts : undefined;
    if (maxAttempts !== undefined && maxAttempts > policy.maxAttemptsPerNode) {
      errors.push({
        path: `nodes[${index}].maxAttempts`,
        message: `Policy "${policy.name}" caps attempts at ${policy.maxAttemptsPerNode}.`
      });
    }
  });
}
