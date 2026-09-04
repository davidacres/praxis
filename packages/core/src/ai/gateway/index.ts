export {
  fetchModels,
  probeApiKeyAuth,
  postChatStream,
  isRetryableGatewayHttpStatus,
  GatewayHttpError,
  type GatewayOptions,
  type RawGatewayModel,
  type ChatStreamHandle
} from './gatewayClient';

export {
  DEFAULT_VERCEL_URL,
  VERCEL_GATEWAY_PREFIX,
  defaultGatewayUrl,
  normalizeInboundModelId,
  toWireModelId,
  resolveGatewayUrlFromEnv,
  resolveGatewayApiKeyFromEnv
} from './modelIds';

export {
  buildChatRequest,
  assistantMessageWithToolCalls,
  toolResultMessages,
  compactHistoryForReplay,
  trimToolOutputToBudget,
  consumeChatStream,
  collectChatCompletion,
  sanitizeToolCallId,
  type WireMessage,
  type WireRole,
  type GatewayToolDefinition,
  type ChatCompletionToolCall,
  type ChatCompletionResult,
  type TokenUsage,
  type StreamChatEvent,
  type BuildChatRequestArgs
} from './wire';
