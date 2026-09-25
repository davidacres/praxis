import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import '../core/session_options.dart';
import '../ui/kit.dart';

/// What a chat is set to run with, and whether it can change now — shared by
/// the chat screen and its picker. From `WorkDetail` in `screens/WorkScreen.tsx`.
class SelectionInfo {
  SelectionInfo(AppStore store, this.item) {
    catalog = store.providers.value;
    selection = item.draft ? effectiveSelection(catalog, item.selection ?? defaultSessionSelection, store.models[item.selection?.provider ?? '']?.value) : null;
    providerId = item.draft ? selection?.provider : item.provider;
    option = providerOption(catalog, providerId);
    providerModels = providerId != null ? store.models[providerId] : null;
    final status = store.providers.status;
    providerLabel =
        option?.label ??
        providerId ??
        (status == RemoteStatus.loading || status == RemoteStatus.idle
            ? 'Loading…'
            : status == RemoteStatus.unsupported
            ? 'Desktop default'
            : 'No provider');
    shownModel = item.draft
        ? modelLabel(providerModels?.value, selection?.model, option?.defaultModel)
        : item.model != null
        ? modelLabel(providerModels?.value, item.model)
        : 'Provider default';
    selectedModel = item.draft ? selection?.model : item.model;
    mode = item.draft ? selection?.mode ?? 'chat' : item.mode;
    canConfigure = store.hostInfo?.commandOperations.contains('sessions.configure') ?? false;
    final turnRunning = item.status == 'active' || store.followUps.any((message) => message.workId == item.workId && message.state == FollowUpState.pending);
    lockedReason = item.draft
        ? null
        : !canConfigure
        ? 'This desktop cannot change a running session’s provider or model from the phone. Update Praxis on the desktop, or start a new chat.'
        : store.connection != ShellConnection.ready
        ? 'Reconnect to the desktop to change the provider or model.'
        : turnRunning
        ? 'Wait for the current turn to finish, then change the provider, model or mode.'
        : null;
    editable = item.draft || lockedReason == null;
  }

  final WorkItem item;
  late final ProviderCatalog? catalog;
  late final SessionSelection? selection;
  late final String? providerId;
  late final ProviderOption? option;
  late final Remote<ModelCatalog>? providerModels;
  late final String providerLabel;
  late final String shownModel;
  late final String? selectedModel;
  late final String mode;
  late final bool canConfigure;
  late final String? lockedReason;
  late final bool editable;
}

/// Picks a provider or model from what the desktop reports as available.
/// Port of `screens/ProviderModelSheet.tsx` and the picker handling in `WorkScreen.tsx`.
class ProviderModelSheet extends StatefulWidget {
  const ProviderModelSheet({super.key, required this.workId, required this.kind});
  final String workId;

  /// 'provider' or 'model'.
  final String kind;

  static Future<void> show(BuildContext context, {required String workId, required String kind}) => showPraxisSheet<void>(
    context,
    maxHeightFactor: 0.78,
    builder: (_) => ProviderModelSheet(workId: workId, kind: kind),
  );

  @override
  State<ProviderModelSheet> createState() => _ProviderModelSheetState();
}

class _ProviderModelSheetState extends State<ProviderModelSheet> {
  String? _pendingHandover;
  bool _busy = false;
  String? _error;

  void _close() => Navigator.of(context).pop();

