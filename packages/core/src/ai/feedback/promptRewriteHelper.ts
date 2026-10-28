import type {
  DeterministicFeedbackReport,
  FeedbackAiRewrite
} from './feedbackTypes';
import { buildDeterministicSuggestedPrompt } from './sessionFeedbackScorer';

export interface PromptRewriterCompletionClient {
  complete(systemPrompt: string, userPrompt: string): Promise<{ text: string; modelId?: string }>;
}

/**
 * Generates a refined, copy-ready prompt grounded in the deterministic findings.
 *
 * - Always provides a deterministic template upgrade (`deterministicFallback: true`)
 *   when offline or when no AI completion client is supplied.
 * - When an optional `completionClient` is provided, requests a concise rewrite
 *   and attaches `aiRewrite` to a copy of the report without mutating
 *   `overallScore`, `grade`, `dimensions`, or `inputDigest`.
 */
export async function rewritePromptFromFeedback(
  report: DeterministicFeedbackReport,
  options?: {
    completionClient?: PromptRewriterCompletionClient;
  }
): Promise<DeterministicFeedbackReport> {
  const deterministicPrompt =
    report.suggestedPrompt?.trim() ||
    buildDeterministicSuggestedPrompt(
      report.promptText,
      report.findings,
      report.inventory.skillsRecommended
    );

  const findingTitles = report.findings.map(f => f.title);
  const deterministicRationale =
    findingTitles.length > 0
      ? `Addressed ${findingTitles.length} deterministic finding${findingTitles.length === 1 ? '' : 's'}: ${findingTitles.slice(0, 3).join('; ')}.`
      : 'Prompt is already well-structured with clear scope and verification criteria.';

  if (!options?.completionClient) {
    const aiRewrite: FeedbackAiRewrite = {
      rewrittenPrompt: deterministicPrompt,
      rationale: deterministicRationale,
      deterministicFallback: true
    };
    return {
      ...report,
      aiRewrite
    };
  }

  try {
    const systemPrompt = [
      'You are a prompt engineering assistant for Praxis.',
      'Rewrite the user prompt so it resolves every deterministic finding listed below.',
      'Keep the prompt concise, actionable, and directly usable in an AI coding session.',
      'Return ONLY the rewritten prompt text without surrounding markdown fences or commentary.'
    ].join(' ');

    const findingsSummary = report.findings
      .map(f => `- [${f.dimension}] ${f.title}: ${f.remediation.description}`)
      .join('\n');

    const userPrompt = [
      `Original prompt:\n${report.promptText}`,
      findingsSummary ? `\nFindings to address:\n${findingsSummary}` : '',
      report.inventory.skillsRecommended.length > 0
        ? `\nRecommended skills: ${report.inventory.skillsRecommended.join(', ')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    const response = await options.completionClient.complete(systemPrompt, userPrompt);
    const cleaned = response.text.trim();
    const aiRewrite: FeedbackAiRewrite = {
      rewrittenPrompt: cleaned || deterministicPrompt,
      rationale: deterministicRationale,
      ...(response.modelId ? { modelId: response.modelId } : {}),
      deterministicFallback: !cleaned
    };
    return {
      ...report,
      aiRewrite
    };
  } catch {
    const aiRewrite: FeedbackAiRewrite = {
      rewrittenPrompt: deterministicPrompt,
      rationale: deterministicRationale,
      deterministicFallback: true
    };
    return {
      ...report,
      aiRewrite
    };
  }
}
