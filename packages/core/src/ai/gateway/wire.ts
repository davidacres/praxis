/**
 * OpenAI-compatible chat wire format for Vercel AI Gateway.
 * Host-agnostic (no vscode imports) so this can be extracted later.
 */

export type WireRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * An image attached to a user turn — pasted or dropped into the composer.
 * Carried on the canonical `WireMessage` itself (not a separate side
 * channel) so it survives `compactHistoryForReplay` and rides along with the
 * rest of that turn's history the same way persisted text content already
 * does; each provider adapter is responsible for translating it into its own
 * wire shape, the same as it already does for `content`.
 */
export interface WireImageAttachment {
  /** e.g. `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
  mimeType: string;
  /** Base64-encoded image bytes — no `data:` prefix. */
  dataBase64: string;
}

export interface WireMessage {
  role: WireRole;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  /** Only ever populated on a `role: 'user'` message. */
  images?: WireImageAttachment[];
}

export interface GatewayToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ChatCompletionToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Tokens a turn consumed, when the provider reports them.
 *
 * Both wire formats carry this and neither is guessed at: OpenAI-compatible
 * streams send a final chunk with `usage` (the request already asks for it via
 * `stream_options.include_usage`), and Anthropic sends input tokens on
 * `message_start` and output tokens on `message_delta`. A provider that reports
 * nothing yields no usage at all rather than a zero, so "not reported" and
 * "genuinely zero" stay distinguishable.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** Fills in a total when the provider reported only the parts. */
function withDerivedTotal(usage: TokenUsage): TokenUsage {
  if (typeof usage.totalTokens === 'number') {
    return usage;
  }
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return usage;
  }
  return { ...usage, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) };
}

export interface ChatCompletionResult {
  text: string;
  toolCalls: ChatCompletionToolCall[];
  finishReason?: string;
  usage?: TokenUsage;
}

export type StreamChatEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'done'; result: ChatCompletionResult };

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function sanitizeToolCallId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toOpenAiTools(
  tools: ReadonlyArray<GatewayToolDefinition> | undefined
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const out: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> = [];

  for (const tool of tools) {
    const name = String(tool.name ?? '').trim();
    if (name.length === 0 || name.length > 64 || !TOOL_NAME_RE.test(name)) {
      continue;
    }
    const description = String(tool.description ?? '').trim();
    out.push({
      type: 'function',
      function: {
        name,
        description: description.length > 0 ? description : name,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} }
      }
    });
  }

  return out.length > 0 ? out : undefined;
}

function shouldEnableVercelAutoCaching(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('anthropic') || id.includes('claude') || id.includes('minimax');
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * A message with no images passes through unchanged (`content` stays a bare
 * string, matching every request this ever sent before images existed).
 * Only a message actually carrying `images` gets OpenAI's multipart
 * `content` array — text part first, then one `image_url` data-URL part per
 * attachment.
 */
function toOpenAiWireMessage(message: WireMessage): Record<string, unknown> {
  if (!message.images?.length) {
    return { ...message };
  }
  const parts: OpenAiContentPart[] = [];
  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }
  for (const image of message.images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } });
  }
  const { images: _images, ...rest } = message;
  return { ...rest, content: parts };
}

export interface BuildChatRequestArgs {
  modelId: string;
  messages: ReadonlyArray<WireMessage>;
  tools?: ReadonlyArray<GatewayToolDefinition>;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  /** `false` omits `stream_options.include_usage` (some OpenAI-compatible servers reject it). */
  streamUsage?: boolean;
  /** `false` withholds the Vercel-only caching hint — see `GatewayOptions.gatewayCaching`. */
  gatewayCaching?: boolean;
}

/** Build the OpenAI-compatible chat request body for the Vercel AI Gateway. */
export function buildChatRequest(args: BuildChatRequestArgs): Record<string, unknown> {
  const stream = args.stream !== false;
  const body: Record<string, unknown> = {
    model: args.modelId,
    messages: args.messages.map(toOpenAiWireMessage),
    stream,
    max_tokens: typeof args.maxTokens === 'number' ? args.maxTokens : 8192
  };

  if (stream && args.streamUsage !== false) {
    body.stream_options = { include_usage: true };
  }
  if (typeof args.temperature === 'number') {
    body.temperature = args.temperature;
  }

  const tools = toOpenAiTools(args.tools);
  if (tools) {
    body.tools = tools;
  }

  if (args.gatewayCaching !== false && shouldEnableVercelAutoCaching(args.modelId)) {
    body.providerOptions = { gateway: { caching: 'auto' } };
  }

  return body;
}

