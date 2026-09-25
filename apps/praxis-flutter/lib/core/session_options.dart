import 'models.dart';

// Provider / model / mode choice for a new chat. The desktop's catalog decides
// what is selectable; the phone only narrows it. Port of
// `renderer/mobileSessionOptions.ts`.

class SessionSelection {
  const SessionSelection({this.provider, this.model, this.mode = 'chat', this.providerOption});
  final String? provider;

  /// Null means "the provider's default model".
  final String? model;
  final String mode;
  final ProviderOption? providerOption;

  SessionSelection copyWith({Object? provider = _keep, Object? model = _keep, String? mode}) => SessionSelection(
    provider: provider == _keep ? this.provider : provider as String?,
    model: model == _keep ? this.model : model as String?,
    mode: mode ?? this.mode,
  );
}

const _keep = Object();

const defaultSessionSelection = SessionSelection();

const modeLabels = {'chat': 'Chat', 'analysis': 'Analysis', 'review': 'Review'};
const modeDescriptions = {
  'chat': 'Works with the tools the desktop project allows.',
  'analysis': 'Read-only: analyses the request and proposes a plan, without changing files.',
  'review': 'Read-only: reviews the work and reports findings, without changing files.',
};

ProviderOption? providerOption(ProviderCatalog? catalog, String? provider) {
  if (provider == null || catalog == null) return null;
  for (final option in catalog.providers) {
    if (option.provider == provider) return option;
  }
  return null;
}

List<ProviderOption> availableProviderOptions(ProviderCatalog? catalog) => catalog?.providers.where((option) => option.available).toList() ?? const [];

SessionModeOption? modeOption(ProviderCatalog? catalog, String mode) {
  if (catalog == null) return null;
  for (final option in catalog.sessionModes) {
    if (option.mode == mode) return option;
  }
  return null;
}

/// The selection a draft will actually send.
SessionSelection effectiveSelection(ProviderCatalog? catalog, SessionSelection selection, [ModelCatalog? models]) {
  if (catalog == null) return selection;
  final chosen = providerOption(catalog, selection.provider);
  ProviderOption? fallback;
  for (final option in [providerOption(catalog, catalog.defaultProvider), ...availableProviderOptions(catalog)]) {
    if (option != null && option.available) {
      fallback = option;
      break;
    }
  }
  final provider = chosen != null && chosen.available ? chosen : fallback;
  final keepModel =
      provider != null &&
      selection.model != null &&
      provider.provider == selection.provider &&
      (models == null || models.provider != provider.provider || models.models.any((model) => model.modelId == selection.model));
  final mode = modeOption(catalog, selection.mode)?.available == false ? 'chat' : selection.mode;
  return SessionSelection(provider: provider?.provider, providerOption: provider, model: keepModel ? selection.model : null, mode: mode);
}

/// Whether the phone may send this selection; the desktop re-checks it regardless. Null when it may.
String? validateSelection(ProviderCatalog? catalog, SessionSelection selection, [ModelCatalog? models]) {
  if (catalog == null) return null;
  final option = providerOption(catalog, selection.provider);
  if (option == null) return 'No AI provider is available on the desktop. Set one up in Settings → AI Provider.';
  if (!option.available) return option.unavailableMessage ?? '${option.label} is not available on the desktop.';
  final mode = modeOption(catalog, selection.mode);
  if (mode != null && !mode.available) return mode.unavailableMessage ?? '${modeLabels[selection.mode]} is not available.';
  if (selection.model != null && models != null && models.provider == option.provider) {
    if (models.status != 'ok') return 'The model list for ${option.label} could not be loaded. Use the provider default.';
    if (!models.models.any((model) => model.modelId == selection.model)) {
      return '${option.label} no longer offers ${selection.model}. Choose another model.';
    }
  }
  return null;
}

String modelLabel(ModelCatalog? models, String? model, [String? fallbackDefault]) {
  String nameOf(String id) {
    for (final candidate in models?.models ?? const <ModelOption>[]) {
      if (candidate.modelId == id) return candidate.name;
    }
    return id;
  }

  if (model != null) return nameOf(model);
  final defaultModel = models?.defaultModel ?? fallbackDefault;
  return defaultModel != null ? 'Default (${nameOf(defaultModel)})' : 'Provider default';
}

Map<String, Object> selectionPayload(SessionSelection selection) => {
  if (selection.provider != null) 'provider': selection.provider!,
  if (selection.model != null) 'model': selection.model!,
  'mode': selection.mode,
};
