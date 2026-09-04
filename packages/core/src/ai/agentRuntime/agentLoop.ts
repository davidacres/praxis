import {
  assistantMessageWithToolCalls,
  toolResultMessages,
  type ChatCompletionResult,
  type ChatCompletionToolCall,
  type GatewayOptions,
  type GatewayToolDefinition,
  trimToolOutputToBudget,
  type TokenUsage,
  type WireMessage
} from '../gateway';
import type { ProviderAdapter } from '../providers/providerAdapter';
import type { AgentToolEventData } from '../agentTypes';

export type AgentLoopEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool_start'; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_complete'; callId: string; name: string; ok: boolean; content: string; data?: AgentToolEventData }
  | { type: 'step'; stepCount: number }
  /** Tokens the turn that just finished consumed, when the provider reports them. */
  | { type: 'usage'; usage: TokenUsage }
  /** Older tool output was elided to keep the conversation inside its budget. */
  | { type: 'history_trimmed'; droppedToolResults: number }
  | { type: 'completed'; text: string }
  | { type: 'error'; message: string };

export interface AgentToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; content: string; data?: AgentToolEventData }>;
}

export interface AgentLoopOptions {
  /** Provider wire adapter — the only per-provider seam in this loop. */
  adapter: ProviderAdapter;
  gateway: GatewayOptions;
  modelId: string;
  systemPrompt: string;
  tools: ReadonlyArray<GatewayToolDefinition>;
  toolExecutor: AgentToolExecutor;
  /** Prior conversation (excluding system). Used for resume. */
  history?: WireMessage[];
  /** Initial user prompt when starting a new task. Ignored when history already ends with user/tool turns. */
  userPrompt?: string;
  maxSteps?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Rough character budget for the conversation before the oldest tool output
   * is elided. A proxy for the model's context window — see
   * `trimToolOutputToBudget`. Defaults to `DEFAULT_HISTORY_BUDGET_CHARS`.
   */
  historyBudgetChars?: number;
  onEvent?: (event: AgentLoopEvent) => void;
}

/**
 * ~480k characters, very roughly 120k tokens. Deliberately generous: this is a
 * backstop against an unbounded climb, not a replacement for a model-aware
 * budget, and trimming too eagerly costs the agent context it still needs.
 */
export const DEFAULT_HISTORY_BUDGET_CHARS = 480_000;

export interface AgentLoopResult {
  status: 'completed' | 'aborted' | 'failed' | 'step_limit';
  text: string;
  history: WireMessage[];
  stepCount: number;
  error?: string;
}

function nowMs(): number {
  return Date.now();
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = options.maxSteps ?? 200;
  const timeoutMs = options.timeoutMs ?? 3 * 60 * 60 * 1000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const startedAt = nowMs();
  let lastActivity = startedAt;
  let stepCount = 0;

  const history: WireMessage[] = [...(options.history ?? [])];
  const lastHistoryRole = history.at(-1)?.role;
  if (
    options.userPrompt?.trim() &&
    (history.length === 0 || lastHistoryRole === 'assistant')
  ) {
    history.push({ role: 'user', content: options.userPrompt });
  }

  const emit = (event: AgentLoopEvent): void => {
    options.onEvent?.(event);
  };

  const isTimedOut = (): boolean => {
    const now = nowMs();
    return now - startedAt > timeoutMs || now - lastActivity > idleTimeoutMs;
  };

  const touch = (): void => {
    lastActivity = nowMs();
  };

  try {
    while (true) {
      if (options.signal?.aborted) {
        return { status: 'aborted', text: lastAssistantText(history), history, stepCount };
      }
      if (isTimedOut()) {
        const message = 'Agent loop timed out waiting for model/tool activity.';
        emit({ type: 'error', message });
        return {
          status: 'failed',
          text: lastAssistantText(history),
          history,
          stepCount,
          error: message
        };
      }

      const messages: WireMessage[] = [
        { role: 'system', content: options.systemPrompt },
        ...history
      ];
      const body = options.adapter.buildChatRequest({
        modelId: options.modelId,
        messages,
        tools: options.tools
      });

      const handle = await options.adapter.postChatStream(
        options.gateway,
        body,
        options.signal,
        idleTimeoutMs
      );
      const completion = await collectChatCompletion(options.adapter, handle.lines, {
        signal: options.signal,
        onTextDelta: text => {
          touch();
          emit({ type: 'text_delta', text });
        }
      });
      touch();

      // One turn's usage. The loop makes several turns per session when tools
      // are involved, so these accumulate downstream rather than replacing.
      if (completion.usage) {
        emit({ type: 'usage', usage: completion.usage });
      }

      if (completion.text) {
        emit({ type: 'message', text: completion.text });
      }

      if (completion.toolCalls.length === 0) {
        if (completion.text) {
          history.push({ role: 'assistant', content: completion.text });
        }
        emit({ type: 'completed', text: completion.text });
        return { status: 'completed', text: completion.text, history, stepCount };
      }

      history.push(assistantMessageWithToolCalls(completion.text, completion.toolCalls));

      const toolResults: Array<{ callId: string; content: string }> = [];
      for (const call of completion.toolCalls) {
        if (options.signal?.aborted) {
          return { status: 'aborted', text: completion.text, history, stepCount };
        }
        if (stepCount >= maxSteps) {
          const message = `Agent reached maxSteps (${maxSteps}).`;
          emit({ type: 'error', message });
          return {
            status: 'step_limit',
            text: completion.text,
            history,
            stepCount,
            error: message
          };
        }

        stepCount += 1;
        emit({ type: 'step', stepCount });
        emit({
          type: 'tool_start',
          callId: call.id,
          name: call.name,
          arguments: call.arguments
        });

        const result = await options.toolExecutor.execute(call.name, call.arguments);
        touch();
        emit({
          type: 'tool_complete',
          callId: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
          data: result.data
        });
        toolResults.push({ callId: call.id, content: result.content });
      }

      history.push(...toolResultMessages(toolResults));

      // Bound the conversation before the provider does it for us with a
      // context-length error. Only old tool output is sacrificed; the assistant
      // and user turns that carry the thread of the work are never touched.
      const budget = options.historyBudgetChars ?? DEFAULT_HISTORY_BUDGET_CHARS;
      const bounded = trimToolOutputToBudget(history, budget);
      if (bounded.trimmed > 0) {
        history.length = 0;
        history.push(...bounded.history);
        emit({ type: 'history_trimmed', droppedToolResults: bounded.trimmed });
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return { status: 'aborted', text: lastAssistantText(history), history, stepCount };
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message });
    return {
      status: 'failed',
      text: lastAssistantText(history),
      history,
      stepCount,
      error: message
    };
  }
}

/** Collect a full completion from a stream (text + tool calls) via the provider's own stream parser. */
async function collectChatCompletion(
  adapter: ProviderAdapter,
  lines: AsyncIterable<string>,
  options?: {
    signal?: AbortSignal;
    onTextDelta?: (text: string) => void;
  }
): Promise<ChatCompletionResult> {
  let final: ChatCompletionResult = { text: '', toolCalls: [] };
  for await (const event of adapter.consumeChatStream(lines, options?.signal)) {
    if (event.type === 'text_delta') {
      options?.onTextDelta?.(event.text);
    } else if (event.type === 'done') {
      final = event.result;
    }
  }
  return final;
}

function lastAssistantText(history: WireMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg?.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
  }
  return '';
}

export type { ChatCompletionToolCall, WireMessage };
