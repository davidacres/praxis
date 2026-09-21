/**
 * Which model a stage's session should use.
 *
 * Precedence, most specific first: the stage's own exact `model`; the model the
 * user mapped to the stage's tier for the active provider (`ai.modelTiers`);
 * the run's model; the provider's default. A tier the user has not mapped falls
 * through rather than guessing — model ids are provider-specific, and a wrong
 * id fails the launch, which is worse than using the run's model.
 *
 * Retry escalation is a rule, not a judgement: each failed attempt after the
 * first moves one tier up. Attempts that stopped without a verdict (provider
 * limit, environment) never spent the stage, so they do not escalate either.
 */

import { WORKFLOW_MODEL_TIERS, type WorkflowAgentTaskNode, type WorkflowModelTier } from './workflowTypes';

/** provider id → tier → model id. */
export type ModelTierMap = Record<string, Partial<Record<WorkflowModelTier, string>> | undefined>;

export interface StageModelChoice {
  /** Undefined means "use the provider's default". */
  model?: string;
  tier?: WorkflowModelTier;
  /** Why this model, for the session's record and the run timeline. */
  reason: string;
}

export function isModelTier(value: unknown): value is WorkflowModelTier {
  return typeof value === 'string' && (WORKFLOW_MODEL_TIERS as readonly string[]).includes(value);
}

/** The tier `steps` above `tier`, capped at the strongest. */
export function escalateTier(tier: WorkflowModelTier, steps: number): WorkflowModelTier {
  const index = WORKFLOW_MODEL_TIERS.indexOf(tier);
  return WORKFLOW_MODEL_TIERS[Math.min(WORKFLOW_MODEL_TIERS.length - 1, index + Math.max(0, steps))];
}

export function chooseStageModel(input: {
  node: Pick<WorkflowAgentTaskNode, 'model' | 'modelTier' | 'escalateOnRetry'>;
  provider: string;
  tiers?: ModelTierMap;
  runModel?: string;
  /** Attempts that spent the stage so far (see `attemptsSpent`). */
  attemptsSpent: number;
}): StageModelChoice {
  const { node, provider, tiers, runModel, attemptsSpent } = input;

  const exact = node.model?.trim();
  if (exact) return { model: exact, reason: 'the stage names this model' };

  if (node.modelTier) {
    const escalate = node.escalateOnRetry !== false;
    const tier = escalate ? escalateTier(node.modelTier, attemptsSpent) : node.modelTier;
    const mapped = tiers?.[provider]?.[tier]?.trim();
    if (mapped) {
      const raised = tier !== node.modelTier;
      return {
        model: mapped,
        tier,
        reason: raised
          ? `${tier} tier (raised from ${node.modelTier} after ${attemptsSpent} failed attempt${attemptsSpent === 1 ? '' : 's'})`
          : `${tier} tier`
      };
    }
    // An unmapped tier is not an error: the run's model still works.
    return {
      ...(runModel ? { model: runModel } : {}),
      tier,
      reason: `no model is mapped to the ${tier} tier for ${provider}, so the run's model is used`
    };
  }

  return runModel ? { model: runModel, reason: "the run's model" } : { reason: "the provider's default model" };
}

/** Default tier for a stage that did not set one, by what the stage is for. */
export function defaultTierForStage(node: Pick<WorkflowAgentTaskNode, 'mutatesWorktree' | 'satisfiesGate' | 'name'>): WorkflowModelTier {
  if (node.mutatesWorktree) return 'strong';
  if (node.satisfiesGate) return 'standard';
  return 'fast';
}
