import { postChatStream } from '../gateway/gatewayClient';
import { buildChatRequest, consumeChatStream } from '../gateway/wire';
import type { ProviderAdapter } from './providerAdapter';

/**
 * Vercel AI Gateway and OpenAI both speak plain OpenAI chat-completions —
 * same request/response shape, same Bearer auth. The only per-provider
 * difference (Vercel's `Vercel/` model-id prefix) is stripped by the caller
 * before the model id reaches this adapter, so one shared instance serves
 * both `'vercel-gateway'` and `'openai'` in the provider registry.
 */
export const openAiCompatibleAdapter: ProviderAdapter = {
  buildChatRequest,
  postChatStream,
  consumeChatStream
};
