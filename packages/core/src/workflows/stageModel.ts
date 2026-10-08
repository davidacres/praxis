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

/** How an `independentOf` stage ends up running relative to the stage it judges (FX-BE-164). */
export interface IndependenceChoice {
  provider: string;
  /** Undefined means the provider's default model. */
  model?: string;
  /** Whether the stage runs on a different provider or a different model from the author. */
  independent: boolean;
  /** Why, in a sentence, for the session record and the run timeline. */
  reason: string;
}

/**
 * Picks where an `independentOf` stage runs so it does not mark its own work:
 * another configured provider when there is one, else another model of the same
 * provider from the tier map, else the same model — reported as not independent,
 * never silently passed off as a second opinion.
 *
 * A provider a person chose for the stage during the run is respected; the result
 * then only reports whether it happens to be independent.
 */
export function chooseIndependentStage(input: {
  /** What the stage would run on by the ordinary rules (`stageProvider` / `chooseStageModel`). */
  provider: string;
  model?: string;
  /** The judged stage's latest attempt. Undefined when it has not run. */
  author?: { provider?: string; model?: string; name: string };
  /** A person switched this stage's provider or model in this run. */
  chosenByPerson: boolean;
  /** Providers that are set up and enabled, in preference order. */
  usableProviders: readonly string[];
  tiers?: ModelTierMap;
  /** The stage's tier, used to pick a model on another provider. */
  tier?: WorkflowModelTier;
}): IndependenceChoice {
  const { provider, model, author } = input;
  if (!author?.provider) {
    return { provider, ...(model ? { model } : {}), independent: true, reason: `${author?.name ?? 'The stage it judges'} has not run, so there is nothing to be independent of yet.` };
  }
  const sameModel = (candidate?: string): boolean => (candidate ?? '') === (author.model ?? '');

  if (input.chosenByPerson) {
    const independent = provider !== author.provider || !sameModel(model);
    return {
      provider,
      ...(model ? { model } : {}),
      independent,
      reason: independent
        ? `Runs on the AI chosen for it in this run, which differs from ${author.name}'s.`
        : `Not independent: the AI chosen for it in this run is the one ${author.name} used.`
    };
  }

  if (provider !== author.provider) {
    return { provider, ...(model ? { model } : {}), independent: true, reason: `Runs on ${provider}; ${author.name} ran on ${author.provider}.` };
  }

  const other = input.usableProviders.find(candidate => candidate !== author.provider);
  if (other) {
    const mapped = input.tier ? input.tiers?.[other]?.[input.tier]?.trim() : undefined;
    return {
      provider: other,
      ...(mapped ? { model: mapped } : {}),
      independent: true,
      reason: `Moved to ${other} so it does not mark work ${author.name} produced on ${author.provider}.`
    };
  }

  if (!sameModel(model)) {
    return { provider, ...(model ? { model } : {}), independent: true, reason: `Same AI as ${author.name}, but a different model (${model ?? 'the default'}).` };
  }
  const alternatives = WORKFLOW_MODEL_TIERS.slice()
    .reverse()
    .map(tier => input.tiers?.[provider]?.[tier]?.trim())
    .filter((candidate): candidate is string => !!candidate && !sameModel(candidate));
  if (alternatives[0]) {
    return { provider, model: alternatives[0], independent: true, reason: `Only ${provider} is set up, so it uses a different model (${alternatives[0]}) from ${author.name}.` };
  }
  return {
    provider,
    ...(model ? { model } : {}),
    independent: false,
    reason: `Not independent: only one model is available, so this is the same AI and model that ${author.name} used. Set up another AI or map a second model tier for a second opinion.`
  };
}
