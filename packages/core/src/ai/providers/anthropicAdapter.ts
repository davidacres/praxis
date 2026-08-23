import { postMessagesStream } from './anthropicClient';
import { buildAnthropicRequest, consumeAnthropicStream } from './anthropicWire';
import type { ProviderAdapter } from './providerAdapter';

export const anthropicAdapter: ProviderAdapter = {
  buildChatRequest: buildAnthropicRequest,
  postChatStream: postMessagesStream,
  consumeChatStream: consumeAnthropicStream
};
