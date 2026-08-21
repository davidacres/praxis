import {
  buildChatRequest,
  collectChatCompletion,
  postChatStream,
  resolveGatewayApiKeyFromEnv,
  resolveGatewayUrlFromEnv,
  toWireModelId,
  type GatewayOptions
} from './gateway';

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled.') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export async function runGatewayPrompt(
  prompt: string,
  options: {
    apiKey?: string;
    gatewayUrl?: string;
    systemPrompt: string;
    timeoutMs?: number;
    streamIdleTimeoutMs?: number;
    onUpdate?: (content: string) => void;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  if (options.signal?.aborted) {
    throw new AnalysisCancelledError();
  }

  const apiKey = resolveGatewayApiKeyFromEnv(options.apiKey);
  if (!apiKey) {
    throw new Error('Vercel AI Gateway API key is not configured.');
  }
  const gateway: GatewayOptions = {
    url: resolveGatewayUrlFromEnv(options.gatewayUrl),
    apiKey
  };
  const model = toWireModelId(options.model?.trim() || DEFAULT_MODEL);
  const idleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = buildChatRequest({
    modelId: model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: prompt }
    ],
    maxTokens: 8192
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
        new Error(
          `Gateway response stalled — no streaming data received for ${Math.round(idleTimeoutMs / 1000)}s.`
        )
      );
    }, idleTimeoutMs);
  };

  const idlePromise = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject;
    idleTimer = setTimeout(() => {
      reject(
        new Error(
          `Gateway response timed out after ${Math.round(timeoutMs / 1000)}s with no streaming activity.`
        )
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
      const handle = await postChatStream(gateway, body, options.signal, idleTimeoutMs);
      resetIdle();
      const result = await collectChatCompletion(handle.lines, {
        signal: options.signal,
        onTextDelta: text => {
          resetIdle();
          accumulated += text;
          options.onUpdate?.(accumulated);
        }
      });
      return result.text.trim() || accumulated.trim();
    })();

    const content = await Promise.race([streamPromise, idlePromise, abortPromise]);
    if (!content) {
      throw new Error('Vercel AI Gateway returned an empty response.');
    }
    return content;
  } finally {
    clearIdle();
  }
}
