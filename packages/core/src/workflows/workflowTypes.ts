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
 * Agent profiles and runtime hosts are referenced independently by stable ids.
 * Legacy definitions keep agentId as a host/profile fallback. A definition never
 * embeds executable configuration: preflight resolves the live trusted catalog.
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
  /** Legacy combined id. New definitions set this to the runtime host id for compatibility. */
  agentId: string;
  /** Provider-neutral role/instruction profile. Defaults to agentId for legacy definitions. */
  profileId?: string;
  /** Executable runtime host. Defaults to agentId for legacy definitions. */
  hostId?: string;
  /** Provider preference. Undefined means use the project's active provider. */
  providerId?: string;
  /** Which catalog the profile and host must resolve from. */
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
  /**
   * A skeptic stage's judgement of this finding (FX-BE-164). A `refuted` finding
   * is kept on the record but no longer counts: not against a gate threshold,
   * and not toward a findings edge, so a false finding cannot send a loop round.
   */
  verdict?: 'confirmed' | 'refuted';
  /** The skeptic's evidence for its verdict. */
  verdictReason?: string;
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
  /**
   * `board` (a `plan` output of an agent stage only): the stage ends its response with a
   * `PRAXIS_PLAN` block and the app creates it on the run's project board — a feature and its
   * work items — recording the feature's key on the artifact (`WorkflowArtifactRef.reference`).
   */
  publishTo?: 'board';
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

/**
 * How much model a stage needs, independent of provider. What each tier means
 * for a given provider is the user's mapping (`ai.modelTiers`), because model
 * ids are provider-specific and there is no honest universal ranking.
 */
export type WorkflowModelTier = 'fast' | 'standard' | 'strong';

