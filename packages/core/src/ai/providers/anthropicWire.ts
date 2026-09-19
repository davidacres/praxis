import {
  sanitizeToolCallId,
  type BuildChatRequestArgs,
  type ChatCompletionToolCall,
  type GatewayToolDefinition,
  type StreamChatEvent,
  type WireImageAttachment,
  type WireMessage
} from '../gateway/wire';

/**
 * Translation between the canonical OpenAI-shaped `WireMessage[]` `agentLoop.ts`
 * uses internally and Anthropic's Messages API — which has a genuinely
 * different shape: system prompt as a top-level field (not a message), tool
 * calls/results as typed content blocks instead of `tool_calls`/role:`tool`
 * messages, `input_schema` instead of nested `function.parameters`, and its
 * own SSE event names.
 */

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Anthropic recommends images precede the text that refers to them. */
function imageBlocks(images: readonly WireImageAttachment[] | undefined): AnthropicContentBlock[] {
  return (images ?? []).map(image => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 }
  }));
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * Folds the canonical `WireMessage[]` into Anthropic's message list, pulling
 * the leading system message (always present — `agentLoop.ts` prepends one
 * every turn) out into the top-level `system` field, and coalescing
 * consecutive `role: 'tool'` messages (one per tool call in a step, per
 * `toolResultMessages()`) into a single `user` turn of `tool_result` blocks,
 * since Anthropic doesn't have a separate tool-result role.
 */
function toAnthropicMessages(messages: readonly WireMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  let i = 0;
  if (messages[0]?.role === 'system') {
    system = typeof messages[0].content === 'string' ? messages[0].content : undefined;
    i = 1;
  }

  const out: AnthropicMessage[] = [];
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'tool') {
      const block: AnthropicContentBlock[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i];
        block.push({
          type: 'tool_result',
          tool_use_id: toolMsg.tool_call_id ?? '',
          content: typeof toolMsg.content === 'string' ? toolMsg.content : ''
        });
        i++;
      }
      out.push({ role: 'user', content: block });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      for (const call of msg.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          input = { raw: call.function.arguments };
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : msg.content ?? '' });
      i++;
      continue;
    }

    // 'user' (system only ever appears leading, handled above)
    if (msg.images?.length) {
      const blocks = imageBlocks(msg.images);
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      out.push({ role: 'user', content: blocks });
    } else {
      out.push({ role: 'user', content: msg.content ?? '' });
    }
    i++;
  }

  return { system, messages: out };
}

function toAnthropicTools(
  tools: readonly GatewayToolDefinition[] | undefined
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description?.trim() || tool.name,
    input_schema:
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} }
  }));
}

export function buildAnthropicRequest(args: BuildChatRequestArgs): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(args.messages);
  const body: Record<string, unknown> = {
    model: args.modelId,
    max_tokens: typeof args.maxTokens === 'number' ? args.maxTokens : 8192,
    messages,
    stream: args.stream !== false
  };
  if (system) {
    body.system = system;
  }
  if (typeof args.temperature === 'number') {
    body.temperature = args.temperature;
  }
  const tools = toAnthropicTools(args.tools);
  if (tools) {
    body.tools = tools;
  }
  return body;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
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

/** Consume an Anthropic Messages API SSE line stream into structured chat events. */
export async function* consumeAnthropicStream(
  lines: AsyncIterable<string>,
  signal?: AbortSignal
): AsyncGenerator<StreamChatEvent> {
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let text = '';
  let finishReason: string | undefined;

  for await (const line of lines) {
    if (signal?.aborted) {
      break;
    }
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload) {
      continue;
    }
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = evt.type;
    if (type === 'content_block_start') {
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
    if (type === 'content_block_delta') {
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
    if (type === 'message_delta') {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === 'string') {
        finishReason = delta.stop_reason;
      }
      continue;
    }
    // message_start / content_block_stop / message_stop / ping — nothing to do.
  }

  yield {
    type: 'done',
    result: {
      text,
      toolCalls: finalizeToolCalls(toolCalls),
      finishReason
    }
  };
}
