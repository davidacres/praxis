/**
 * "Suggest a model tier for each stage" for the workflow designer — the sibling
 * of `workflowTemplateRecommendation.ts`, same shape: one lightweight
 * constrained completion, not a session. It reads the whole workflow at once so
 * the tiers are chosen relative to each other (the stage that writes the code
 * outranks the one that summarises it).
 *
 * It only ever *suggests*. The designer applies the answer to the unsaved draft
 * and the author saves or discards it; nothing here changes a stored workflow or
 * a run. A stage the model omits or mislabels falls back to the deterministic
 * default (`defaultTierForStage`), so the answer is always complete and valid.
 */

import type { AiProvider } from '../types';
import type { TokenUsage } from './gateway';
import { runProviderPrompt } from './providerPrompt';
import { defaultTierForStage, isModelTier } from '../workflows/stageModel';
import { isAgentTaskNode, type WorkflowDefinition, type WorkflowModelTier } from '../workflows/workflowTypes';

export interface StageTierSuggestion {
  tier: WorkflowModelTier;
  rationale: string;
  /** True when the model gave no usable answer for this stage and the default was used. */
  defaulted: boolean;
}

export interface ModelTierRecommendationResult {
  /** Agent-task node id → suggestion. Every agent-task stage is present. */
  stages: Record<string, StageTierSuggestion>;
  model: string;
  provider: AiProvider;
  usage?: TokenUsage;
}

export type ModelTierPromptRunner = (
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal
) => Promise<{ text: string; model: string }>;

const SYSTEM_PROMPT = `You are helping someone choose how capable a model each stage of a software delivery workflow needs.
Tiers: "fast" (cheap and quick: summaries, formatting, simple checks of text), "standard" (routine review, test
authoring, analysis), "strong" (hard reasoning: writing or changing production code, security review, subtle
correctness review). A stage that fails is retried one tier higher automatically, so prefer the cheapest tier that
will usually succeed. Respond with exactly one fenced JSON code block and nothing else:

\`\`\`json
{ "stages": { "<nodeId, verbatim>": { "tier": "fast|standard|strong", "rationale": "<one short sentence>" } } }
\`\`\``;

function buildPrompt(definition: WorkflowDefinition): string {
  const stages = definition.nodes.filter(isAgentTaskNode).map(node =>
    [
      `- id: ${node.id}`,
      `  name: ${node.name}`,
      `  writes code to the worktree: ${node.mutatesWorktree ? 'yes' : 'no'}`,
      node.satisfiesGate ? `  evidence for the ${node.satisfiesGate} gate` : undefined,
      `  instructions: ${node.instructions.trim().replace(/\s+/g, ' ').slice(0, 400) || '(none)'}`
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n')
  );
  return [`Workflow: ${definition.name}`, definition.description ? `Description: ${definition.description}` : undefined, '', 'Stages:', stages.join('\n')]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** Exposed for tests: turns the model's text into a complete, valid answer. */
export function parseTierSuggestions(text: string, definition: WorkflowDefinition): Record<string, StageTierSuggestion> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonBlock(text));
  } catch {
    throw new Error('The AI model-tier response was not valid JSON.');
  }
  const answered =
    typeof parsed === 'object' && parsed !== null && typeof (parsed as { stages?: unknown }).stages === 'object' && (parsed as { stages?: unknown }).stages !== null
      ? ((parsed as { stages: Record<string, unknown> }).stages)
      : undefined;
  if (!answered) throw new Error('The AI model-tier response did not include a "stages" object.');

  const result: Record<string, StageTierSuggestion> = {};
  for (const node of definition.nodes.filter(isAgentTaskNode)) {
    const entry = answered[node.id];
    const tier = typeof entry === 'object' && entry !== null ? (entry as { tier?: unknown }).tier : undefined;
    const rationale = typeof entry === 'object' && entry !== null ? (entry as { rationale?: unknown }).rationale : undefined;
    result[node.id] = isModelTier(tier)
      ? { tier, rationale: typeof rationale === 'string' && rationale.trim() ? rationale.trim() : 'No rationale was given.', defaulted: false }
      : { tier: defaultTierForStage(node), rationale: 'The model gave no usable answer for this stage, so the default for what it does was used.', defaulted: true };
  }
  return result;
}

export async function recommendModelTiers(
  definition: WorkflowDefinition,
  options: { provider: AiProvider; apiKey?: string; baseUrl?: string; model?: string; signal?: AbortSignal; promptRunner?: ModelTierPromptRunner }
): Promise<ModelTierRecommendationResult> {
  if (!definition.nodes.some(isAgentTaskNode)) {
    throw new Error('This workflow has no agent stages to choose a model for.');
  }
  let usage: TokenUsage | undefined;
  const prompt = buildPrompt(definition);
  const response = options.promptRunner
    ? await options.promptRunner(prompt, SYSTEM_PROMPT, options.signal)
    : options.apiKey
      ? await runProviderPrompt(options.provider, prompt, {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          model: options.model,
          systemPrompt: SYSTEM_PROMPT,
          signal: options.signal,
          onUsage: reported => {
            usage = reported;
          }
        })
      : (() => {
          throw new Error('No API key or recommendation prompt runner was provided.');
        })();
  return { stages: parseTierSuggestions(response.text, definition), model: response.model, provider: options.provider, usage };
}