  void _apply(AppStore store, WorkItem item, {String? provider, String? model}) {
    setState(() {
      _busy = true;
      _error = null;
    });
    store
        .configureSession(item, provider: provider, model: model)
        .then((_) {
          if (mounted) _close();
        })
        .catchError((Object error) {
          if (mounted) setState(() => _error = Diagnostics.messageOf(error));
        })
        .whenComplete(() {
          if (mounted) setState(() => _busy = false);
        });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final item = store.work.where((entry) => entry.workId == widget.workId).firstOrNull;
    if (item == null) return const SizedBox.shrink();
    final info = SelectionInfo(store, item);
    final t = context.t;
    final p = t.palette;
    final catalog = info.catalog;
    final available = availableProviderOptions(catalog);
    final models = info.providerModels;
    final modelCatalog = models?.value;
    final title = widget.kind == 'model' ? 'Model · ${info.providerLabel}' : 'AI provider';
    final allowDefault = item.draft;
    final pending = _pendingHandover;
    final pendingLabel = pending == null ? '' : providerOption(catalog, pending)?.label ?? pending;

    void selectProvider(String provider) {
      if (item.draft) {
        store.updateDraftSelection(item.workId, (current) => current.copyWith(provider: provider, model: null));
        _close();
      } else if (provider == item.provider) {
        _close();
      } else {
        setState(() => _pendingHandover = provider);
      }
    }

    void selectModel(String? model) {
      if (item.draft) {
        store.updateDraftSelection(item.workId, (current) => current.copyWith(provider: info.providerId, model: model));
        _close();
      } else if (model == null || model == item.model) {
        _close();
      } else {
        _apply(store, item, model: model);
      }
    }

    final rows = <Widget>[];
    void add(Widget widget) {
      if (rows.isNotEmpty) rows.add(const SizedBox(height: 6));
      rows.add(widget);
    }

    if (widget.kind == 'provider') {
      if (store.providers.status == RemoteStatus.loading && catalog == null) add(const _StateNote('Loading providers from the desktop…', busy: true));
      if (store.providers.status == RemoteStatus.unsupported || store.providers.status == RemoteStatus.error) {
        add(_StateNote(store.providers.message ?? 'The desktop did not return its providers.', warn: true));
      }
      if (catalog != null && available.isEmpty) {
        add(const _StateNote('No AI provider is ready on the desktop. Add a key or enable a provider in Settings → AI Provider.', warn: true));
      }
      for (final option in available) {
        add(
          _OptionRow(
            title: option.label,
            caption: '${option.kind == 'cli-agent' ? 'Local agent' : 'API'}${option.provider == catalog?.defaultProvider ? ' · desktop default' : ''}',
            selected: info.providerId == option.provider,
            onTap: () => selectProvider(option.provider),
          ),
        );
      }
    } else {
      if (models == null || (models.status == RemoteStatus.loading && modelCatalog == null)) {
        add(const _StateNote('Loading models from the desktop…', busy: true));
      }
      if (models?.status == RemoteStatus.error) add(_StateNote(models!.message ?? 'The desktop did not return a model list.', warn: true));
      if (models?.status == RemoteStatus.unsupported) add(_StateNote(models!.message ?? 'Model choice needs a newer desktop.', warn: true));
      if (modelCatalog != null && modelCatalog.status != 'ok') {
        add(_StateNote(modelCatalog.message ?? 'The model list is unavailable; the provider default will be used.', warn: true));
      }
      if (modelCatalog != null && modelCatalog.status == 'ok' && modelCatalog.message != null) add(_StateNote(modelCatalog.message!));
      if (models != null && models.status != RemoteStatus.loading && allowDefault) {
        final defaultModel = modelCatalog?.defaultModel;
        add(
          _OptionRow(
            title: 'Provider default',
            caption: defaultModel != null
                ? 'Currently ${modelCatalog!.models.where((model) => model.modelId == defaultModel).map((model) => model.name).firstOrNull ?? defaultModel}'
                : 'Whatever the desktop is configured to use',
            selected: info.selectedModel == null,
            onTap: () => selectModel(null),
          ),
        );
      }
      if (modelCatalog?.status == 'ok') {
        for (final model in modelCatalog!.models) {
          final caption = [
            if (model.modelId != model.name) model.modelId,
            if (model.contextLength != null) '${(model.contextLength! / 1000).round()}k context',
          ].join(' · ');
          add(
            _OptionRow(
              title: model.name,
              caption: caption.isEmpty ? null : caption,
              selected: info.selectedModel == model.modelId,
              onTap: () => selectModel(model.modelId),
            ),
          );
        }
      }
    }

    return SheetFrame(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: ts(context, 17, scaled: false, weight: FontWeight.w700)),
                      const SizedBox(height: 3),
                      Text('Runs on the desktop. Keys and settings stay there.', style: ts(context, 10, scaled: false, color: p.textDim)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SquareIconButton(
                  label: 'Refresh from the desktop',
                  glyph: '↻',
                  onTap: () {
                    if (widget.kind == 'model' && info.providerId != null) {
                      store.loadModels(info.providerId!, refresh: true);
                    } else {
                      store.refreshProviders();
                    }
                  },
                ),
                const SizedBox(width: 8),
                SquareIconButton(label: 'Close picker', glyph: '×', onTap: _close),
              ],
            ),
          ),
          if (_error != null) _StateNote(_error!, warn: true),
          if (_busy) const _StateNote('Applying on the desktop…', busy: true),
          if (pending != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('Hand over to $pendingLabel?', style: ts(context, 15, scaled: false, weight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  Text(
                    'The desktop sends $pendingLabel a handover brief of this session (progress, changes, decisions and next steps) and starts a turn with it, using its default model. You can pick a different model afterwards. This is the same handover as on the desktop.',
                    style: ts(context, 12, scaled: false, lineHeight: 17, color: p.textDim),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      _ConfirmButton(label: 'Cancel', onTap: () => setState(() => _pendingHandover = null)),
                      const SizedBox(width: 8),
                      _ConfirmButton(
                        label: 'Hand over',
                        primary: true,
                        enabled: !_busy,
                        onTap: () => _apply(store, item, provider: pending),
                      ),
                    ],
                  ),
                ],
              ),
            )
          else
            Flexible(
              child: ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 8), children: rows),
            ),
        ],
      ),
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({required this.title, this.caption, required this.selected, required this.onTap});
  final String title;
  final String? caption;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      checked: selected,
      inMutuallyExclusiveGroup: true,
      child: Pressable(
        label: caption != null ? '$title, $caption' : title,
        button: false,
        selected: selected,
        onTap: onTap,
        excludeChildSemantics: true,
        builder: (context, pressed) => Container(
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: pressed
                ? p.surfaceRaised
                : selected
                ? p.accentSoft
                : p.surface,
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: selected ? p.accentMuted : p.border),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, 13, scaled: false, weight: FontWeight.w600),
                    ),
                    if (caption != null) ...[
                      const SizedBox(height: 3),
                      Text(caption!, style: ts(context, 11, scaled: false, lineHeight: 15, color: p.textDim)),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Opacity(
                opacity: selected ? 1 : 0,
                child: Text(
                  '✓',
                  style: ts(context, 15, scaled: false, weight: FontWeight.w700, color: p.accent),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StateNote extends StatelessWidget {
  const _StateNote(this.text, {this.busy = false, this.warn = false});
  final String text;
  final bool busy;
  final bool warn;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
    child: Row(
      children: [
        if (busy) ...[const Spinner(), const SizedBox(width: 8)],
        Expanded(
          child: Text(text, style: ts(context, 12, scaled: false, lineHeight: 17, color: warn ? context.p.warn : context.p.textDim)),
        ),
      ],
    ),
  );
}

class _ConfirmButton extends StatelessWidget {
  const _ConfirmButton({required this.label, required this.onTap, this.primary = false, this.enabled = true});
  final String label;
  final VoidCallback onTap;
  final bool primary;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Pressable(
      label: label,
      enabled: enabled,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        constraints: const BoxConstraints(minHeight: 40),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: pressed
              ? p.surfaceRaised
              : primary
              ? p.accent
              : p.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: primary ? p.accent : p.border),
        ),
        child: Text(
          label,
          style: ts(context, 13, scaled: false, weight: FontWeight.w700, color: primary ? p.onAccent : p.textSecondary),
        ),
      ),
    );
  }
}