export const WORKFLOW_MODEL_TIERS: readonly WorkflowModelTier[] = ['fast', 'standard', 'strong'];

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
  /** An exact model id for this stage. Wins over `modelTier` and the run's model. */
  model?: string;
  /** The tier of model this stage needs; resolved per provider. Absent means the run's model. */
  modelTier?: WorkflowModelTier;
  /** Move up a tier on each retry (fast → standard → strong). Defaults to on when a tier is set. */
  escalateOnRetry?: boolean;
  /**
   * The stage whose work this one judges (FX-BE-164). At launch the stage runs on a
   * different AI provider from that stage's latest attempt when another is set up, else a
   * different model, else it runs and the run records that it was not independent.
   */
  independentOf?: string;
  /**
   * Makes this a skeptic of another stage's findings (FX-BE-164). When it succeeds, its
   * per-finding verdicts are applied to that stage's findings, matched by fingerprint, so
   * a refuted finding stops counting toward gates and findings edges. Until it has run,
   * a loop or findings edge from the judged stage waits for it.
   */
  refutes?: string;
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
  /**
   * Optional bounded self-healing path. The target must be a mutating
   * agent-task reached by this node's failure edge. A successful repair opens
   * a new attempt of this check and re-runs its downstream evidence.
   */
  failureRecovery?: {
    repairNodeId: string;
    maxAttempts: number;
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
  /**
   * The approval offers the next steps as an option rather than a sign-off: a person may
   * **skip** it, which skips everything that follows and lets the run finish as succeeded.
   * Opt-in, so a delivery sign-off can never be skipped past.
   */
  optional?: boolean;
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

export interface WorkflowMergeNode extends WorkflowNodeBase {
  type: 'merge';
  /** Target branch to merge into; defaults to base branch ('main'). */
  targetBranch?: string;
  /** Whether merge uses --no-ff commit (default true). */
  noFastForward?: boolean;
  /** Handling on conflict: 'fail' or 'ai-resolve' (default 'ai-resolve'). */
  onConflict?: 'fail' | 'ai-resolve';
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * Runs one agent stage per item of a list known only at run time (FX-BE-165): each
 * finding of an upstream `findings` output, say, or each item of a plan.
 *
 * Read-only items share the run's worktree and run side by side. Mutating items each
 * get their own worktree, branched from the same snapshot, and are merged back in item
 * order, so the one-writer rule for the shared worktree never bends.
 */
export interface WorkflowMapNode extends WorkflowNodeBase {
  type: 'map';
  /** The artifact contract id whose items are fanned out. Must be one of `inputs`. */
  over: string;
  /** How items are read from it: one per finding, or one per plan item. */
  itemSource: 'findings' | 'plan-items';
  /** The stage each item runs. Its brief gains the item it was handed. */
  agent: WorkflowAgentRef;
  instructions: string;
  /** Whether each item writes code (then it gets its own worktree) or only reads. */
  mutatesWorktree: boolean;
  /** At most this many items run at once. */
  concurrency: number;
  /** At most this many items run at all; the rest are recorded as deferred. */
  maxItems: number;
  /** `collect` runs every item and fails the node if any failed; `failFast` stops at the first failure. */
  onItemFailure: 'collect' | 'failFast';
  outputs: WorkflowArtifactContract[];
  satisfiesGate?: WorkflowGateKind;
  timeoutMs?: number;
  model?: string;
  modelTier?: WorkflowModelTier;
}

export type WorkflowNode =
  | WorkflowAgentTaskNode
  | WorkflowCheckNode
  | WorkflowDeploymentNode
  | WorkflowApprovalNode
  | WorkflowJoinNode
  | WorkflowMergeNode
  | WorkflowMapNode;

export type WorkflowNodeType = WorkflowNode['type'];

// ── Edges ────────────────────────────────────────────────────────────────

/**
 * Which outcome traverses an edge. `always` is how a workflow routes to
 * cleanup or notification stages that must run either way. `findings` routes on
 * what a stage *found* rather than whether it ran (FX-BE-162): the edge is taken
 * when the stage settled with structured findings matching the edge's `when`.
 */
export type WorkflowEdgeOutcome = 'success' | 'failure' | 'always' | 'findings';

/**
 * Which findings a `findings` edge routes on. Clauses are alternatives: the edge
 * fires when **any** set clause holds, so a loop keeps going while any problem
 * remains. Refuted findings (`CheckFinding.verdict`) never count.
 */
export interface WorkflowFindingsPredicate {
  /** Count findings at or above this severity. Defaults to `high` when no clause is set. */
  severity?: CheckFindingSeverity;
  /** The severity clause holds when at least this many findings match. Defaults to 1. */
  minCount?: number;
  /** Only findings in these categories count toward the severity clause. */
  categories?: string[];
  /** Holds when this comparison against the stage's metrics is true (a missing metric never holds). */
  metric?: { metric: string; operator: MetricThresholdCondition['operator']; value: number };
}

/** The most iterations any loop may run, whatever its budget or grants say. */
export const WORKFLOW_MAX_LOOP_ITERATIONS = 10;

/**
 * A back-edge's bound (FX-BE-162). The only way a workflow may contain a cycle:
 * every edge that closes one carries a budget, so every run is provably finite.
 */
export interface WorkflowLoopBudget {
  /** How many times the loop may be taken before a person must decide. 1…`WORKFLOW_MAX_LOOP_ITERATIONS`. */
  maxIterations: number;
  /**
   * Keep the best iteration rather than the latest (FX-BE-166): when the source
   * stage's metric gets worse than the best seen, the worktree is restored to the
   * best iteration's snapshot before the loop goes round again, and the run ends there.
   */
  keepBest?: { metric: string; higherIsBetter: boolean };
}

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
  /** Required for, and only meaningful on, a `findings` edge. */
  when?: WorkflowFindingsPredicate;
  /**
   * Marks a back-edge: taking it reopens `to` and everything downstream of it as a
   * new revision. A loop edge is not part of the run's DAG — readiness, snapshots and
   * ancestry ignore it — and it is taken only once nothing in the run is still running.
   */
  loop?: WorkflowLoopBudget;
}

/**
 * A value a person supplies when starting a run (FX-BE-166), such as a goal or
 * how many times to iterate. Fixed for the life of the run and recorded on it.
 */
export interface WorkflowRunParameter {
  /** Key in `WorkflowRun.parameters`; also how a stage brief names it. */
  id: string;
  label: string;
  kind: 'text' | 'integer' | 'number';
  description?: string;
  required?: boolean;
  default?: string | number;
  min?: number;
  max?: number;
  /** An integer parameter that sets this loop edge's `maxIterations` for the run. */
  bindsLoopEdge?: string;
}

// ── Definition ───────────────────────────────────────────────────────────

export interface WorkflowDefinition {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  /** How this workflow is started. Ticket workflows cannot run without a ticket link. */
  trigger?: 'on-demand' | 'ticket';
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
  /** Values asked for when a run starts. */
  parameters?: WorkflowRunParameter[];
  /**
   * The run cannot start without a goal it can measure (FX-BE-166): a `target`
   * parameter or a `rubric` parameter must be given a value.
   */
  requiresMeasurableGoal?: boolean;
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
  /** Where the artifact was published on the project board (a `publishTo: 'board'` plan). */
  reference?: WorkflowBoardReference;
  createdAt: string;
}

/** A plan published to a project board: the feature that holds it, and its work items. */
export interface WorkflowBoardReference {
  /** The feature's issue key — the plan's id on the board. */
  key: string;
  title: string;
  /** Keys of the work items created under it, in plan order. */
  itemKeys: string[];
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
  /** Immutable implementation snapshot this decision assessed. */
  assessedSnapshotRef?: string;
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

export function isMergeNode(node: WorkflowNode): node is WorkflowMergeNode {
  return node.type === 'merge';
}

export function isMapNode(node: WorkflowNode): node is WorkflowMapNode {
  return node.type === 'map';
}

/** Nodes that declare artifact outputs. Approval, merge and join stages produce none. */
export function nodeOutputs(node: WorkflowNode): WorkflowArtifactContract[] {
  return isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) || isMapNode(node) ? node.outputs : [];
}

/** The gate a node stands behind, when it stands behind one. */
export function nodeGate(node: WorkflowNode): WorkflowGateKind | undefined {
  return isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) || isMapNode(node) ? node.satisfiesGate : undefined;
}

/**
 * Whether a stage writes to the canonical implementation worktree. The
 * scheduler runs at most one such stage at a time; everything else fans out.
 * Note the differing defaults — see each node type.
 */
export function nodeMutatesWorktree(node: WorkflowNode): boolean {
  if (isAgentTaskNode(node)) return node.mutatesWorktree;
  if (isCheckNode(node)) return node.mutatesWorktree === true;
  if (isMergeNode(node)) return true;
  // A map's mutating items each write to their own worktree and are merged back
  // into the run's tree when the node settles, so the node as a whole is a writer.
  if (isMapNode(node)) return node.mutatesWorktree;
  // A deployment stage ships an already-built artifact; it never touches the
  // implementation worktree, so — like approval and join — it always fans out.
  return false;
}
