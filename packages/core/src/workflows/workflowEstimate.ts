/**
 * What a run could cost, at worst, before it starts (FX-BE-167 / TASK-436).
 *
 * Loops and fan-out make a run's cost open-ended in a way a straight pipeline
 * never was, so the start dialog shows the ceiling: every loop spent, every
 * stage using every attempt, every map at its item cap. That is labelled a worst
 * case and never presented as the expected cost.
 *
 * Tokens and spend are estimated only from what this machine has actually
 * measured — past workflow stage sessions in the usage log. With too few of
 * those there is no estimate, and the dialog says "not estimable" rather than
 * showing a number nobody measured.
 */

import type { AiUsageEvent } from '../ai/aiUsageLog';
import { dagEdges, loopBudget, loopEdges } from './workflowEdges';
import {
  isAgentTaskNode,
  isCheckNode,
  isDeploymentNode,
  isMapNode,
  isMergeNode,
  type WorkflowDefinition,
  type WorkflowModelTier,
  type WorkflowNode
} from './workflowTypes';

/** Fewer measured stage sessions than this and a token range would be a guess. */
export const MIN_STAGE_SAMPLES = 3;
/** Above this many worst-case agent launches, starting a run asks for a confirm (`delivery.runConfirmAgentSessions`). */
export const DEFAULT_LAUNCH_CONFIRM_THRESHOLD = 40;

/** Token (and, where reported, cost) range of one agent stage session, from the usage log. */
export interface StageUsageSample {
  /** Measured stage sessions the range is drawn from. */
  sessions: number;
  /** Per stage session: the 25th and 90th percentile. */
  tokens: { low: number; high: number };
  /** Only when every measured session reported cost in one currency. */
  cost?: { currency: string; low: number; high: number };
}

export interface StageEstimate {
  nodeId: string;
  name: string;
  type: WorkflowNode['type'];
  /** Launches on the first pass, with no loop taken and no retry. */
  firstPass: number;
  /** Launches at worst: every loop spent, every attempt used, every map item run. */
  worstCase: number;
  isAgent: boolean;
  tier?: WorkflowModelTier;
  model?: string;
  provider?: string;
}

export interface RunEstimate {
  stages: StageEstimate[];
  loops: Array<{ edgeId: string; from: string; to: string; budget: number }>;
  firstPassAgentLaunches: number;
  worstCaseAgentLaunches: number;
  worstCaseCheckLaunches: number;
  /** Present only when enough stage sessions were measured to say. */
  tokens?: { low: number; high: number };
  spend?: { currency: string; low: number; high: number };
  /** Why there is no token or spend range, when there is none. */
  notEstimable?: string;
  /** Measured stage sessions behind the token range. */
  basedOnSessions?: number;
  threshold: number;
  /** Worst-case agent launches exceed `threshold`: starting asks for a confirm. */
  needsConfirm: boolean;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

/** The per-stage-session range from usage the app recorded during earlier workflow runs. */
export function stageUsageSample(events: readonly AiUsageEvent[]): StageUsageSample | undefined {
  const bySession = new Map<string, { tokens: number; cost: Map<string, number>; uncosted: boolean }>();
  for (const event of events) {
    if (!event.workflowRunId || !event.workflowNodeId) continue;
    const key = `${event.workflowRunId}:${event.workflowNodeId}:${event.sessionId ?? ''}`;
    const entry = bySession.get(key) ?? { tokens: 0, cost: new Map<string, number>(), uncosted: false };
    entry.tokens += event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    if (event.cost) entry.cost.set(event.cost.currency, (entry.cost.get(event.cost.currency) ?? 0) + event.cost.amount);
    bySession.set(key, entry);
  }
  const sessions = [...bySession.values()].filter(entry => entry.tokens > 0);
  if (sessions.length < MIN_STAGE_SAMPLES) return undefined;

  const tokens = sessions.map(entry => entry.tokens).sort((left, right) => left - right);
  const sample: StageUsageSample = {
    sessions: sessions.length,
    tokens: { low: percentile(tokens, 0.25), high: percentile(tokens, 0.9) }
  };
  // Spend only when every session reported it, in a single currency: summing across
  // currencies, or filling gaps, would be a number nobody measured.
  const currencies = new Set(sessions.flatMap(entry => [...entry.cost.keys()]));
  if (currencies.size === 1 && sessions.every(entry => entry.cost.size === 1)) {
    const currency = [...currencies][0];
    const costs = sessions.map(entry => entry.cost.get(currency) ?? 0).sort((left, right) => left - right);
    sample.cost = { currency, low: percentile(costs, 0.25), high: percentile(costs, 0.9) };
  }
  return sample;
}

/** Nodes in each loop's body: from its target to its source, inclusive, along DAG edges. */
function loopBodies(definition: WorkflowDefinition): Array<{ budgetEdgeId: string; body: Set<string> }> {
  const outbound = new Map<string, string[]>();
  for (const edge of dagEdges(definition)) outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge.to]);
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(outbound.get(id) ?? []));
    }
    return seen;
  };
  return loopEdges(definition).map(edge => {
    const fromTarget = reach(edge.to);
    const body = new Set([...fromTarget].filter(id => id === edge.from || reach(id).has(edge.from)));
    return { budgetEdgeId: edge.id, body };
  });
}

