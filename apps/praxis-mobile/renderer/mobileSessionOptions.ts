/**
 * Provider / model / mode choice for a new chat. The desktop's catalog decides
 * what is selectable; the phone only narrows it. An existing session's
 * provider, model and mode are fixed — they are what the desktop launched —
 * so they are shown, never edited.
 */
import type {
  MobileModelCatalog,
  MobileProviderCatalog,
  MobileProviderOption,
  MobileSessionMode,
  MobileSessionModeOption,
} from '@praxis/core';

export interface MobileSessionSelection {
  provider?: string;
  /** Undefined means "the provider's default model". */
  model?: string;
  mode: MobileSessionMode;
}

export const DEFAULT_SESSION_SELECTION: MobileSessionSelection = { mode: 'chat' };

export const MODE_LABELS: Record<MobileSessionMode, string> = { chat: 'Chat', analysis: 'Analysis', review: 'Review' };

export const MODE_DESCRIPTIONS: Record<MobileSessionMode, string> = {
  chat: 'Works with the tools the desktop project allows.',
  analysis: 'Read-only: analyses the request and proposes a plan, without changing files.',
  review: 'Read-only: reviews the work and reports findings, without changing files.',
};

export function providerOption(catalog: MobileProviderCatalog | undefined, provider: string | undefined): MobileProviderOption | undefined {
  return provider ? catalog?.providers.find(option => option.provider === provider) : undefined;
}

/** Providers the desktop says are both configured and enabled for new sessions. */
export function availableProviderOptions(catalog: MobileProviderCatalog | undefined): readonly MobileProviderOption[] {
  return catalog?.providers.filter(option => option.available) ?? [];
}

export function modeOption(catalog: MobileProviderCatalog | undefined, mode: MobileSessionMode): MobileSessionModeOption | undefined {
  return catalog?.sessionModes.find(option => option.mode === mode);
}

/**
 * The selection a draft will actually send: an explicit available choice, else
 * the desktop's default provider when it is available, else the first
 * available provider. A model is kept only while it belongs to that provider.
 */
export function effectiveSelection(
  catalog: MobileProviderCatalog | undefined,
  selection: MobileSessionSelection,
  models?: MobileModelCatalog,
): MobileSessionSelection & { providerOption?: MobileProviderOption } {
  if (!catalog) return selection;
  const chosen = providerOption(catalog, selection.provider);
  const fallback = [providerOption(catalog, catalog.defaultProvider), ...availableProviderOptions(catalog)].find(option => option?.available);
  const provider = chosen?.available ? chosen : fallback;
  const keepModel = provider && selection.model && provider.provider === selection.provider
    && (!models || models.provider !== provider.provider || models.models.some(model => model.modelId === selection.model));
  const mode = modeOption(catalog, selection.mode)?.available === false ? 'chat' : selection.mode;
  return {
    ...(provider ? { provider: provider.provider, providerOption: provider } : {}),
    ...(keepModel ? { model: selection.model } : {}),
    mode,
  };
}

/** Whether the phone may send this selection; the desktop re-checks it regardless. */
export function validateSelection(
  catalog: MobileProviderCatalog | undefined,
  selection: MobileSessionSelection,
  models?: MobileModelCatalog,
): { ok: true } | { ok: false; message: string } {
  if (!catalog) return { ok: true }; // An older desktop: it applies its own default provider and model.
  const option = providerOption(catalog, selection.provider);
  if (!option) return { ok: false, message: 'No AI provider is available on the desktop. Set one up in Settings → AI Provider.' };
  if (!option.available) return { ok: false, message: option.unavailableMessage ?? `${option.label} is not available on the desktop.` };
  const mode = modeOption(catalog, selection.mode);
  if (mode && !mode.available) return { ok: false, message: mode.unavailableMessage ?? `${MODE_LABELS[selection.mode]} is not available.` };
  if (selection.model && models && models.provider === option.provider) {
    if (models.status !== 'ok') return { ok: false, message: `The model list for ${option.label} could not be loaded. Use the provider default.` };
    if (!models.models.some(model => model.modelId === selection.model)) {
      return { ok: false, message: `${option.label} no longer offers ${selection.model}. Choose another model.` };
    }
  }
  return { ok: true };
}

export function modelLabel(models: MobileModelCatalog | undefined, model: string | undefined, fallbackDefault?: string): string {
  if (model) return models?.models.find(candidate => candidate.modelId === model)?.name ?? model;
  const defaultModel = models?.defaultModel ?? fallbackDefault;
  return defaultModel ? `Default (${models?.models.find(candidate => candidate.modelId === defaultModel)?.name ?? defaultModel})` : 'Provider default';
}

/** The payload fields `sessions.create` takes from a selection. */
export function selectionPayload(selection: MobileSessionSelection): { provider?: string; model?: string; mode: MobileSessionMode } {
  return {
    ...(selection.provider ? { provider: selection.provider } : {}),
    ...(selection.model ? { model: selection.model } : {}),
    mode: selection.mode,
  };
}
