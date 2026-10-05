import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';

import '../app/desktop_registry.dart';
import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../ui/kit.dart';

class DesktopsScreen extends StatefulWidget {
  const DesktopsScreen({super.key});
  @override
  State<DesktopsScreen> createState() => _DesktopsScreenState();
}

class _DesktopsScreenState extends State<DesktopsScreen> {
  String? _error;

  Future<void> _run(Future<void> Function() operation) async {
    setState(() => _error = null);
    try {
      await operation();
    } catch (error) {
      if (mounted) setState(() => _error = Diagnostics.messageOf(error));
    }
  }

  Future<void> _rename(SavedDesktop entry) async {
    final name = await showPraxisSheet<String>(
      context,
      builder: (context) => _RenameDesktopSheet(entry),
    );
    if (!mounted || name == null) return;
    await _run(
      () => context.read<AppStore>().renameDesktop(entry.entryId, name),
    );
  }

  Future<void> _forget(SavedDesktop entry) async {
    final confirmed = await showPraxisSheet<bool>(
      context,
      builder: (context) => ScreenScroll(
        children: [
          H1('Forget ${entry.name}?'),
          const Body(
            'Remove this desktop and its saved preferences and drafts from this phone. Other desktops and this phone’s identity remain.',
          ),
          const Body(
            'This does not revoke the phone’s grant on the desktop. Revoke it separately in Desktop Settings → Mobile access.',
            dim: true,
          ),
          PraxisButton(
            label: 'Forget desktop',
            onPressed: () => Navigator.pop(context, true),
          ),
          PraxisButton(
            label: 'Cancel',
            ghost: true,
            onPressed: () => Navigator.pop(context, false),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    await _run(() => context.read<AppStore>().forgetDesktop(entry.entryId));
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final entries = store.desktops.entries;
    String state(SavedDesktop entry) {
      if (entry.entryId != store.desktops.activeEntryId) return 'Saved';
      return switch (store.connection) {
        ShellConnection.connecting => 'Connecting',
        ShellConnection.pairing => 'Awaiting confirmation',
        ShellConnection.ready => 'Connected',
        ShellConnection.reconnecting => 'Reconnecting',
        ShellConnection.offline =>
          store.connectionIssue == null ? 'Selected' : 'Unable to connect',
      };
    }

    return ScreenScroll(
      children: [
        const H1('Desktops'),
        const Body(
          'Your named Praxis desktops. Work keeps running when you switch.',
          dim: true,
        ),
        if (!store.registryLoaded) const Body('Loading saved desktops…'),
        if (_error ?? store.registryError case final String message)
          Body(message),
        for (final warning in store.desktops.warnings) Body(warning),
        if (store.registryError != null)
          PraxisButton(
            label: 'Retry loading desktops',
            onPressed: store.reloadDesktops,
          ),
        if (entries.isEmpty &&
            store.registryLoaded &&
            store.registryError == null)
          const Body('No saved desktops. Add one with its pairing invitation.'),
        for (final entry in entries)
          PraxisCard(
            children: [
              Text(entry.name, style: ts(context, 16, weight: FontWeight.w700)),
              Body(
                '${entry.configuration.address}:${entry.configuration.port} · ${entry.configuration.hostId}',
                dim: true,
              ),
              Body(
                '${entry.entryId == store.desktops.activeEntryId ? 'Selected · ' : ''}${state(entry)}',
                dim: true,
              ),
              if (entry.entryId == store.desktops.activeEntryId &&
                  store.connectionIssue != null)
                Body(store.connectionIssue!.message),
              if (entry.entryId == store.selectedDesktop?.entryId &&
                  store.connection == ShellConnection.ready) ...[
                if (store.projectNotice != null) Body(store.projectNotice!),
                Body('Project: ${store.project.name}', dim: true),
                for (final project in store.availableProjects)
                  PraxisButton(
                    label: 'Use project ${project.name}',
                    ghost: true,
                    disabled: project.projectId == store.project.projectId,
                    onPressed: () =>
                        _run(() => store.selectProject(project.projectId)),
                  ),
              ],
              PraxisButton(
                label:
                    entry.entryId == store.desktops.activeEntryId &&
                        store.showsWork
                    ? 'Open ${entry.name}'
                    : 'Connect to ${entry.name}',
                onPressed: () {
                  if (entry.entryId == store.desktops.activeEntryId &&
                      store.showsWork) {
                    store.desktopsVisible = false;
                    store.setRoute('work');
                  } else {
                    _run(() => store.selectDesktop(entry.entryId));
                  }
                },
              ),
              Row(
                children: [
                  Expanded(
                    child: _DesktopAction(
                      'Rename',
                      'Rename ${entry.name}',
                      () => _rename(entry),
                    ),
                  ),
                  SizedBox(width: context.t.s(6)),
                  Expanded(
                    child: _DesktopAction(
                      'Forget',
                      'Forget ${entry.name}',
                      () => _forget(entry),
                    ),
                  ),
                ],
              ),
            ],
          ),
        PraxisButton(
          label: 'Add desktop',
          disabled: !store.registryLoaded || store.registryError != null,
          onPressed: store.addDesktop,
        ),
      ],
    );
  }
}

class _RenameDesktopSheet extends StatefulWidget {
  const _RenameDesktopSheet(this.entry);
  final SavedDesktop entry;
  @override
  State<_RenameDesktopSheet> createState() => _RenameDesktopSheetState();
}

class _RenameDesktopSheetState extends State<_RenameDesktopSheet> {
  late final TextEditingController controller = TextEditingController(
    text: widget.entry.nickname ?? '',
  );
  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
    child: ScreenScroll(
      children: [
        H1('Name ${widget.entry.name}'),
        const Body(
          'A nickname is saved on this phone. Leave it empty to use the desktop’s reported name.',
          dim: true,
        ),
        Semantics(
          label: 'Desktop nickname',
          textField: true,
          child: CupertinoTextField(
            controller: controller,
            maxLength: 100,
            autofocus: true,
            style: ts(context, 14),
            placeholder:
                widget.entry.configuration.hostName ??
                widget.entry.configuration.address,
          ),
        ),
        PraxisButton(
          label: 'Save nickname',
          onPressed: () => Navigator.pop(context, controller.text),
        ),
        PraxisButton(
          label: 'Reset nickname',
          ghost: true,
          onPressed: () => Navigator.pop(context, ''),
        ),
        PraxisButton(
          label: 'Cancel',
          ghost: true,
          onPressed: () => Navigator.pop(context),
        ),
      ],
    ),
  );
}

class _DesktopAction extends StatelessWidget {
  const _DesktopAction(this.text, this.label, this.onTap);
  final String text;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Pressable(
    label: label,
    onTap: onTap,
    excludeChildSemantics: true,
    builder: (context, pressed) => Container(
      constraints: BoxConstraints(minHeight: context.t.s(44)),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: pressed ? context.p.surfaceRaised : context.p.surface,
        borderRadius: BorderRadius.circular(context.t.s(8)),
        border: Border.all(color: context.p.border),
      ),
      child: Text(text, style: ts(context, 12, weight: FontWeight.w600)),
    ),
  );
}
