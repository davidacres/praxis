import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/connection.dart';
import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/time.dart';
import '../core/workflow_runs.dart';
import 'kit.dart';
import 'wordmark.dart';

enum _SettingsPage { server, permissions, app }

const _routes = [('attention', '!', 'Attention'), ('activity', '⌁', 'Activity')];
const _settings = [
  (_SettingsPage.server, '⌁', 'Desktop connection', 'Connection and host details'),
  (_SettingsPage.permissions, '◇', 'Permissions', 'What the desktop allows this phone'),
  (_SettingsPage.app, '⚙', 'App settings', 'Appearance and notifications'),
];

({String label, Tone tone}) _connectionText(ShellConnection connection) => switch (connection) {
  ShellConnection.ready => (label: 'Connected', tone: Tone.ok),
  ShellConnection.reconnecting => (label: 'Reconnecting', tone: Tone.warn),
  ShellConnection.connecting => (label: 'Connecting', tone: Tone.warn),
  ShellConnection.pairing => (label: 'Awaiting confirmation', tone: Tone.warn),
  ShellConnection.offline => (label: 'Offline', tone: Tone.danger),
};

const _capabilityRows = [
  ('view', 'View sessions, runs and attention'),
  ('execute', 'Start and continue sessions, run workflows'),
  ('approve', 'Approve gates and answer permission requests'),
];

class AppSidebar extends StatefulWidget {
  const AppSidebar({super.key, required this.visible, required this.onClose});
  final bool visible;
  final VoidCallback onClose;

  @override
  State<AppSidebar> createState() => _AppSidebarState();
}

class _AppSidebarState extends State<AppSidebar> {
  _SettingsPage? _page;

