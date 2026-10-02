import { openAiCompatibleAdapter } from './openAiCompatibleAdapter';
import type { ProviderAdapter } from './providerAdapter';

/** Bifrost translates its unified reasoning object to the selected upstream. */
export const bifrostAdapter: ProviderAdapter = {
  ...openAiCompatibleAdapter,
  buildChatRequest(args) {
    // Bifrost does not consume Vercel's providerOptions (including thinking).
    const body = openAiCompatibleAdapter.buildChatRequest({
      ...args,
      gatewayCaching: false,
      reasoningEffort: undefined
    }) as Record<string, unknown>;
    if (args.reasoningEffort && args.reasoningEffort !== 'off') {
      body.reasoning = { effort: args.reasoningEffort };
    }
    return body;
  }
};