export function assistantMessageWithToolCalls(
  text: string,
  toolCalls: ReadonlyArray<ChatCompletionToolCall>
): WireMessage {
  if (toolCalls.length === 0) {
    return { role: 'assistant', content: text };
  }
  return {
    role: 'assistant',
    content: text || null,
    tool_calls: toolCalls.map(tc => ({
      id: sanitizeToolCallId(tc.id),
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments ?? {})
      }
    }))
  };
}

export function toolResultMessages(
  results: ReadonlyArray<{ callId: string; content: string }>
): WireMessage[] {
  return results.map(result => ({
    role: 'tool',
    tool_call_id: sanitizeToolCallId(result.callId),
    content: result.content
  }));
}

/**
 * Compacts a completed conversation for replay on a follow-up turn: strips the
 * tool-call round-trips (assistant `tool_calls` + their `role: 'tool'` results)
 * from earlier turns, keeping only the user/assistant text exchange. The raw
 * tool output — fetched web pages, shell logs, diffs — is what the model
 * already used to write its answer; re-sending it every turn just burns tokens.
 * An assistant message that was purely a tool call collapses away entirely.
 */
/**
 * Trims the oldest tool output when a conversation outgrows its budget.
 *
 * The turn loop appends every tool result at full size, so one large file read
 * or shell dump can dominate the prompt and, left alone, the history grows
 * until the provider rejects the turn outright. This replaces the *content* of
 * the oldest `role: 'tool'` messages with a short marker — the message itself
 * has to stay, because an assistant `tool_calls` entry without its matching
 * result is a protocol error.
 *
 * Newest results are kept: recent tool output is what the next turn reasons
 * about, and the oldest is the most likely to be spent.
 *
 * `budgetChars` is a proxy for tokens, not a token count. It only has to be in
 * the right order of magnitude to stop an unbounded climb, and it avoids
 * pulling a tokenizer into the loop.
 */
export function trimToolOutputToBudget(
  history: ReadonlyArray<WireMessage>,
  budgetChars: number
): { history: WireMessage[]; trimmed: number } {
  const total = history.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  if (total <= budgetChars) {
    return { history: [...history], trimmed: 0 };
  }

  const out = history.map(message => ({ ...message }));
  let over = total - budgetChars;
  let trimmed = 0;
  for (const message of out) {
    if (over <= 0) break;
    if (message.role !== 'tool') continue;
    const length = message.content?.length ?? 0;
    // Not worth replacing something already small.
    if (length <= ELIDED_TOOL_RESULT.length) continue;
    message.content = ELIDED_TOOL_RESULT;
    over -= length - ELIDED_TOOL_RESULT.length;
    trimmed += 1;
  }
  return { history: out, trimmed };
}

const ELIDED_TOOL_RESULT = '[earlier tool output dropped to stay within the context window]';

export function compactHistoryForReplay(history: ReadonlyArray<WireMessage>): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of history) {
    if (message.role === 'tool') continue;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      let text = (message.content ?? '').trim();
      text = text.replace(/<thought[\s\S]*?<\/thought>/gi, '').replace(/<thinking[\s\S]*?<\/thinking>/gi, '').trim();
      if (text) out.push({ role: 'assistant', content: text });
      continue;
    }
    if (message.role === 'assistant' && message.content) {
      const text = message.content.replace(/<thought[\s\S]*?<\/thought>/gi, '').replace(/<thinking[\s\S]*?<\/thinking>/gi, '').trim();
      out.push({ ...message, content: text });
      continue;
    }
    out.push(message);
  }
  return out;
}

