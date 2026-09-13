/**
 * "Recommend a workflow template" for the New Workflow dialog — the sibling
 * of `workflowAgentRecommendation.ts`, same shape: one lightweight
 * `runProviderPrompt` completion, not a session, against whichever `kind:
 * 'api'` provider `resolveRecommendationProvider` picked. The answer is
 * cached on the project record itself
 * (`ProjectRecord.recommendedWorkflowTemplate` via
 * `ProjectStore.setRecommendedWorkflowTemplate`) rather than re-asked every
 * time the dialog opens — the caller decides when to compute or refresh it,
 * this module only ever runs when told to.
 */

import type { AiProvider } from '../types';
import type { TokenUsage } from './gateway';
import { runProviderPrompt } from './providerPrompt';

export interface TemplateRecommendationCandidate {
  templateId: string;
  name: string;
  description?: string;
}

export interface TemplateRecommendationInput {
  projectName: string;
  purpose: string;
  brief: Record<string, string>;
  candidates: TemplateRecommendationCandidate[];
}

export interface TemplateRecommendationResult {
  templateId: string;
  rationale: string;
  model: string;
  provider: AiProvider;
  usage?: TokenUsage;
}

const SYSTEM_PROMPT = `You are helping someone pick a workflow template for a software delivery project.
Given the project's name, purpose, and a short brief, and a list of available workflow templates, pick the
single best-fitting template. Respond with exactly one fenced JSON code block and nothing else:

\`\`\`json
{ "templateId": "<one of the listed template ids, verbatim>", "rationale": "<one sentence, specific to this project>" }
\`\`\``;

function buildPrompt(input: TemplateRecommendationInput): string {
  const briefText = Object.entries(input.brief)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `- ${key}: ${value.trim()}`)
    .join('\n');
  const catalogText = input.candidates
    .map(candidate => `- ${candidate.templateId}: ${candidate.name}${candidate.description ? ` — ${candidate.description}` : ''}`)
    .join('\n');
  return [
    `Project name: ${input.projectName || '(untitled project)'}`,
    `Purpose: ${input.purpose.trim() || '(none provided)'}`,
    briefText ? `Brief:\n${briefText}` : undefined,
    `\nAvailable workflow templates:\n${catalogText}`,
    '\nRecommend exactly one template id from the list above.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function parseRecommendation(text: string, validIds: readonly string[]): { templateId: string; rationale: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonBlock(text));
  } catch {
    throw new Error('The AI recommendation response was not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || !('templateId' in parsed)) {
    throw new Error('The AI recommendation response did not include a templateId.');
  }
  const record = parsed as Record<string, unknown>;
  const templateId = typeof record.templateId === 'string' ? record.templateId.trim() : '';
  const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : '';
  if (!validIds.includes(templateId)) {
    throw new Error(`The AI recommended "${templateId}", which is not one of the offered templates.`);
  }
  return { templateId, rationale: rationale || 'No rationale was given.' };
}

export async function recommendTemplateForProject(
  input: TemplateRecommendationInput,
  options: { provider: AiProvider; apiKey: string; baseUrl?: string; model?: string; signal?: AbortSignal }
): Promise<TemplateRecommendationResult> {
  if (input.candidates.length === 0) {
    throw new Error('No workflow templates are available to recommend from.');
  }
  let usage: TokenUsage | undefined;
  const { text, model } = await runProviderPrompt(options.provider, buildPrompt(input), {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    systemPrompt: SYSTEM_PROMPT,
    signal: options.signal,
    onUsage: reported => {
      usage = reported;
    }
  });
  const { templateId, rationale } = parseRecommendation(
    text,
    input.candidates.map(candidate => candidate.templateId)
  );
  return { templateId, rationale, model, provider: options.provider, usage };
}
