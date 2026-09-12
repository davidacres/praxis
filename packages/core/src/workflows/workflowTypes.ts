/**
 * Governed delivery workflow contracts (FX-BE-018 / TASK-092).
 *
 * A workflow is a validated DAG of stages that a project runs to deliver one
 * unit of work: agents implement, deterministic checks verify, and a human
 * approves — with every transition and artifact recorded.
 *
 * Three neighbouring models use the word "workflow"; this is none of them:
 *
 * - `AgentWorkflowReference` (`ai/agentTypes`) is a **markdown instruction
 *   pack** matched to an issue. A workflow node may carry one, but a pack is
 *   guidance for an agent, not a graph.
 * - `ProjectWorkflowStage` (`projects/projectTypes`) is a **board column**.
 *   Board lifecycle is where work sits; a workflow is how it gets there.
 * - `TaskDesignerCanvasNode` (`taskDesigner/taskDesignerState`) is a **ticket
 *   graph** for planning. It shares an interaction language with the workflow
 *   designer but nothing else — deliberately kept as separate types so the
 *   canvas can evolve without dragging execution semantics along.
 *
 * Agents are referenced by stable Agent Hub id only. A definition never embeds
 * an executable manifest: what a node may run is resolved at preflight against
 * the discovered, trusted catalog, so revoking trust takes effect immediately
 * rather than being frozen into a saved workflow.
 */

import { createHash } from 'node:crypto';
import type { AgentToolMode } from '../ai/agentTypes';
import type { FindingWaiver } from './waiverRegister';

/** Bumped only for a breaking shape change; `migrateWorkflow` handles the lift. */
export const WORKFLOW_SCHEMA_VERSION = 1;

/**
 * Where a definition, policy, or agent lives. `project` shadows `global` by id,
 * and the store reports the shadowing rather than resolving it silently.
 */
export type WorkflowScope = 'global' | 'project';

// ── Agent binding ────────────────────────────────────────────────────────

/**
 * Capabilities a stage needs from whichever host ends up backing its agent.
 * Only the requirements a workflow actually cares about are set; an unset flag
 * means "don't care", never "must be false".
 */
export interface WorkflowCapabilityRequirement {
  supportsSkills?: boolean;
  supportsTools?: boolean;
  supportsMemory?: boolean;
  supportsResume?: boolean;
  supportsStreaming?: boolean;
}

/**
 * A stage's agent, by identity rather than by value.
 *
 * `skillFingerprints` pins the SKILL.md content hash a workflow was authored
 * against. Preflight compares it to what is on disk, so an edited skill surfaces
 * as an explicit drift decision instead of quietly changing what a stage does.
 */
export interface WorkflowAgentRef {
  /** `AgentManifest.id` from the Agent Hub catalog. */
  agentId: string;
  /** Which catalog the agent must resolve from. */
  scope: WorkflowScope;
  /** `SkillMetadata.name` values to activate for the stage. */
  skillNames?: string[];
  /** Skill name → `DiscoveredSkill.fingerprint` captured at author time. */
  skillFingerprints?: Record<string, string>;
  requiredCapabilities?: WorkflowCapabilityRequirement;
  /** Enforced at session creation; a stage may narrow but never widen this. */
  toolMode: AgentToolMode;
}

// ── Artifacts ────────────────────────────────────────────────────────────

/**
 * What a stage hands to the next one. Kinds are closed so a reviewer stage can
 * demand a `diff` and be certain it is getting one.
 */
export type WorkflowArtifactKind =
  | 'plan'
  | 'diff'
  | 'report'
  | 'test-results'
  | 'log'
  | 'note'
  | 'findings';

// ── Findings & Metrics ───────────────────────────────────────────────────

export type CheckFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CheckFinding {
  fingerprint: string;
  ruleId?: string;
  file?: string;
  line?: number;
  severity: CheckFindingSeverity;
  category: string;
  message: string;
  suggestion?: string;
}

export interface CheckFindings {
  findings: CheckFinding[];
  metrics: Record<string, number>;
}

/**
 * Computes a deterministic fingerprint over rule id, normalized file path, line number, and message.
 * The same underlying issue keeps its id across runs; changing location or message changes the fingerprint.
 */
