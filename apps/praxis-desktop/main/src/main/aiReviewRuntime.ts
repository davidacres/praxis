import {
  PROVIDER_DESCRIPTORS,
  buildTicketContext,
  reviewTicketWithClaude,
  reviewTicketWithOpenAi,
  reviewTicketWithVercelGateway,
  type AiProvider,
  type IssueDetails
} from '@praxis/core';
import { getAcpAgentHost, resolveAcpStartOptions, resolveConnectionOptions } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';

const DEFAULT_REVIEW_PROMPT = `You are a technical product manager reviewing tickets for completeness and quality.
Analyze the ticket and provide concise, actionable feedback on clarity, completeness, missing technical context, and ambiguities.
Be constructive and specific. Format the response in markdown.`;

export interface AiReviewRuntimeOptions {
  provider: AiProvider;
  model?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  onUpdate?: (markdown: string) => void;
  userPrompt?: string;
}

/** Runs ticket review/analysis through the exact runtime selected in ticket details. */
export async function reviewIssueWithRuntime(
  issue: IssueDetails,
  options: AiReviewRuntimeOptions
): Promise<string> {
  const settings = getSettingsBackend().read();
  const descriptor = PROVIDER_DESCRIPTORS[options.provider];
  const agentName = settings.ai.agentName.trim() || descriptor.label;
  const systemPrompt = [options.systemPrompt?.trim() || DEFAULT_REVIEW_PROMPT, options.userPrompt?.trim() ? `User follow-up:\n${options.userPrompt.trim()}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  if (descriptor.kind === 'api') {
    const connection = await resolveConnectionOptions(options.provider);
    if (!connection.apiKey) {
      throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
    }
    const review = options.provider === 'openai'
      ? reviewTicketWithOpenAi
      : options.provider === 'anthropic'
        ? reviewTicketWithClaude
        : reviewTicketWithVercelGateway;
    return review(issue, connection.apiKey, agentName, {
      gatewayUrl: connection.gatewayUrl,
      model: options.model?.trim() || connection.model,
      systemPrompt,
      signal: options.signal,
      onUpdate: options.onUpdate
    });
  }

  const prompt = [
    systemPrompt,
    'This is a read-only ticket review. Do not modify files or run destructive commands.',
    `Review this ticket and respond in markdown:\n\n${buildTicketContext(issue)}`
  ].join('\n\n');
  const emit = (content: string) => options.onUpdate?.(`## AI Review by ${agentName}\n\n${content}`);
  const workingDirectory = settings.ai.workingDirectory.trim() || undefined;

  const content = await getAcpAgentHost().promptOnce(prompt, {
    ...resolveAcpStartOptions(options.provider),
    model: options.model,
    workingDirectory,
    signal: options.signal,
    onUpdate: emit
  });

  return `## AI Review by ${agentName}\n\n${content}`;
}
