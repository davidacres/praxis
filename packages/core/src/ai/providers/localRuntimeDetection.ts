import type { ProviderPreset } from './providerPresets';

/** A local OpenAI-compatible runtime that answered on this machine. */
export interface LocalRuntimeDetection {
  /** The catalog preset it matches (`ollama`, `lm-studio`, …). */
  presetId: string;
  label: string;
  /** Where it answered — the preset's base URL unless overridden. */
  baseUrl: string;
  /** How many models its `/models` listed. */
  modelCount: number;
}

export type DetectFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const DETECT_TIMEOUT_MS = 700;

/**
 * Asks each local-runtime preset's `/models` whether something is listening,
 * so Add provider can offer what is already running. Only `local` presets are
 * probed (all loopback, no key), each with a short timeout, and in parallel —
 * nothing listening costs one refused connection. `origins` replaces a
 * preset's base URL (tests point it at a mock).
 */
export async function detectLocalRuntimes(
  presets: readonly ProviderPreset[],
  fetchImpl: DetectFetch,
  options: { origins?: Record<string, string>; timeoutMs?: number } = {}
): Promise<LocalRuntimeDetection[]> {
  const local = presets.filter(preset => preset.group === 'local');
  const found = await Promise.all(local.map(async preset => {
    const baseUrl = (options.origins?.[preset.id] ?? preset.baseUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DETECT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}${preset.apiPath}/models`, { signal: controller.signal });
      if (!response.ok) return undefined;
      const body = await response.json() as { data?: unknown };
      if (!body || !Array.isArray(body.data)) return undefined;
      return { presetId: preset.id, label: preset.label, baseUrl, modelCount: body.data.length } satisfies LocalRuntimeDetection;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }));
  return found.filter((entry): entry is LocalRuntimeDetection => entry !== undefined);
}
