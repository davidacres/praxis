import { postGeminiStream } from './geminiClient';
import { buildGeminiRequest, consumeGeminiStream } from './geminiWire';
import type { ProviderAdapter } from './providerAdapter';

export const geminiAdapter: ProviderAdapter = {
  buildChatRequest: buildGeminiRequest,
  postChatStream: postGeminiStream,
  consumeChatStream: consumeGeminiStream
};