function parseSseData(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data:')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.error || parsed.code !== undefined) {
          return parsed;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') {
    return null;
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function accumulateOpenAiToolDelta(
  deltaToolCalls: Array<Record<string, unknown>>,
  toolCalls: Map<number, ToolCallAccumulator>
): void {
  for (const tc of deltaToolCalls) {
    const index = typeof tc.index === 'number' ? tc.index : 0;
    const fn = tc.function as Record<string, unknown> | undefined;
    const existing = toolCalls.get(index) ?? { id: '', name: '', args: '' };
    if (typeof tc.id === 'string' && tc.id) {
      existing.id = tc.id;
    }
    if (fn) {
      if (typeof fn.name === 'string' && fn.name) {
        existing.name = fn.name;
      }
      if (typeof fn.arguments === 'string') {
        existing.args += fn.arguments;
      }
    }
    toolCalls.set(index, existing);
  }
}

function finalizeToolCalls(calls: Map<number, ToolCallAccumulator>): ChatCompletionToolCall[] {
  const out: ChatCompletionToolCall[] = [];
  for (const [index, tc] of calls) {
    if (!tc.name) {
      continue;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: tc.args };
    }
    out.push({
      id: sanitizeToolCallId(tc.id || `call_${tc.name}_${index}`),
      name: tc.name,
      arguments: parsed
    });
  }
  return out;
}

/**
 * Consume an OpenAI-compatible SSE line stream into structured chat events.
 * Also accepts Anthropic-style SSE tool/text deltas as a fallback.
 */