function attemptsOf(node: WorkflowNode): number {
  return Math.max(1, (isAgentTaskNode(node) || isCheckNode(node) || isDeploymentNode(node) || isMergeNode(node) ? node.maxAttempts : undefined) ?? 1);
}

/**
 * The worst-case shape of a run of `definition`. Passes through a stage multiply
 * across every loop whose body holds it — an over-estimate for sibling loops,
 * which is the safe direction for a ceiling.
 */
export function estimateWorkflowRun(
  definition: WorkflowDefinition,
  options: {
    parameters?: Record<string, string | number>;
    usage?: StageUsageSample;
    threshold?: number;
    /** Provider per stage as it would launch, when the host knows it. */
    providerFor?: (node: WorkflowNode) => string | undefined;
    tierModel?: (provider: string | undefined, tier: WorkflowModelTier | undefined) => string | undefined;
  } = {}
): RunEstimate {
  const threshold = options.threshold ?? DEFAULT_LAUNCH_CONFIRM_THRESHOLD;
  const budgets = new Map(
    loopEdges(definition).map(edge => [edge.id, loopBudget({ definition, parameters: options.parameters, loopDecisions: [] }, edge)])
  );
  const bodies = loopBodies(definition);
  const recoveryPasses = new Map<string, number>();
  for (const node of definition.nodes) {
    if (isCheckNode(node) && node.failureRecovery) {
      recoveryPasses.set(node.failureRecovery.repairNodeId, node.failureRecovery.maxAttempts);
      recoveryPasses.set(node.id, (recoveryPasses.get(node.id) ?? 0) + node.failureRecovery.maxAttempts);
    }
  }

  const stages: StageEstimate[] = definition.nodes
    .filter(node => node.enabled !== false && (isAgentTaskNode(node) || isCheckNode(node) || isMapNode(node) || isDeploymentNode(node) || isMergeNode(node)))
    .map(node => {
      const passes = bodies
        .filter(entry => entry.body.has(node.id))
        .reduce((product, entry) => product * ((budgets.get(entry.budgetEdgeId) ?? 0) + 1), 1);
      const items = isMapNode(node) ? node.maxItems : 1;
      // A repair stage runs only when its check fails: none on the first pass.
      const isRepair = definition.nodes.some(candidate => isCheckNode(candidate) && candidate.failureRecovery?.repairNodeId === node.id);
      const firstPass = isRepair ? 0 : items;
      const worstCase = passes * items * (isRepair ? recoveryPasses.get(node.id) ?? 1 : attemptsOf(node) + (recoveryPasses.get(node.id) ?? 0));
      const isAgent = isAgentTaskNode(node) || isMapNode(node);
      const provider = isAgent ? options.providerFor?.(node) : undefined;
      const tier = isAgent ? node.modelTier : undefined;
      const model = isAgent ? node.model ?? options.tierModel?.(provider, tier) : undefined;
      return {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        firstPass,
        worstCase,
        isAgent,
        ...(tier ? { tier } : {}),
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {})
      };
    });

  const firstPassAgentLaunches = stages.filter(stage => stage.isAgent).reduce((sum, stage) => sum + stage.firstPass, 0);
  const worstCaseAgentLaunches = stages.filter(stage => stage.isAgent).reduce((sum, stage) => sum + stage.worstCase, 0);
  const worstCaseCheckLaunches = stages.filter(stage => !stage.isAgent).reduce((sum, stage) => sum + stage.worstCase, 0);

  const estimate: RunEstimate = {
    stages,
    loops: loopEdges(definition).map(edge => ({ edgeId: edge.id, from: edge.from, to: edge.to, budget: budgets.get(edge.id) ?? 0 })),
    firstPassAgentLaunches,
    worstCaseAgentLaunches,
    worstCaseCheckLaunches,
    threshold,
    needsConfirm: worstCaseAgentLaunches > threshold
  };
  const usage = options.usage;
  if (!usage) {
    estimate.notEstimable = `Not estimable: fewer than ${MIN_STAGE_SAMPLES} workflow stage sessions have reported usage on this machine.`;
    return estimate;
  }
  estimate.basedOnSessions = usage.sessions;
  estimate.tokens = { low: usage.tokens.low * firstPassAgentLaunches, high: usage.tokens.high * worstCaseAgentLaunches };
  if (usage.cost) {
    estimate.spend = { currency: usage.cost.currency, low: usage.cost.low * firstPassAgentLaunches, high: usage.cost.high * worstCaseAgentLaunches };
  }
  return estimate;
}
