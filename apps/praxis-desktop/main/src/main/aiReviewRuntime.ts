import {
  getProviderDescriptor,
  gatewayOptionsFor,
  buildHeaders,
  endpoint,
  providerNeedsApiKey,
  buildTicketContext,
  reviewTicketWithClaude,
  reviewTicketWithGemini,
  reviewTicketWithOpenAi,
  reviewTicketWithVercelGateway,
  type AiProvider,
  type IssueDetails
} from '@praxis/core';
import { getAcpAgentHost, resolveAcpStartOptions, resolveConnectionOptions } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import type { ReasoningEffort } from '@praxis/core';

const DEFAULT_REVIEW_PROMPT = `You are a technical product manager reviewing tickets for completeness and quality.
Analyze the ticket and provide concise, actionable feedback on clarity, completeness, missing technical context, and ambiguities.
Be constructive and specific. Format the response in markdown.`;

export interface AiReviewRuntimeOptions {
  provider: AiProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: import('@praxis/core').AgentPermissionMode;
  systemPrompt?: string;
  signal?: AbortSignal;
  onUpdate?: (markdown: string) => void;
  userPrompt?: string;
  /** Workflow Designer assistant mode may author a validated workflow, but never files or arbitrary actions. */
  allowMutations?: boolean;
}

/** A custom endpoint's auth and extra headers, minus `Accept` — the review may stream. */
function reviewHeaders(gateway: Parameters<typeof buildHeaders>[0]): Record<string, string> {
  const { Accept: _accept, ...headers } = buildHeaders(gateway);
  return headers;
}

/** Runs ticket review/analysis through the exact runtime selected in ticket details. */
export async function reviewIssueWithRuntime(
  issue: IssueDetails,
  options: AiReviewRuntimeOptions
): Promise<string> {
  const settings = getSettingsBackend().read();
  const descriptor = getProviderDescriptor(options.provider);
  const agentName = settings.ai.agentName.trim() || descriptor.label;
  const systemPrompt = [options.systemPrompt?.trim() || DEFAULT_REVIEW_PROMPT, options.userPrompt?.trim() ? `User follow-up:\n${options.userPrompt.trim()}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  if (descriptor.kind === 'api') {
    const connection = await resolveConnectionOptions(options.provider);
    if (!connection.apiKey && providerNeedsApiKey(options.provider)) {
      throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
    }
    // A custom endpoint speaks OpenAI chat-completions on its own path, with its own auth.
    const customGateway = descriptor.custom ? gatewayOptionsFor(options.provider, connection.gatewayUrl, connection.apiKey) : undefined;
    if (customGateway && !(options.model?.trim() || connection.model)) {
      // The OpenAI review falls back to an OpenAI model id, which a custom server won't have.
      throw new Error(`Choose a default model for ${descriptor.label} under Settings → AI Provider.`);
    }
    const review = options.provider === 'openai' || options.provider === 'z-ai' || customGateway
      ? reviewTicketWithOpenAi
      : options.provider === 'anthropic'
        ? reviewTicketWithClaude
        : options.provider === 'gemini'
          ? reviewTicketWithGemini
          : reviewTicketWithVercelGateway;
    return review(issue, connection.apiKey ?? '', agentName, {
      gatewayUrl: connection.gatewayUrl,
      model: options.model?.trim() || connection.model,
      systemPrompt: [systemPrompt, options.reasoningEffort && options.reasoningEffort !== 'off' ? `Use ${options.reasoningEffort} reasoning effort.` : undefined].filter(Boolean).join('\n\n'),
      signal: options.signal,
      onUpdate: options.onUpdate,
      ...(descriptor.apiPath ? { apiPath: descriptor.apiPath } : {}),
      ...(customGateway
        ? { endpointUrl: endpoint(customGateway, '/chat/completions'), requestHeaders: reviewHeaders(customGateway) }
        : {})
    });
  }

  const prompt = [
    systemPrompt,
    options.reasoningEffort && options.reasoningEffort !== 'off' ? `Use ${options.reasoningEffort} reasoning effort.` : undefined,
    options.allowMutations
      ? 'This is a constrained Workflow Designer assistant. You may propose only changes to the supplied workflow definition; do not modify files, run commands, access tickets, or perform any other action.'
      : 'This is a read-only ticket review. Do not modify files or run destructive commands.',
    `Review this ticket and respond in markdown:\n\n${buildTicketContext(issue)}`
  ].join('\n\n');
  const emit = (content: string) => options.onUpdate?.(`## AI Review by ${agentName}\n\n${content}`);
  const workingDirectory = settings.ai.workingDirectory.trim() || undefined;

  const content = await getAcpAgentHost().promptOnce(prompt, {
    ...resolveAcpStartOptions(options.provider),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    workingDirectory,
    signal: options.signal,
    onUpdate: emit
  });

  return `## AI Review by ${agentName}\n\n${content}`;
}