export async function* consumeChatStream(
  lines: AsyncIterable<string>,
  signal?: AbortSignal
): AsyncGenerator<StreamChatEvent> {
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let text = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  /**
   * Merges a reported figure in without letting a later absent field clear it.
   * A derived total is *not* stored, because Anthropic reports input and output
   * in different events — deriving on the first one would freeze the total at
   * the input count. Only a provider-reported total is kept; otherwise the
   * total is computed once, at the end, from the final parts.
   */
  const noteUsage = (next: TokenUsage) => {
    const merged: TokenUsage = { ...usage };
    if (typeof next.inputTokens === 'number') merged.inputTokens = next.inputTokens;
    if (typeof next.outputTokens === 'number') merged.outputTokens = next.outputTokens;
    if (typeof next.totalTokens === 'number') merged.totalTokens = next.totalTokens;
    usage = merged;
  };
  const readNumber = (source: Record<string, unknown> | undefined, key: string): number | undefined =>
    typeof source?.[key] === 'number' ? (source[key] as number) : undefined;

  for await (const line of lines) {
    if (signal?.aborted) {
      break;
    }
    const evt = parseSseData(line);
    if (!evt) {
      continue;
    }

    const rawError = evt.error ?? (evt.code && (evt.message || evt.msg) ? evt : undefined);
    if (rawError && typeof rawError === 'object') {
      const errObj = rawError as Record<string, unknown>;
      const errMsg = String(errObj.message || errObj.msg || JSON.stringify(errObj));
      const errCode = errObj.code ? ` (code ${errObj.code})` : '';
      throw new Error(`Provider error: ${errMsg}${errCode}`);
    }

    // Anthropic Messages SSE fallback
    if (typeof evt.type === 'string') {
      if (evt.type === 'message_start') {
        const message = evt.message as Record<string, unknown> | undefined;
        const reported = message?.usage as Record<string, unknown> | undefined;
        if (reported) {
          noteUsage({
            inputTokens: readNumber(reported, 'input_tokens'),
            outputTokens: readNumber(reported, 'output_tokens')
          });
        }
        continue;
      }
      if (evt.type === 'content_block_start') {
        const block = evt.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          const index = typeof evt.index === 'number' ? evt.index : toolCalls.size;
          toolCalls.set(index, {
            id: typeof block.id === 'string' ? block.id : `toolu_${index}`,
            name: typeof block.name === 'string' ? block.name : 'tool',
            args: ''
          });
        }
        continue;
      }
      if (evt.type === 'content_block_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          text += delta.text;
          yield { type: 'text_delta', text: delta.text };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = typeof evt.index === 'number' ? evt.index : 0;
          const existing = toolCalls.get(index);
          if (existing) {
            existing.args += delta.partial_json;
            yield {
              type: 'tool_call_delta',
              index,
              id: existing.id,
              name: existing.name,
              argumentsDelta: delta.partial_json
            };
          }
        }
        continue;
      }
      if (evt.type === 'message_delta') {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') {
          finishReason = delta.stop_reason;
        }
        const reported = evt.usage as Record<string, unknown> | undefined;
        if (reported) {
          noteUsage({
            inputTokens: readNumber(reported, 'input_tokens'),
            outputTokens: readNumber(reported, 'output_tokens')
          });
        }
        continue;
      }
      if (evt.type === 'message_stop' || evt.type === 'ping') {
        continue;
      }
    }

    // The final OpenAI usage chunk carries no choices, so read usage before the
    // choice guard below discards it. Support top-level usage, choice-level usage,
    // and both snake_case and camelCase field names.
    const reportedUsage = (
      evt.usage
      ?? (evt.choices as Array<Record<string, unknown>> | undefined)?.[0]?.usage
      ?? (evt.meta as Record<string, unknown> | undefined)?.usage
    ) as Record<string, unknown> | undefined;
    if (reportedUsage) {
      noteUsage({
        inputTokens: readNumber(reportedUsage, 'prompt_tokens') ?? readNumber(reportedUsage, 'promptTokens') ?? readNumber(reportedUsage, 'input_tokens'),
        outputTokens: readNumber(reportedUsage, 'completion_tokens') ?? readNumber(reportedUsage, 'completionTokens') ?? readNumber(reportedUsage, 'output_tokens'),
        totalTokens: readNumber(reportedUsage, 'total_tokens') ?? readNumber(reportedUsage, 'totalTokens')
      });
    }

    const choices = evt.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      continue;
    }
    const choiceUsage = choice.usage as Record<string, unknown> | undefined;
    if (choiceUsage) {
      noteUsage({
        inputTokens: readNumber(choiceUsage, 'prompt_tokens') ?? readNumber(choiceUsage, 'promptTokens') ?? readNumber(choiceUsage, 'input_tokens'),
        outputTokens: readNumber(choiceUsage, 'completion_tokens') ?? readNumber(choiceUsage, 'completionTokens') ?? readNumber(choiceUsage, 'output_tokens'),
        totalTokens: readNumber(choiceUsage, 'total_tokens') ?? readNumber(choiceUsage, 'totalTokens')
      });
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) {
      continue;
    }

    const reasoning = delta.reasoning_content ?? delta.thought;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      yield { type: 'thought_delta', text: reasoning };
    }

    const content = delta.content;
    if (typeof content === 'string' && content.length > 0) {
      text += content;
      yield { type: 'text_delta', text: content };
    }

    const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(deltaToolCalls)) {
      const before = new Map(toolCalls);
      accumulateOpenAiToolDelta(deltaToolCalls, toolCalls);
      for (const [index, tc] of toolCalls) {
        const prev = before.get(index);
        if (!prev || prev.id !== tc.id || prev.name !== tc.name || prev.args !== tc.args) {
          const argsDelta =
            prev && tc.args.startsWith(prev.args) ? tc.args.slice(prev.args.length) : tc.args;
          yield {
            type: 'tool_call_delta',
            index,
            id: tc.id || undefined,
            name: tc.name || undefined,
            argumentsDelta: argsDelta || undefined
          };
        }
      }
    }
  }

  yield {
    type: 'done',
    result: {
      text,
      toolCalls: finalizeToolCalls(toolCalls),
      finishReason,
      ...(usage ? { usage: withDerivedTotal(usage) } : {})
    }
  };
}

/** Collect a full completion from a stream (text + tool calls). */
export async function collectChatCompletion(
  lines: AsyncIterable<string>,
  options?: {
    signal?: AbortSignal;
    onTextDelta?: (text: string) => void;
  }
): Promise<ChatCompletionResult> {
  let final: ChatCompletionResult = { text: '', toolCalls: [] };
  for await (const event of consumeChatStream(lines, options?.signal)) {
    if (event.type === 'text_delta') {
      options?.onTextDelta?.(event.text);
    } else if (event.type === 'done') {
      final = event.result;
    }
  }
  return final;
}
