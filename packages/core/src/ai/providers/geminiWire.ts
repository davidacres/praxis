import {
  sanitizeToolCallId,
  type BuildChatRequestArgs,
  type ChatCompletionToolCall,
  type GatewayToolDefinition,
  type StreamChatEvent,
  type TokenUsage,
  type WireImageAttachment,
  type WireMessage
} from '../gateway/wire';
import { geminiThinkingBudget } from './reasoningSupport';

/**
 * Translation between the canonical OpenAI-shaped `WireMessage[]` `agentLoop.ts`
 * uses internally and Google Gemini's GenerateContent REST API.
 *
 * Gemini's protocol differences:
 * - System prompt is a top-level `systemInstruction` object.
 * - History uses roles 'user' and 'model'.
 * - Function calling uses `functionCall: { name, args }` in model parts.
 * - Function responses use `functionResponse: { name, response: { output } }` in user parts.
 * - Tools are declared as `tools: [{ functionDeclarations: [...] }]`.
 * - SSE streaming yields `candidates[0].content.parts[]`, with thinking tokens tagged `thought: true`.
 */

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

function imageParts(images: readonly WireImageAttachment[] | undefined): GeminiPart[] {
  return (images ?? []).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } }));
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiRequestBody {
  model?: string;
  contents: GeminiContent[];
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  tools?: Array<{
    functionDeclarations: GeminiFunctionDeclaration[];
  }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?: {
      thinkingBudget: number;
      includeThoughts: true;
    };
  };
}

function findToolNameForId(messages: readonly WireMessage[], callId: string | undefined): string {
  if (!callId) {
    return 'unknown_tool';
  }
  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      if (tc.id === callId) {
        return tc.function.name;
      }
    }
  }
  return callId;
}

/**
 * Folds `WireMessage[]` into Gemini's `contents` and `systemInstruction`.
 */
export function toGeminiContents(messages: readonly WireMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  let systemText: string | undefined;
  let startIndex = 0;

  if (messages[0]?.role === 'system') {
    systemText = typeof messages[0].content === 'string' ? messages[0].content : undefined;
    startIndex = 1;
  }

  const contents: GeminiContent[] = [];
  let i = startIndex;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'tool') {
      const parts: GeminiPart[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i];
        const toolName = findToolNameForId(messages, toolMsg.tool_call_id);
        const rawContent = toolMsg.content ?? '';
        let responseData: Record<string, unknown>;
        try {
          if (typeof rawContent === 'string' && rawContent.trim().startsWith('{')) {
            responseData = JSON.parse(rawContent) as Record<string, unknown>;
          } else {
            responseData = { output: rawContent };
          }
        } catch {
          responseData = { output: rawContent };
        }
        parts.push({
          functionResponse: {
            name: toolName,
            response: responseData
          }
        });
        i++;
      }
      contents.push({ role: 'user', parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      for (const call of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = { raw: call.function.arguments };
        }
        parts.push({
          functionCall: {
            name: call.function.name,
            args
          }
        });
      }
      contents.push({
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      });
      i++;
      continue;
    }

    // Role 'user' (system only ever appears leading, handled above)
    contents.push({
      role: 'user',
      parts: msg.images?.length
        ? [...(msg.content ? [{ text: msg.content }] : []), ...imageParts(msg.images)]
        : [{ text: msg.content ?? '' }]
    });
    i++;
  }

  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents
  };
}

export function toGeminiTools(
  tools: readonly GatewayToolDefinition[] | undefined
): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description?.trim() || tool.name,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} }
      }))
    }
  ];
}

export function buildGeminiRequest(args: BuildChatRequestArgs): GeminiRequestBody {
  const { systemInstruction, contents } = toGeminiContents(args.messages);
  const body: GeminiRequestBody = {
    model: args.modelId,
    contents
  };
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }
  const tools = toGeminiTools(args.tools);
  if (tools) {
    body.tools = tools;
  }
  const generationConfig: Record<string, unknown> = {};
  if (typeof args.temperature === 'number') {
    generationConfig.temperature = args.temperature;
  }
  if (typeof args.maxTokens === 'number') {
    generationConfig.maxOutputTokens = args.maxTokens;
  }
  const thinkingBudget = geminiThinkingBudget(args.reasoningEffort);
  if (typeof thinkingBudget === 'number') {
    generationConfig.thinkingConfig = { thinkingBudget, includeThoughts: true };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

/** Consume a Gemini GenerateContent SSE stream into structured chat events. */
export async function* consumeGeminiStream(
  lines: AsyncIterable<string>,
  signal?: AbortSignal
): AsyncGenerator<StreamChatEvent> {
  const toolCalls: ChatCompletionToolCall[] = [];
  let text = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  for await (const line of lines) {
    if (signal?.aborted) {
      break;
    }
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Extract usage if reported
    if (chunk.usageMetadata && typeof chunk.usageMetadata === 'object') {
      const u = chunk.usageMetadata as Record<string, unknown>;
      usage = {
        inputTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
        outputTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : undefined,
        totalTokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : undefined
      };
    }

    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const candidateObj = candidate as Record<string, unknown>;

      if (typeof candidateObj.finishReason === 'string') {
        finishReason = candidateObj.finishReason;
      }

      const content = candidateObj.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;

        // Handle reasoning / thinking tokens
        if (p.thought === true && typeof p.text === 'string' && p.text) {
          yield { type: 'thought_delta', text: p.text };
          continue;
        }

        // Handle normal text tokens
        if (typeof p.text === 'string' && p.text) {
          text += p.text;
          yield { type: 'text_delta', text: p.text };
        }

        // Handle function calls
        if (p.functionCall && typeof p.functionCall === 'object') {
          const fc = p.functionCall as Record<string, unknown>;
          const name = typeof fc.name === 'string' ? fc.name : 'tool';
          const args = fc.args && typeof fc.args === 'object' ? (fc.args as Record<string, unknown>) : {};
          const index = toolCalls.length;
          const callId = sanitizeToolCallId(`call_${name}_${index}`);
          toolCalls.push({
            id: callId,
            name,
            arguments: args
          });
        }
      }
    }
  }

  yield {
    type: 'done',
    result: {
      text,
      toolCalls,
      finishReason,
      usage
    }
  };
}