  @override
  void didUpdateWidget(AppSidebar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.visible && _page != null) _page = null;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final media = MediaQuery.of(context);
    final width = (media.size.width * 0.88).clamp(0.0, 370.0);
    return IgnorePointer(
      ignoring: !widget.visible,
      child: AnimatedOpacity(
        opacity: widget.visible ? 1 : 0,
        duration: const Duration(milliseconds: 200),
        child: Stack(
          children: [
            Positioned.fill(
              child: Pressable(
                label: 'Close navigation',
                onTap: widget.onClose,
                excludeChildSemantics: true,
                builder: (context, _) => ColoredBox(color: p.scrim),
              ),
            ),
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              width: width,
              child: Container(
                padding: EdgeInsets.only(top: media.padding.top, bottom: media.padding.bottom),
                decoration: BoxDecoration(
                  color: p.bgSunken,
                  border: Border(right: BorderSide(color: p.borderStrong)),
                ),
                child: widget.visible
                    ? (_page != null ? _SettingsDetail(page: _page!, onBack: () => setState(() => _page = null)) : _nav(context))
                    : const SizedBox.shrink(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _nav(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;
    final stageKeys = runStageSessionKeys(store.workflowRuns);
    final chats = store.work.where((item) => item.draft || (!stageKeys.contains(item.workId) && !isStageSessionKey(item.workId, item.runId))).toList();
    final unresolved = store.attention.where((item) => !item.resolved).length;

    void navigate(String route) {
      store.setRoute(route);
      if (route != 'work') store.openWork(null);
      widget.onClose();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          constraints: const BoxConstraints(minHeight: 68),
          padding: const EdgeInsets.symmetric(horizontal: 15),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              const PraxisWordmark(width: 102, height: 32),
              const Spacer(),
              Pressable(
                label: 'Close navigation',
                onTap: widget.onClose,
                excludeChildSemantics: true,
                builder: (context, _) => SizedBox(
                  width: 32,
                  height: 32,
                  child: Center(
                    child: Text(
                      '×',
                      style: ts(context, 22, scaled: false, weight: FontWeight.w300, color: p.textDim),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 24),
            children: [
              const _SectionLabel('NAVIGATION'),
              for (final route in _routes)
                _NavRow(
                  icon: route.$2,
                  label: route.$3,
                  active: store.primaryRoute == route.$1 && store.openWorkId == null && store.openRunId == null,
                  badge: route.$1 == 'attention' && unresolved > 0 ? '$unresolved' : null,
                  onTap: () => navigate(route.$1),
                ),
              if (store.runsSupported) ...[
                _SectionHeading(
                  label: 'WORKFLOW RUNS',
                  trailing: Padding(padding: const EdgeInsets.only(top: 8, right: 8), child: _count(context, store.workflowRuns.length)),
                ),
                if (store.workflowRuns.isEmpty)
                  Padding(
                    padding: EdgeInsets.fromLTRB(t.s(8), 0, t.s(8), t.s(6)),
                    child: Text(
                      'No workflow runs in this project yet. Start one from a chat’s workflow menu or on the desktop.',
                      style: ts(context, 11, lineHeight: 16, color: p.textDim),
                    ),
                  )
                else
                  for (final run in store.workflowRuns)
                    _NavRow(
                      icon: runStatus(run).icon,
                      label: run.workflowName,
                      caption: runCaption(run),
                      active: store.openRunId == run.runId,
                      onTap: () {
                        store.openRun(run.runId);
                        widget.onClose();
                      },
                    ),
              ],
              _SectionHeading(
                label: 'SESSIONS',
                trailing: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _count(context, chats.length),
                      const SizedBox(width: 7),
                      Pressable(
                        label: 'New chat',
                        onTap: () {
                          store.startNewChat();
                          widget.onClose();
                        },
                        excludeChildSemantics: true,
                        builder: (context, pressed) => Container(
                          height: 28,
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          decoration: BoxDecoration(
                            color: pressed ? p.surfaceRaised : p.surface,
                            borderRadius: BorderRadius.circular(7),
                            border: Border.all(color: p.border),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('＋', style: ts(context, 15, scaled: false, lineHeight: 17, color: p.accent)),
                              const SizedBox(width: 4),
                              Text(
                                'New chat',
                                style: ts(context, 10, scaled: false, weight: FontWeight.w700, color: p.textSecondary),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              for (final item in chats)
                _NavRow(
                  icon: item.draft
                      ? '＋'
                      : (item.status == 'active' || item.status == 'awaiting-input')
                      ? '●'
                      : '✓',
                  label: item.title,
                  caption: item.draft
                      ? 'Draft · not sent yet'
                      : '${item.mode == 'chat' ? '' : '${item.mode[0].toUpperCase()}${item.mode.substring(1)} · '}${item.status}${item.model != null ? ' · ${item.model}' : ''}',
                  active: store.openWorkId == item.workId,
                  onTap: () {
                    store.setRoute('work');
                    store.openWork(item.workId);
                    widget.onClose();
                  },
                ),
              if (store.openWorkId != null) ...[
                const _SectionLabel('SESSION VIEWS'),
                for (final view in const [('chat', '☷'), ('progress', '◔'), ('changes', '⌁')])
                  _NavRow(
                    icon: view.$2,
                    label: '${view.$1[0].toUpperCase()}${view.$1.substring(1)}',
                    active: store.detail == view.$1,
                    onTap: () {
                      store.setRoute('work');
                      store.setDetail(view.$1);
                      widget.onClose();
                    },
                  ),
              ],
              const _SectionLabel('SETTINGS'),
              for (final item in _settings) _NavRow(icon: item.$2, label: item.$3, caption: item.$4, onTap: () => setState(() => _page = item.$1)),
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: p.border)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Local connection · Noise IK encrypted', style: ts(context, 10, scaled: false, color: p.textDim)),
              Text(store.hostInfo != null ? 'rev ${store.hostInfo!.surfaceRevision}' : 'rev 1', style: ts(context, 10, scaled: false, color: p.textDim)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _count(BuildContext context, int count) => Text('$count', style: ts(context, 10, scaled: false, color: context.p.textDim));
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(context.t.s(8), context.t.s(14), context.t.s(8), context.t.s(6)),
    child: Text(
      text,
      style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.9, color: context.p.textDim),
    ),
  );
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.label, required this.trailing});
  final String label;
  final Widget trailing;
  @override
  Widget build(BuildContext context) =>
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, crossAxisAlignment: CrossAxisAlignment.center, children: [_SectionLabel(label), trailing]);
}

class _NavRow extends StatelessWidget {
  const _NavRow({required this.icon, required this.label, this.caption, this.active = false, this.badge, required this.onTap});
  final String icon;
  final String label;
  final String? caption;
  final bool active;
  final String? badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    return Pressable(
      label: caption != null ? '$label, $caption' : label,
      selected: active,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        constraints: BoxConstraints(minHeight: t.s(47)),
        padding: EdgeInsets.symmetric(horizontal: t.s(7), vertical: t.s(6)),
        decoration: BoxDecoration(
          color: pressed
              ? p.surfaceRaised
              : active
              ? p.accentSoft
              : null,
          borderRadius: BorderRadius.circular(t.s(8)),
        ),
        child: Row(
          children: [
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: active ? p.accentMuted : p.surface, borderRadius: BorderRadius.circular(7)),
              child: Text(
                icon,
                style: ts(context, 13, scaled: false, weight: FontWeight.w700, color: active ? p.text : p.textDim),
              ),
            ),
            SizedBox(width: t.s(9)),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(context, 13, weight: FontWeight.w600, color: active ? p.text : p.textSecondary),
                  ),
                  if (caption != null) ...[
                    SizedBox(height: t.s(2)),
                    Text(
                      caption!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, 10, color: p.textDim),
                    ),
                  ],
                ],
              ),
            ),
            if (badge != null) ...[
              SizedBox(width: t.s(9)),
              Container(
                constraints: const BoxConstraints(minWidth: 20),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(color: p.warn, borderRadius: BorderRadius.circular(10)),
                child: Text(
                  badge!,
                  textAlign: TextAlign.center,
                  style: ts(context, 10, scaled: false, weight: FontWeight.w800, color: p.bgSunken),
                ),
              ),
            ],
            SizedBox(width: t.s(9)),
            Text('›', style: ts(context, 18, scaled: false, color: p.textDim)),
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow(this.label, this.value, {this.tone, this.selectable = false});
  final String label;
  final String value;
  final Tone? tone;
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final color = tone != null ? toneOf(context, tone!) : p.textSecondary;
    final valueStyle = ts(context, 12, weight: FontWeight.w600, color: color);
    return Container(
      constraints: const BoxConstraints(minHeight: 44),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
      ),
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            Expanded(
              child: Text(label, style: ts(context, 12, color: p.textSecondary)),
            ),
            const SizedBox(width: 12),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.6),
              child: selectable
                  ? SelectableText(value, textAlign: TextAlign.right, style: valueStyle)
                  : Text(value, textAlign: TextAlign.right, style: valueStyle),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailCard extends StatelessWidget {
  const _DetailCard(this.children);
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Container(
    clipBehavior: Clip.antiAlias,
    decoration: BoxDecoration(
      color: context.p.surface,
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: context.p.border),
    ),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text, {this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.symmetric(vertical: context.t.s(12), horizontal: context.t.s(4)),
    child: Text(text, style: ts(context, 11, lineHeight: 17, color: color ?? context.p.textDim)),
  );
}

class _SmallButton extends StatelessWidget {
  const _SmallButton(this.label, this.onTap);
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Pressable(
      label: label,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        constraints: const BoxConstraints(minHeight: 38),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: pressed ? p.surfaceRaised : p.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: p.border),
        ),
        child: Text(
          label,
          style: ts(context, 12, scaled: false, weight: FontWeight.w700, color: p.textSecondary),
        ),
      ),
    );
  }
}

class _SettingsDetail extends StatelessWidget {
  const _SettingsDetail({required this.page, required this.onBack});
  final _SettingsPage page;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final themeController = context.read<ThemeController>();
    final t = context.t;
    final p = t.palette;
    final title = _settings.firstWhere((item) => item.$1 == page).$3;
    final state = _connectionText(store.connection);
    final grant = store.access.value;
    String? when(String? at) => formatDayAndClock(at);

    final List<Widget> content;
    switch (page) {
      case _SettingsPage.app:
        final diagnostics = context.watch<Diagnostics>().entries;
        content = [
          const _SectionLabel('APPEARANCE'),
          _DetailCard([
            _DetailRow('Theme', t.appearance?.themeName ?? 'Praxis Dark'),
            _DetailRow('Follows', t.appearance != null ? 'The desktop' : 'Default until paired'),
          ]),
          const _Note('The phone wears the paired desktop’s theme and changes with it. Choose a theme in the desktop’s Settings → Themes.'),
          const _SectionLabel('DISPLAY SIZE'),
          Row(
            children: [
              for (final mode in const ['compact', 'large']) ...[
                if (mode == 'large') const SizedBox(width: 8),
                Expanded(
                  child: Pressable(
                    label: '${mode == 'large' ? 'Large' : 'Compact'} display size',
                    selected: t.displayMode == mode,
                    onTap: () {
                      if (themeController.applyDisplayMode(mode)) saveDisplayMode(mode);
                    },
                    excludeChildSemantics: true,
                    builder: (context, pressed) {
                      final selected = t.displayMode == mode;
                      return Container(
                        constraints: BoxConstraints(minHeight: t.s(58)),
                        padding: EdgeInsets.all(t.s(10)),
                        decoration: BoxDecoration(
                          color: pressed
                              ? p.surfaceRaised
                              : selected
                              ? p.accentSoft
                              : p.bgSunken,
                          borderRadius: BorderRadius.circular(t.s(9)),
                          border: Border.all(color: selected ? p.accent : p.border),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              mode == 'large' ? 'Large' : 'Compact',
                              style: ts(context, 13, weight: FontWeight.w700, color: selected ? p.accent : p.textSecondary),
                            ),
                            SizedBox(height: t.s(4)),
                            Text(mode == 'large' ? 'Larger text and controls' : 'Current sizing', style: ts(context, 10, color: p.textDim)),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              ],
            ],
          ),
          const _Note('Large mode increases reading size, spacing and touch targets across the mobile app. Compact keeps the current density.'),
          const _SectionLabel('NOTIFICATIONS'),
          const _DetailCard([_DetailRow('Push notifications', 'Not available'), _DetailRow('Attention while open', 'Live from the desktop')]),
          const _Note('Praxis mobile does not send notifications yet. Attention requests and session updates arrive live while the app is open and connected.'),
          const _SectionLabel('SECURITY'),
          const _DetailCard([_DetailRow('Approvals and allowing agents', 'Face ID or passcode')]),
          const _Note(
            'Approving a run, rejecting one, allowing an agent to act, or answering a question that changes something asks you to confirm it is you. One check covers a minute of decisions.',
          ),
          const _SectionLabel('DIAGNOSTICS'),
          _DetailCard([
            if (diagnostics.isEmpty) const _DetailRow('Recent problems', 'None', tone: Tone.ok),
            for (final entry in diagnostics.take(12))
              _DetailRow('${formatDayAndClock(entry.at)} · ${entry.what}', entry.message, tone: Tone.warn, selectable: true),
          ]),
          if (diagnostics.isNotEmpty) ...[const SizedBox(height: 8), _SmallButton('Clear', Diagnostics.instance.clear)],
          const _Note('Background refreshes and screens that fail are listed here, newest first. Nothing is sent anywhere.'),
        ];
      case _SettingsPage.server:
        final config = store.hostConfig;
        final info = store.hostInfo;
        content = [
          Container(
            margin: const EdgeInsets.only(bottom: 4),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: p.surface,
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: p.border),
            ),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: p.accentSoft, borderRadius: BorderRadius.circular(9)),
                  child: Text(
                    'P',
                    style: ts(context, 19, scaled: false, weight: FontWeight.w800, color: p.accent),
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        [
                          store.host.hostName,
                          config?.hostName,
                          config?.address,
                        ].firstWhere((value) => value != null && value.isNotEmpty, orElse: () => 'Desktop')!,
                        style: ts(context, 14, scaled: false, weight: FontWeight.w700),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '●  ${state.label}${store.connection == ShellConnection.ready ? ' over the local network' : ''}',
                        style: ts(context, 10, scaled: false, color: toneOf(context, state.tone)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (store.connectionIssue != null && store.connection != ShellConnection.ready) _Note(store.connectionIssue!.message, color: p.warn),
          const _SectionLabel('CONNECTION'),
          _DetailCard([
            _DetailRow('State', state.label, tone: state.tone),
            if (config != null) _DetailRow('Address', '${config.address}:${config.port}'),
            _DetailRow('Host ID', store.host.hostId.isNotEmpty ? store.host.hostId : config?.hostId ?? '—'),
            if (grant?.hostKeyFingerprint != null) _DetailRow('Host key', grant!.hostKeyFingerprint!),
            const _DetailRow('Transport', 'Noise IK, encrypted'),
            _DetailRow('Protocol', info != null ? 'v${info.protocolVersion} · revision ${info.surfaceRevision}' : 'v1 · revision 1 (older desktop)'),
            if (grant != null)
              _DetailRow(
                'Desktop access mode',
                grant.accessMode == 'local-only'
                    ? 'Local network only'
                    : grant.accessMode == 'internet'
                    ? 'Internet relay'
                    : 'Off',
                tone: grant.accessMode == 'off' ? Tone.danger : null,
              ),
          ]),
          const SizedBox(height: 12),
          Row(
            children: [
              if (store.connection != ShellConnection.ready) ...[_SmallButton('Reconnect now', store.retryConnection), const SizedBox(width: 8)],
              _SmallButton('Disconnect', () => store.disconnect()),
            ],
          ),
          const _Note('Execution stays on this desktop. The phone never receives provider credentials, repository paths or the desktop’s private key.'),
        ];
      case _SettingsPage.permissions:
        content = [
          const _Note(
            'Granted when this phone was confirmed on the desktop and enforced there on every request. Change it in Settings → Mobile access on the desktop.',
          ),
          if (store.access.status == RemoteStatus.loading || store.access.status == RemoteStatus.idle)
            const _Note('Loading this phone’s grant from the desktop…'),
          if (store.access.status == RemoteStatus.unsupported || store.access.status == RemoteStatus.error) _Note(store.access.message ?? '', color: p.warn),
          if (grant != null) ...[
            const _SectionLabel('THIS PHONE'),
            _DetailCard([
              _DetailRow('Name on desktop', grant.label ?? grant.deviceId),
              if (when(grant.pairedAt) != null) _DetailRow('Paired', when(grant.pairedAt)!),
              if (when(grant.lastSeenAt) != null) _DetailRow('Last connected', when(grant.lastSeenAt)!),
            ]),
            const _SectionLabel('REMOTE ACTIONS'),
            _DetailCard([
              for (final row in _capabilityRows)
                _DetailRow(
                  row.$2,
                  grant.capabilities.contains(row.$1) ? 'Allowed' : 'Not allowed',
                  tone: grant.capabilities.contains(row.$1) ? Tone.ok : Tone.danger,
                ),
              const _DetailRow('Shell or file access', 'Never offered to phones'),
            ]),
            const _SectionLabel('PROJECTS'),
            _DetailCard([
              if (grant.projects.isEmpty) const _DetailRow('Scope', 'All projects'),
              for (final project in grant.projects) _DetailRow(project.name, 'Granted', tone: Tone.ok),
            ]),
            const _Note('Each tool permission an agent asks for is answered once, here or on the desktop; the phone cannot grant standing permissions.'),
          ],
        ];
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          constraints: const BoxConstraints(minHeight: 60),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: p.border)),
          ),
          child: Row(
            children: [
              Pressable(
                label: 'Back to navigation',
                onTap: onBack,
                excludeChildSemantics: true,
                builder: (context, _) => Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(7)),
                  child: Transform.translate(
                    offset: const Offset(0, -2),
                    child: Text('‹', style: ts(context, 27, scaled: false, lineHeight: 28, color: p.textSecondary)),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(title, style: ts(context, 16, weight: FontWeight.w700)),
            ],
          ),
        ),
        Expanded(
          child: ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 30), children: content),
        ),
      ],
    );
  }
}
