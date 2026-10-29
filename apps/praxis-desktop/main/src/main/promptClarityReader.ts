import path from 'node:path';
import { app } from 'electron';
import {
  CLARITY_CHECKLIST_VERSION,
  CLARITY_SYSTEM_PROMPT,
  buildClarityPrompt,
  clarityCacheKey,
  getProviderDescriptor,
  parseClarityAnswers,
  resolvePromptCheckProvider,
  runProviderPrompt,
  type ClarityAssessment,
  type ClarityChecklistAnswers,
  type FeedbackPriorContext,
  type RecommendationProviderChoice
} from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getAcpAgentHost, resolveAcpStartOptions } from './aiInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';

/**
 * Reads a prompt against the clarity checklist (FX-BF-112, `promptClarity.ts`).
 *
 * Answers are cached by prompt, session context, checklist version, and model
 * (`userData/prompt-clarity-cache.json`), so retained answers are reused across app restarts. Evicted entries may be
 * assessed again and fresh model answers are not guaranteed identical. Callers that must not wait (the composer while the
 * user is still typing) ask with `call: false` and get cached answers or `pending`.
 */

const CACHE_KEY = 'answers';
const MAX_CACHED = 2000;
const CALL_TIMEOUT_MS = 20_000;

type CachedAnswers = Record<string, { model: string; answers: ClarityChecklistAnswers; at: number }>;

let store: JsonKeyValueStore | undefined;
const inFlight = new Map<string, Promise<ClarityAssessment>>();

function cacheStore(): JsonKeyValueStore {
  store ??= new JsonKeyValueStore(path.join(app.getPath('userData'), 'prompt-clarity-cache.json'));
  return store;
}

async function promptCheckProvider(): Promise<RecommendationProviderChoice | undefined> {
  const choice = await resolvePromptCheckProvider(getSecretsStore(), getSettingsBackend().read().ai).catch(() => undefined);
  return choice;
}

function modelLabel(choice: RecommendationProviderChoice): string {
  const descriptor = getProviderDescriptor(choice.provider);
  return `${choice.provider}/${choice.model?.trim() || (descriptor.kind === 'api' ? descriptor.defaultModel : 'cli-default')}`;
}

async function askModel(choice: RecommendationProviderChoice, prompt: string): Promise<string> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  if (getProviderDescriptor(choice.provider).kind === 'cli-agent') {
    const settings = getSettingsBackend().read();
    return getAcpAgentHost().promptOnce(`${CLARITY_SYSTEM_PROMPT}\n\n${prompt}`, {
      ...resolveAcpStartOptions(choice.provider),
      model: choice.model,
      workingDirectory: settings.ai.workingDirectory.trim() || undefined,
      signal
    });
  }
  const { text } = await runProviderPrompt(choice.provider, prompt, {
    apiKey: choice.apiKey ?? '',
    baseUrl: choice.baseUrl,
    model: choice.model,
    systemPrompt: CLARITY_SYSTEM_PROMPT,
    timeoutMs: CALL_TIMEOUT_MS,
    signal
  });
  return text;
}

async function remember(key: string, model: string, answers: ClarityChecklistAnswers): Promise<void> {
  const cached = { ...(cacheStore().get<CachedAnswers>(CACHE_KEY) ?? {}) };
  cached[key] = { model, answers, at: Date.now() };
  const keys = Object.keys(cached);
  if (keys.length > MAX_CACHED) {
    // Drop the oldest entries; a dropped prompt is simply read again if it comes back
    for (const stale of keys.sort((a, b) => cached[a].at - cached[b].at).slice(0, keys.length - MAX_CACHED)) {
      delete cached[stale];
    }
  }
  await cacheStore().update(CACHE_KEY, cached);
}

export async function assessPromptClarity(
  promptText: string,
  priorContext: FeedbackPriorContext | undefined,
  options: { call: boolean }
): Promise<ClarityAssessment> {
  const base = { checklistVersion: CLARITY_CHECKLIST_VERSION } as const;
  const text = promptText.trim();
  if (!text) return { ...base, status: 'unavailable', reason: 'Empty prompt.' };
  const choice = await promptCheckProvider();
  if (!choice) {
    return { ...base, status: 'unavailable', reason: 'No AI provider is configured to read prompts.' };
  }
  const model = modelLabel(choice);
  const key = clarityCacheKey(text, priorContext, `${model}@${choice.baseUrl ?? 'default-endpoint'}`);
  const hit = cacheStore().get<CachedAnswers>(CACHE_KEY)?.[key];
  if (hit) {
    try {
      const answers = parseClarityAnswers(JSON.stringify(hit.answers), text, priorContext);
      return { ...base, status: 'checked', model: hit.model, cached: true, answers };
    } catch { /* A stale or damaged cache entry must be checked again. */ }
  }
  // Bound simultaneous background work across composers/drafts.
  if (!options.call) return { ...base, status: 'pending', model };
  if (inFlight.size >= 2 && !inFlight.has(key)) return { ...base, status: 'unavailable', model, reason: 'Other prompt checks are still running. Edit the draft to retry.' };

  const running = inFlight.get(key);
  if (running) return running;
  const request = (async (): Promise<ClarityAssessment> => {
    try {
      const reply = await askModel(choice, buildClarityPrompt(text, priorContext));
      const answers = parseClarityAnswers(reply, text, priorContext);
      await remember(key, model, answers);
      return { ...base, status: 'checked', model, cached: false, answers };
    } catch (error) {
      return { ...base, status: 'unavailable', model, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}
