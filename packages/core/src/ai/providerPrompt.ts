/**
 * Provider-agnostic sibling of `gatewayPrompt.ts`'s `runGatewayPrompt`: the
 * same "one lightweight completion, not a session" shape, but dispatched
 * through `resolveProviderAdapter` so it works against whichever `kind: 'api'`
 * provider (Vercel AI Gateway, OpenAI, or Anthropic) is actually configured,
 * rather than assuming Vercel. `kind: 'cli-agent'` providers (Claude Code,
 * Codex, Copilot) have no direct completion endpoint to call this way —
 * `resolveProviderAdapter` throws for those, by design.
 *
 * Used by the workflow template / agent recommendation features via
 * `resolveRecommendationProvider`, which picks the provider this calls.
 * `runGatewayPrompt` itself stays untouched — the AI review feature keeps
 * using it directly and is out of scope here.
 */

import type { AiProvider } from '../types';
import type { ChatCompletionResult, TokenUsage } from './gateway';
import { toWireModelId } from './gateway/modelIds';
import { gatewayOptionsFor, getProviderDescriptor, resolveProviderAdapter } from './providers/registry';

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled.') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export async function runProviderPrompt(
  provider: AiProvider,
  prompt: string,
  options: {
    apiKey: string;
    baseUrl?: string;
    systemPrompt: string;
    timeoutMs?: number;
    streamIdleTimeoutMs?: number;
    onUpdate?: (content: string) => void;
    /** Fires once with whatever the provider reported, if anything — see `TokenUsage`'s own doc for why absence isn't a zero. */
    onUsage?: (usage: TokenUsage) => void;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<{ text: string; model: string }> {
  if (options.signal?.aborted) {
    throw new AnalysisCancelledError();
  }

  const descriptor = getProviderDescriptor(provider);
  if (descriptor.kind !== 'api') {
    throw new Error(`Provider '${provider}' has no direct completion endpoint to call this way.`);
  }
  const adapter = resolveProviderAdapter(provider);

  const requestedModel = options.model?.trim() || descriptor.defaultModel;
  const model = provider === 'vercel-gateway' ? toWireModelId(requestedModel) : requestedModel;
  const gateway = gatewayOptionsFor(provider, options.baseUrl, options.apiKey);
  const idleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = adapter.buildChatRequest({
    modelId: model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: prompt }
    ],
    maxTokens: 8192,
    streamUsage: gateway.streamUsage,
    gatewayCaching: gateway.gatewayCaching
  });

  let accumulated = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle: ((reason: Error) => void) | undefined;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      rejectIdle?.(
        new Error(`${descriptor.label} response stalled — no streaming data received for ${Math.round(idleTimeoutMs / 1000)}s.`)
      );
    }, idleTimeoutMs);
  };

  const idlePromise = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject;
    idleTimer = setTimeout(() => {
      reject(
        new Error(`${descriptor.label} response timed out after ${Math.round(timeoutMs / 1000)}s with no streaming activity.`)
      );
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!options.signal) {
      return;
    }
    const onAbort = (): void => reject(new AnalysisCancelledError());
    options.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const streamPromise = (async () => {
      const handle = await adapter.postChatStream(gateway, body, options.signal, idleTimeoutMs);
      resetIdle();
      let final: ChatCompletionResult = { text: '', toolCalls: [] };
      for await (const event of adapter.consumeChatStream(handle.lines, options.signal)) {
        if (event.type === 'text_delta') {
          resetIdle();
          accumulated += event.text;
          options.onUpdate?.(accumulated);
        } else if (event.type === 'done') {
          final = event.result;
        }
      }
      if (final.usage) {
        options.onUsage?.(final.usage);
      }
      return final.text.trim() || accumulated.trim();
    })();

    const text = await Promise.race([streamPromise, idlePromise, abortPromise]);
    if (!text) {
      throw new Error(`${descriptor.label} returned an empty response.`);
    }
    return { text, model };
  } finally {
    clearIdle();
  }
}