export function computeFindingFingerprint(
  finding: Pick<CheckFinding, 'ruleId' | 'file' | 'line' | 'message'>
): string {
  const normFile = (finding.file ?? '').replace(/\\/g, '/').trim();
  const ruleId = (finding.ruleId ?? '').trim();
  const line = finding.line !== undefined ? String(finding.line) : '';
  const message = (finding.message ?? '').trim();

  const payload = `${ruleId}::${normFile}::${line}::${message}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── Gate Thresholds ──────────────────────────────────────────────────────

export interface MetricThresholdCondition {
  type: 'metric';
  metric: string;
  operator: '>=' | '<=' | '>' | '<' | '==';
  value: number;
}

export interface SeverityThresholdCondition {
  type: 'severity';
  severityLevel?: CheckFindingSeverity;
  maxCount: number;
}

export type GateThresholdCondition = MetricThresholdCondition | SeverityThresholdCondition;

export type CheckResultAdapterKind =
  | 'sarif'
  | 'junit'
  | 'lcov'
  | 'cobertura'
  | 'npm-audit'
  | 'osv-scanner';

/** A declared output slot on a node. Presence is checked; content is not. */
export interface WorkflowArtifactContract {
  /** Unique within its workflow — this is what downstream `inputs` name. */
  id: string;
  kind: WorkflowArtifactKind;
  /** A missing required artifact fails the node; an optional one does not. */
  required: boolean;
  description?: string;
  /** Optional named adapter for check results */
  adapter?: CheckResultAdapterKind;
}

// ── Gates ────────────────────────────────────────────────────────────────

/**
 * The evidence classes a policy can insist on. A node declares which one it
 * satisfies; approval cannot proceed until every policy-required gate has a
 * passing node behind it. This is what stops "review passed" being prose.
 */
export type WorkflowGateKind = 'review' | 'qa' | 'security';

// ── Nodes ────────────────────────────────────────────────────────────────

interface WorkflowNodeBase {
  id: string;
  name: string;
  /** Designer canvas position. Execution ignores these entirely. */
  x: number;
  y: number;
  /** Artifact contract ids this node consumes; each must exist upstream. */
  inputs: string[];
  /** Whether the node is enabled in execution. Defaults to true. */
  enabled?: boolean;
}

/** A stage run by an agent session through the Agent Hub/runtime boundary. */
export interface WorkflowAgentTaskNode extends WorkflowNodeBase {
  type: 'agent-task';
  agent: WorkflowAgentRef;
  /** The stage brief handed to the agent alongside its inputs. */
  instructions: string;
  outputs: WorkflowArtifactContract[];
  /** Optional markdown instruction pack, resolved from the workspace catalog. */
  workflowPackId?: string;
  /**
   * Whether the stage writes to the canonical implementation worktree. The
   * scheduler serialises every mutating node so two agents can never edit the
   * same tree concurrently; read-only stages are free to fan out.
   */
  mutatesWorktree: boolean;
  /** Set when this stage is the evidence behind a policy gate. */
  satisfiesGate?: WorkflowGateKind;
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * A deterministic command whose exit code decides the outcome. No model is
 * involved, which is exactly why a QA or security gate can rest on one.
 */
export interface WorkflowCheckNode extends WorkflowNodeBase {
  type: 'check';
  command: string;
  args?: string[];
  /** Defaults to `[0]` when absent. */
  successExitCodes?: number[];
  outputs: WorkflowArtifactContract[];
  /**
   * Whether the command writes to the worktree. Defaults to **false**: a check
   * verifies, and verification fanning out in parallel is the point of having
   * review, QA, and security as separate branches. An author flags a check that
   * genuinely writes — a build or a formatter — and the scheduler serialises it
   * with the other mutating stages.
   *
   * The opposite default to `WorkflowAgentTaskNode.mutatesWorktree`, because
   * the usual case is the opposite way round.
   */
  mutatesWorktree?: boolean;
  satisfiesGate?: WorkflowGateKind;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Named adapter to parse raw output into CheckFindings (for findings artifacts) */
  adapter?: CheckResultAdapterKind;
  /** Path to the output artifact file to parse, relative to cwd */
  reportPath?: string;
  /**
   * Observe mode for CI-provided evidence (FX-BE-091 / TASK-252).
   * When enabled, the gate evaluates against imported CI findings matching the run's snapshot SHA,
   * falling back to the local command if snapshot SHA does not match.
   */
  observe?: {
    enabled: boolean;
    provider?: 'github-actions' | 'gitlab-ci';
  };
}

/**
 * A stage that ships a previously built artifact through a `DeploymentProfile`
 * (`projects/deploymentProfile`), resolved by id the same way `WorkflowAgentRef`
 * resolves an agent — at run time against the project's store, never embedded,
 * so revoking or editing a profile takes effect immediately.
 *
 * The engine settles this node through the same `node-started`/`node-succeeded`/
 * `node-failed` commands every other node uses; it does not itself dispatch a
 * deployment or know what `DeploymentRun` is. What it adds is a `phase` a
 * caller may report mid-attempt via `node-progress` (`WorkflowRunCommand`) —
 * `'deploying'` then `'verifying'` — so the monitor can show those as distinct
 * states instead of one undifferentiated "running", without the run engine
 * itself needing to know deployment has two halves.
 */
export interface WorkflowDeploymentNode extends WorkflowNodeBase {
  type: 'deployment';
  /** `DeploymentProfile.id`, resolved against the project's deployment profile store. */
  deploymentProfileId: string;
  outputs: WorkflowArtifactContract[];
  /** Set when this stage is the evidence behind a policy gate — a passed health check is deterministic evidence, same standing as a check node. */
  satisfiesGate?: WorkflowGateKind;
  timeoutMs?: number;
  maxAttempts?: number;
}

/** A human decision. Always terminal for its branch until someone acts. */
export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: 'approval';
  prompt: string;
  /**
   * Gates that must be satisfied before the approve action is offered. The
   * policy profile can add to this set but never remove from it.
   */
  requiredGates: WorkflowGateKind[];
  /** Whether an approver may override a failing gate with a written reason. */
  allowBypass: boolean;
  /** Gate-level threshold conditions that must be met */
  gateThresholds?: Partial<Record<WorkflowGateKind, GateThresholdCondition[]>>;
  /** Optional active waivers applied to suppress matching findings */
  waivers?: FindingWaiver[];
}

/**
 * Converges parallel branches.
 *
 * `all` waits for every inbound edge. `all-required` waits only for edges
 * marked required and releases without them — so an advisory branch that is
 * slow or failing cannot block delivery, and equally cannot gate it. A branch
 * nobody waits for cannot also be a branch anybody depends on; if its result
 * needs to matter, mark the edge required.
 */
export interface WorkflowJoinNode extends WorkflowNodeBase {
  type: 'join';
  mode: 'all' | 'all-required';
}

export type WorkflowNode =
  | WorkflowAgentTaskNode
  | WorkflowCheckNode
  | WorkflowDeploymentNode
  | WorkflowApprovalNode
  | WorkflowJoinNode;

export type WorkflowNodeType = WorkflowNode['type'];

// ── Edges ────────────────────────────────────────────────────────────────

/**
 * Which outcome traverses an edge. `always` is how a workflow routes to
 * cleanup or notification stages that must run either way.
 */
export type WorkflowEdgeOutcome = 'success' | 'failure' | 'always';

export interface WorkflowEdge {
  id: string;
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  on: WorkflowEdgeOutcome;
  /**
   * Whether a join must wait for this branch, and whether the branch failing
   * blocks downstream approval. Advisory branches set this false.
   */
  required: boolean;
}

// ── Definition ───────────────────────────────────────────────────────────

export interface WorkflowDefinition {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  scope: WorkflowScope;
  /** Required when `scope` is `project`; must be absent when `global`. */
  projectId?: string;
  /** Monotonic per definition. A run pins the version it started against. */
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Must name a node with no inbound edges. */
  entryNodeId: string;
  /** True for templates shipped with the app, which are never edited in place. */
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Policy ───────────────────────────────────────────────────────────────

/**
 * The rules a project imposes on any workflow it runs. Policy is stored apart
 * from definitions so tightening a project's requirements does not mean
 * rewriting — or re-approving — every workflow it owns.
 */
export interface WorkflowPolicyProfile {
  schemaVersion: number;
  id: string;
  name: string;
  scope: WorkflowScope;
  /** Required when `scope` is `project`; must be absent when `global`. */
  projectId?: string;
  /** Gates every approval node must wait on, whatever the definition says. */
  requiredGates: WorkflowGateKind[];
  /** Whether a human approval stage is mandatory before a run can complete. */
  requireHumanApproval: boolean;
  /** When false, a bypass is refused outright rather than prompted for. */
  allowGateBypass: boolean;
  /** When true, an untrusted or invalid agent fails preflight. */
  requireTrustedAgents: boolean;
  /** Upper bound the scheduler enforces regardless of a node's own setting. */
  maxAttemptsPerNode: number;
  /** Gate metric and severity threshold bars */
  gateThresholds?: Partial<Record<WorkflowGateKind, GateThresholdCondition[]>>;
  /** Active waivers applied across projects governed by this policy */
  waivers?: FindingWaiver[];
  createdAt: string;
  updatedAt: string;
}

// ── Run references ───────────────────────────────────────────────────────

/**
 * Terminal and in-flight states a node attempt can hold. The durable run state
 * machine that drives these lives in TASK-095; these are the shared labels the
 * contracts, the designer, and the monitor all read.
 */
export type WorkflowNodeOutcome =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Whether an outcome is settled, so callers stop treating a node as live. */
export function isTerminalOutcome(outcome: WorkflowNodeOutcome): boolean {
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'skipped' || outcome === 'cancelled';
}

/**
 * Identifies a run without dragging its whole event log along. A run pins
 * `workflowVersion` at start, so editing a definition never rewrites history
 * for a run already in flight.
 */
export interface WorkflowRunRef {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  projectId: string;
  startedAt: string;
}

/** A produced artifact, addressed by the contract slot that declared it. */
export interface WorkflowArtifactRef {
  artifactId: string;
  /** The `WorkflowArtifactContract.id` this fills. */
  contractId: string;
  nodeId: string;
  runId: string;
  kind: WorkflowArtifactKind;
  /** Workspace-relative when the artifact is a file on disk. */
  path?: string;
  createdAt: string;
}

/**
 * A recorded gate decision. `bypassedBy`/`reason` are populated only for an
 * override, which is what makes a bypass auditable rather than invisible.
 */
export interface WorkflowGateDecision {
  gate: WorkflowGateKind;
  nodeId: string;
  passed: boolean;
  bypassed: boolean;
  bypassedBy?: string;
  reason?: string;
  decidedAt: string;
}

// ── Narrowing helpers ────────────────────────────────────────────────────

export function isAgentTaskNode(node: WorkflowNode): node is WorkflowAgentTaskNode {
  return node.type === 'agent-task';
}

export function isCheckNode(node: WorkflowNode): node is WorkflowCheckNode {
  return node.type === 'check';
}

export function isDeploymentNode(node: WorkflowNode): node is WorkflowDeploymentNode {
  return node.type === 'deployment';
}

export function isApprovalNode(node: WorkflowNode): node is WorkflowApprovalNode {
  return node.type === 'approval';
}

export function isJoinNode(node: WorkflowNode): node is WorkflowJoinNode {
  return node.type === 'join';
}

/** Nodes that declare artifact outputs. Approval and join stages produce none. */
export function nodeOutputs(node: WorkflowNode): WorkflowArtifactContract[] {
  return isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) ? node.outputs : [];
}

/** The gate a node stands behind, when it stands behind one. */
export function nodeGate(node: WorkflowNode): WorkflowGateKind | undefined {
  return isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) ? node.satisfiesGate : undefined;
}

/**
 * Whether a stage writes to the canonical implementation worktree. The
 * scheduler runs at most one such stage at a time; everything else fans out.
 * Note the differing defaults — see each node type.
 */
export function nodeMutatesWorktree(node: WorkflowNode): boolean {
  if (isAgentTaskNode(node)) return node.mutatesWorktree;
  if (isCheckNode(node)) return node.mutatesWorktree === true;
  // A deployment stage ships an already-built artifact; it never touches the
  // implementation worktree, so — like approval and join — it always fans out.
  return false;
}
