import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/connection.dart';
import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import '../core/palette.dart';
import '../core/time.dart';
import '../core/workflow_runs.dart';
import 'app_icon.dart';
import 'kit.dart';
import 'project_switcher.dart';
import 'scheduled_runs.dart';
import 'provider_brand_logo.dart';

enum _SettingsPage { desktops, server, permissions, app }

/// Finished sessions shown before the rest fold behind "Show more", as on the desktop.
const _collapsedSessionLimit = 5;

bool _workIsLive(WorkItem item) =>
    item.draft || item.status == 'active' || item.status == 'awaiting-input';
const _settings = [
  (
    _SettingsPage.desktops,
    'server',
    'Desktops',
    'Switch or manage paired desktops',
  ),
  (
    _SettingsPage.server,
    'server',
    'Desktop connection',
    'Connection and host details',
  ),
  (
    _SettingsPage.permissions,
    'shield',
    'Permissions',
    'What the desktop allows this phone',
  ),
  (_SettingsPage.app, 'gear', 'App settings', 'Appearance and notifications'),
];

({String label, Tone tone}) _connectionText(ShellConnection connection) =>
    switch (connection) {
      ShellConnection.ready => (label: 'Connected', tone: Tone.ok),
      ShellConnection.reconnecting => (label: 'Reconnecting', tone: Tone.warn),
      ShellConnection.connecting => (label: 'Connecting', tone: Tone.warn),
      ShellConnection.pairing => (
        label: 'Awaiting confirmation',
        tone: Tone.warn,
      ),
      ShellConnection.offline => (label: 'Offline', tone: Tone.danger),
    };

const _capabilityRows = [
  ('view', 'View sessions, runs and attention'),
  ('execute', 'Start and continue sessions, run workflows'),
  ('approve', 'Approve gates and answer permission requests'),
];

class AppSidebar extends StatefulWidget {
  const AppSidebar({super.key, required this.onOpenNavigation});

  final VoidCallback onOpenNavigation;

  @override
  State<AppSidebar> createState() => _AppSidebarState();
}

class _AppSidebarState extends State<AppSidebar> {
  bool _showAllSessions = false;

  @override
  Widget build(BuildContext context) =>
      ColoredBox(color: context.p.bgSunken, child: _nav(context));

  Widget _nav(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;
    final stageKeys = runStageSessionKeys(store.workflowRuns);
    final visible = store.work
        .where(
          (item) =>
              item.draft ||
              (!stageKeys.contains(item.workId) &&
                  !isStageSessionKey(item.workId, item.runId)),
        )
        .toList();
    final allRuns = store.runsSupported
        ? store.workflowRuns
        : const <RunSnapshot>[];
    final sessions = visible;
    final runs = allRuns;
    // Live, waiting and open sessions always stay; the cap only trims the finished tail.
    final shownSessions = _showAllSessions
        ? sessions
        : [
            for (final (index, item) in sessions.indexed)
              if (index < _collapsedSessionLimit ||
                  _workIsLive(item) ||
                  store.openWorkId == item.workId)
                item,
          ];
    final hiddenSessions = sessions.length - shownSessions.length;

    void navigate(String route) {
      store.setRoute(route);
      if (route != 'work') store.openWork(null);
    }

    final projectName = store.project.name.isNotEmpty
        ? store.project.name
        : 'Praxis';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Horizon Bar: Workspace Anchor (matching EasyMode horizon-bar)
        Container(
          padding: EdgeInsets.fromLTRB(t.s(10), t.s(8), t.s(8), t.s(8)),
          decoration: BoxDecoration(
            color: p.bgSunken,
            border: Border(
              bottom: BorderSide(color: p.border.withValues(alpha: 0.7)),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  MenuButton(
                    onTap: widget.onOpenNavigation,
                    size: 30,
                    radius: 6,
                  ),
                  SizedBox(width: t.s(6)),
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: ProjectSwitcher(
                        key: ValueKey(store.contextKey),
                        compact: true,
                      ),
                    ),
                  ),
                  SizedBox(width: t.s(6)),
                  // EasyMode compact + New session button
                  Pressable(
                    label: 'New session',
                    onTap: () {
                      store.startNewChat();
                    },
                    excludeChildSemantics: true,
                    builder: (context, pressed) => Container(
                      height: t.s(24),
                      padding: EdgeInsets.symmetric(horizontal: t.s(7)),
                      decoration: BoxDecoration(
                        color: pressed ? p.surfaceRaised : p.surface,
                        borderRadius: BorderRadius.circular(t.s(4)),
                        border: Border.all(
                          color: pressed ? p.accent : p.border,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          AppIcon('plus', size: 10, color: p.text),
                          SizedBox(width: t.s(3)),
                          Text(
                            'New',
                            style: ts(
                              context,
                              10.5,
                              weight: FontWeight.w500,
                              color: p.text,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              if (store.desktopLabel.isNotEmpty &&
                  store.desktopLabel != projectName) ...[
                SizedBox(height: t.s(4)),
                Row(
                  children: [
                    Container(
                      width: 5,
                      height: 5,
                      decoration: BoxDecoration(
                        color: store.connection == ShellConnection.ready
                            ? p.ok
                            : p.warn,
                        shape: BoxShape.circle,
                      ),
                    ),
                    SizedBox(width: t.s(5)),
                    Expanded(
                      child: Text(
                        '${store.desktopLabel} · ${store.connection == ShellConnection.ready ? 'connected' : 'offline'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ts(
                          context,
                          10,
                          family: monospace,
                          color: p.textDim,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),

        // Activity at top of sidebar
        Padding(
          padding: EdgeInsets.fromLTRB(t.s(8), t.s(6), t.s(8), t.s(4)),
          child: _EasyNavRow(
            icon: 'radio-tower',
            label: 'Activity',
            active:
                store.primaryRoute == 'activity' &&
                store.openWorkId == null &&
                store.openRunId == null,
            badge: '${store.activity.length}',
            onTap: () {
              navigate('activity');
            },
          ),
        ),

        if (store.openAttention.isNotEmpty)
          Padding(
            padding: EdgeInsets.fromLTRB(t.s(8), 0, t.s(8), t.s(4)),
            child: _EasyNavRow(
              icon: 'warning',
              label: 'Attention',
              active:
                  store.primaryRoute == 'attention' &&
                  store.openWorkId == null &&
                  store.openRunId == null,
              badge: '${store.openAttention.length}',
              onTap: () => navigate('attention'),
            ),
          ),

        // Scrollable Feed
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(t.s(6), t.s(6), t.s(6), t.s(16)),
            children: [
              // Sessions Section
              _EasySectionHeader(
                title: 'SESSIONS',
                count: sessions.length,
                onAdd: () {
                  store.startNewChat();
                },
              ),
              if (sessions.isEmpty)
                Padding(
                  padding: EdgeInsets.fromLTRB(t.s(8), t.s(4), t.s(8), t.s(10)),
                  child: Text(
                    store.access.value?.projects.isNotEmpty == true
                        ? 'This phone has project-only access. Sessions require desktop-wide access in Desktop Settings → Mobile access.'
                        : 'No sessions yet. Start one with + New.',
                    style: ts(context, 11, lineHeight: 16, color: p.textDim),
                  ),
                )
              else ...[
                for (final item in shownSessions)
                  Padding(
                    padding: EdgeInsets.only(bottom: t.s(4)),
                    child: _EasyModeSessionCardWidget(
                      item: item,
                      active: store.openWorkId == item.workId,
                      onTap: () {
                        store.setRoute('work');
                        store.openWork(item.workId);
                      },
                    ),
                  ),
              ],
              if (hiddenSessions > 0 ||
                  (_showAllSessions &&
                      sessions.length > _collapsedSessionLimit))
                Pressable(
                  label: _showAllSessions
                      ? 'Show fewer sessions'
                      : 'Show $hiddenSessions more sessions',
                  onTap: () =>
                      setState(() => _showAllSessions = !_showAllSessions),
                  excludeChildSemantics: true,
                  builder: (context, pressed) => Container(
                    height: t.s(30),
                    alignment: Alignment.center,
                    child: Text(
                      _showAllSessions
                          ? 'Show fewer'
                          : 'Show $hiddenSessions more',
                      style: ts(
                        context,
                        11,
                        weight: FontWeight.w500,
                        color: pressed ? p.text : p.textDim,
                      ),
                    ),
                  ),
                ),

              Padding(
                padding: const EdgeInsets.all(8),
                child: ScheduledRunsSection(key: ValueKey(store.contextKey)),
              ),

              // Runs Section
              if (store.runsSupported) ...[
                SizedBox(height: t.s(8)),
                _EasySectionHeader(title: 'RUNS', count: runs.length),
                if (runs.isEmpty) ...[
                  if (store.workflows.isNotEmpty) ...[
                    // Compact Launchpad matching desktop EasyMode
                    Padding(
                      padding: EdgeInsets.fromLTRB(
                        t.s(6),
                        t.s(2),
                        t.s(6),
                        t.s(8),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Start a run',
                            style: ts(
                              context,
                              10,
                              weight: FontWeight.w600,
                              color: p.textDim,
                            ),
                          ),
                          SizedBox(height: t.s(4)),
                          Wrap(
                            spacing: t.s(4),
                            runSpacing: t.s(4),
                            children: [
                              for (final wf in store.workflows.take(3))
                                Pressable(
                                  label: 'Start ${wf.name}',
                                  onTap: () {
                                    store.startWorkflow(
                                      wf.workflowId,
                                      'Start ${wf.name}',
                                    );
                                  },
                                  excludeChildSemantics: true,
                                  builder: (context, pressed) => Container(
                                    padding: EdgeInsets.symmetric(
                                      horizontal: t.s(8),
                                      vertical: t.s(4),
                                    ),
                                    decoration: BoxDecoration(
                                      color: pressed
                                          ? p.surfaceRaised
                                          : p.surface,
                                      borderRadius: BorderRadius.circular(
                                        t.s(4),
                                      ),
                                      border: Border.all(color: p.border),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        AppIcon(
                                          'play',
                                          size: 9,
                                          color: p.accent,
                                        ),
                                        SizedBox(width: t.s(5)),
                                        Text(
                                          wf.name,
                                          style: ts(
                                            context,
                                            11,
                                            weight: FontWeight.w500,
                                            color: p.text,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ] else
                    Padding(
                      padding: EdgeInsets.fromLTRB(
                        t.s(8),
                        t.s(4),
                        t.s(8),
                        t.s(8),
                      ),
                      child: Text(
                        'No runs in this project yet.',
                        style: ts(
                          context,
                          11,
                          lineHeight: 16,
                          color: p.textDim,
                        ),
                      ),
                    ),
                ] else
                  for (final run in runs)
                    Padding(
                      padding: EdgeInsets.only(bottom: t.s(4)),
                      child: _EasyModeRunCardWidget(
                        run: run,
                        active: store.openRunId == run.runId,
                        onTap: () {
                          store.openRun(run.runId);
                        },
                        onSelectStageSession: (stageSessionKey) {
                          store.setRoute('work');
                          store.openWork(stageSessionKey);
                        },
                      ),
                    ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// Navigation and settings drawer, available from Home and detail headers.
class AppNavigationDrawer extends StatefulWidget {
  const AppNavigationDrawer({
    super.key,
    required this.onClose,
    required this.onGoHome,
  });

  final VoidCallback onClose;
  final VoidCallback onGoHome;

  @override
  State<AppNavigationDrawer> createState() => _AppNavigationDrawerState();
}

class _AppNavigationDrawerState extends State<AppNavigationDrawer> {
  _SettingsPage? _page;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;

    void navigate(String route) {
      store.desktopsVisible = false;
      store.openWork(null);
      store.openRun(null);
      store.setRoute(route);
      widget.onClose();
    }

    return Stack(
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
          width: (MediaQuery.sizeOf(context).width * 0.85).clamp(0.0, 340.0),
          child: ColoredBox(
            color: p.bgSunken,
            child: SafeArea(
              right: false,
              child: _page != null
                  ? _SettingsDetail(
                      page: _page!,
                      onBack: () => setState(() => _page = null),
                      onOpenDesktops: widget.onClose,
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: EdgeInsets.fromLTRB(
                            t.s(14),
                            t.s(12),
                            t.s(10),
                            t.s(12),
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Praxis',
                                  style: ts(
                                    context,
                                    17,
                                    weight: FontWeight.w700,
                                  ),
                                ),
                              ),
                              Pressable(
                                label: 'Close navigation',
                                onTap: widget.onClose,
                                excludeChildSemantics: true,
                                builder: (context, _) => SizedBox(
                                  width: t.s(32),
                                  height: t.s(32),
                                  child: Center(
                                    child: AppIcon(
                                      'close',
                                      size: 14,
                                      color: p.textSecondary,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: ListView(
                            padding: EdgeInsets.symmetric(horizontal: t.s(8)),
                            children: [
                              _EasyNavRow(
                                icon: 'folder',
                                label: 'Home',
                                onTap: widget.onGoHome,
                              ),
                              _EasyNavRow(
                                icon: 'radio-tower',
                                label: 'Activity',
                                onTap: () => navigate('activity'),
                              ),
                              _EasyNavRow(
                                icon: 'warning',
                                label: 'Attention',
                                onTap: () => navigate('attention'),
                              ),
                              _EasyNavRow(
                                icon: 'chats',
                                label: 'Sessions',
                                onTap: () => navigate('work'),
                              ),
                              if (store.runsSupported)
                                _EasyNavRow(
                                  icon: 'play',
                                  label: 'Runs',
                                  onTap: () => navigate('runs'),
                                ),
                              _EasyNavRow(
                                icon: 'server',
                                label: 'Desktops',
                                onTap: () {
                                  store.showDesktops();
                                  widget.onClose();
                                },
                              ),
                              SizedBox(height: t.s(10)),
                              const _SectionLabel('SETTINGS'),
                              for (final item in _settings.where(
                                (item) => item.$1 != _SettingsPage.desktops,
                              ))
                                _EasyNavRow(
                                  icon: item.$2,
                                  label: item.$3,
                                  caption: item.$4,
                                  drillsIn: true,
                                  onTap: () => setState(() => _page = item.$1),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
            ),
          ),
        ),
      ],
    );
  }
}

/// EasyMode Section Header with title, count badge, and compact + button.
class _EasySectionHeader extends StatelessWidget {
  const _EasySectionHeader({required this.title, this.count, this.onAdd});

  final String title;
  final int? count;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;

    return Padding(
      padding: EdgeInsets.fromLTRB(t.s(6), t.s(8), t.s(4), t.s(4)),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Text(
                title,
                style: ts(
                  context,
                  11,
                  weight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: p.textDim,
                ),
              ),
              if (count != null) ...[
                SizedBox(width: t.s(6)),
                Container(
                  padding: EdgeInsets.symmetric(
                    horizontal: t.s(6),
                    vertical: t.s(1),
                  ),
                  decoration: BoxDecoration(
                    color: p.bgSunken,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    '$count',
                    style: ts(context, 10, scaled: false, color: p.textDim),
                  ),
                ),
              ],
            ],
          ),
          if (onAdd != null)
            Pressable(
              label: 'Add $title',
              onTap: onAdd,
              excludeChildSemantics: true,
              builder: (context, pressed) => Container(
                width: t.s(22),
                height: t.s(22),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: pressed ? p.surfaceRaised : Colors.transparent,
                  borderRadius: BorderRadius.circular(t.s(4)),
                ),
                child: AppIcon('plus', size: 11, color: p.textDim),
              ),
            ),
        ],
      ),
    );
  }
}

/// Session Card redesigned in EasyMode visual language:
/// Rounded corners (6px), subtle hover/selected states, status dot/glyph, AI provider icon,
/// status badge label, title, and warning tone Action Gate callout when waiting for input.
class _EasyModeSessionCardWidget extends StatelessWidget {
  const _EasyModeSessionCardWidget({
    required this.item,
    required this.active,
    required this.onTap,
  });

  final WorkItem item;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;

    final isRunning =
        item.status == 'active' ||
        item.status == 'executing' ||
        item.status == 'planning';
    final isGate =
        item.status == 'awaiting-input' || item.status == 'awaiting_approval';
    final isDone = item.status == 'completed' || item.status == 'finished';
    final isFailed = item.status == 'failed' || item.status == 'aborted';

    // Status glyph indicator (positioned on the right)
    Widget statusIndicator;
    if (item.draft) {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(child: AppIcon('plus', size: 10, color: p.textDim)),
      );
    } else if (isRunning) {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(
          child: Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              color: p.accent,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: p.accent.withValues(alpha: 0.6),
                  blurRadius: 4,
                  spreadRadius: 1,
                ),
              ],
            ),
          ),
        ),
      );
    } else if (isGate) {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(
          child: AppIcon('warning', size: 11, color: p.warn, strokeWidth: 1.4),
        ),
      );
    } else if (isDone) {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(
          child: AppIcon('check', size: 11, color: p.ok, strokeWidth: 1.6),
        ),
      );
    } else if (isFailed) {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(
          child: AppIcon('close', size: 11, color: p.danger, strokeWidth: 1.5),
        ),
      );
    } else {
      statusIndicator = SizedBox(
        width: 14,
        height: 14,
        child: Center(
          child: Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: p.textDim, shape: BoxShape.circle),
          ),
        ),
      );
    }

    final provider = item.provider;
    final model = item.model;
    final hasAiSubtitle =
        (provider != null && provider.isNotEmpty) ||
        (model != null && model.isNotEmpty);

    return Pressable(
      label:
          '${item.title}, ${item.status}${provider != null ? ', $provider' : ''}${model != null ? ', $model' : ''}',
      selected: active,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        padding: EdgeInsets.symmetric(horizontal: t.s(6), vertical: t.s(5)),
        decoration: BoxDecoration(
          color: active
              ? (p.dark ? Colors.white.withValues(alpha: 0.15) : p.accentSoft)
              : pressed
              ? p.surfaceRaised
              : Colors.transparent,
          borderRadius: BorderRadius.circular(t.s(5)),
          border: Border.all(
            color: active
                ? p.accent.withValues(alpha: 0.4)
                : pressed
                ? p.border
                : Colors.transparent,
          ),
          boxShadow: active
              ? [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.15),
                    blurRadius: 3,
                    offset: const Offset(0, 1),
                  ),
                ]
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                // Session icon on the left
                SizedBox(
                  width: 14,
                  height: 14,
                  child: Center(
                    child: AppIcon(
                      'chats',
                      size: 11.5,
                      color: active ? p.accent : p.textDim,
                    ),
                  ),
                ),
                SizedBox(width: t.s(6)),
                // Title
                Expanded(
                  child: Text(
                    item.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(
                      context,
                      12.5,
                      weight: active ? FontWeight.w600 : FontWeight.w500,
                      color: active ? p.text : p.textSecondary,
                    ),
                  ),
                ),
                SizedBox(width: t.s(6)),
                // Status icon on the right
                statusIndicator,
              ],
            ),
            if (isGate)
              Padding(
                padding: EdgeInsets.only(left: t.s(20), top: t.s(4)),
                child: Text('Action required', style: ts(context, 11, color: p.warn)),
              ),
            if ((isRunning || isGate) && item.latestActivity?.isNotEmpty == true)
              Padding(
                padding: EdgeInsets.only(left: t.s(20), top: t.s(4)),
                child: Text(item.latestActivity!, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: ts(context, 11, color: p.textDim)),
              ),
            // AI Provider and Model on a new line below title
            if (hasAiSubtitle) ...[
              SizedBox(height: t.s(3)),
              Padding(
                padding: EdgeInsets.only(left: 20),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (provider != null && provider.isNotEmpty) ...[
                      Container(
                        padding: EdgeInsets.all(t.s(1.5)),
                        decoration: BoxDecoration(
                          color: p.bgSunken,
                          borderRadius: BorderRadius.circular(t.s(3)),
                          border: Border.all(
                            color: p.border.withValues(alpha: 0.5),
                          ),
                        ),
                        child: ProviderBrandLogo(provider: provider, size: 10),
                      ),
                      SizedBox(width: t.s(4)),
                    ],
                    if (model != null && model.isNotEmpty)
                      Flexible(
                        child: Text(
                          model,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(
                            context,
                            10,
                            scaled: false,
                            family: monospace,
                            color: active ? p.textSecondary : p.textDim,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// EasyMode Automation/Run card widget matching desktop styling with pipeline gauge & expandable stages.
class _EasyModeRunCardWidget extends StatefulWidget {
  const _EasyModeRunCardWidget({
    required this.run,
    required this.active,
    required this.onTap,
    this.onSelectStageSession,
  });

  final RunSnapshot run;
  final bool active;
  final VoidCallback onTap;
  final void Function(String sessionKey)? onSelectStageSession;

  @override
  State<_EasyModeRunCardWidget> createState() => _EasyModeRunCardWidgetState();
}

class _EasyModeRunCardWidgetState extends State<_EasyModeRunCardWidget> {
  bool? _manuallyExpanded;

  String _stageLaneLabel(String lane) {
    return switch (lane) {
      'idle' => 'Pending',
      'ready' => 'Ready',
      'running' => 'Running',
      'awaiting' => 'Needs review',
      'done' => 'Completed',
      'failed' => 'Failed',
      'skipped' => 'Skipped',
      'paused' => 'Paused',
      _ => lane,
    };
  }

  String _gaugeGlyph(String lane) {
    return switch (lane) {
      'done' => '✓',
      'running' => '●',
      'awaiting' => '!',
      'failed' => '✕',
      'skipped' => '–',
      _ => '○',
    };
  }

  Color _gaugeSegmentColor(String lane, Palette p) {
    return switch (lane) {
      'done' => p.ok,
      'running' => p.accent,
      'awaiting' => p.warn,
      'failed' => p.danger,
      'skipped' => p.border,
      _ => p.borderStrong.withValues(alpha: 0.4),
    };
  }

  Color _stageDotColor(String lane, Palette p) {
    return switch (lane) {
      'done' => p.ok,
      'running' => p.accent,
      'awaiting' || 'paused' => p.warn,
      'failed' => p.danger,
      _ => p.textDim,
    };
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final run = widget.run;

    final info = runStatus(run);
    final isRunning = run.status == 'running';
    final isGate = run.status == 'awaiting-approval';
    final hasStages = run.stages.isNotEmpty;

    final activeStage = run.stages
        .where((s) => s.lane == 'running' || s.lane == 'awaiting')
        .firstOrNull;
    final isExpanded =
        _manuallyExpanded ?? (isRunning || isGate || widget.active);

    final provider = run.aiProvider;
    final hasAiSubtitle = provider != null && provider.isNotEmpty;

    return Container(
      decoration: BoxDecoration(
        color: widget.active
            ? (p.dark
                  ? Colors.white.withValues(alpha: 0.08)
                  : p.accentSoft.withValues(alpha: 0.5))
            : Colors.transparent,
        borderRadius: BorderRadius.circular(t.s(5)),
        border: Border.all(
          color: widget.active
              ? p.accent.withValues(alpha: 0.3)
              : Colors.transparent,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Pressable(
            label: '${run.workflowName}, ${run.status}',
            selected: widget.active,
            onTap: widget.onTap,
            excludeChildSemantics: true,
            builder: (context, pressed) => Container(
              padding: EdgeInsets.symmetric(
                horizontal: t.s(6),
                vertical: t.s(5),
              ),
              decoration: BoxDecoration(
                color: pressed ? p.surfaceRaised : Colors.transparent,
                borderRadius: BorderRadius.circular(t.s(5)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      // Automation icon on the left
                      SizedBox(
                        width: 14,
                        height: 14,
                        child: Center(
                          child: AppIcon('play', size: 11, color: p.accent),
                        ),
                      ),
                      SizedBox(width: t.s(6)),
                      // Workflow Name
                      Expanded(
                        child: Text(
                          run.workflowName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(
                            context,
                            12.5,
                            weight: widget.active
                                ? FontWeight.w600
                                : FontWeight.w500,
                            color: widget.active ? p.text : p.textSecondary,
                          ),
                        ),
                      ),
                      if (activeStage != null && !isGate) ...[
                        SizedBox(width: t.s(4)),
                        Container(
                          padding: EdgeInsets.symmetric(
                            horizontal: t.s(4),
                            vertical: t.s(1),
                          ),
                          decoration: BoxDecoration(
                            color: p.accent.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(t.s(3)),
                          ),
                          child: Text(
                            activeStage.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ts(
                              context,
                              9,
                              scaled: false,
                              weight: FontWeight.w600,
                              color: p.accent,
                            ),
                          ),
                        ),
                      ],
                      if (hasStages) ...[
                        SizedBox(width: t.s(2)),
                        Pressable(
                          label: isExpanded ? 'Hide stages' : 'Show stages',
                          onTap: () =>
                              setState(() => _manuallyExpanded = !isExpanded),
                          excludeChildSemantics: true,
                          builder: (context, expandPressed) => Container(
                            width: t.s(18),
                            height: t.s(18),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: expandPressed
                                  ? p.surfaceRaised
                                  : Colors.transparent,
                              borderRadius: BorderRadius.circular(t.s(3)),
                            ),
                            child: AppIcon(
                              isExpanded ? 'chevron-down' : 'chevron-right',
                              size: 11,
                              color: p.textDim,
                              strokeWidth: 1.4,
                            ),
                          ),
                        ),
                      ],
                      SizedBox(width: t.s(4)),
                      // Status glyph on the right (shows warning glyph when gate)
                      SizedBox(
                        width: 14,
                        height: 14,
                        child: Center(
                          child: isGate
                              ? AppIcon(
                                  'warning',
                                  size: 11,
                                  color: p.warn,
                                  strokeWidth: 1.4,
                                )
                              : isRunning
                              ? Container(
                                  width: 7,
                                  height: 7,
                                  decoration: BoxDecoration(
                                    color: p.accent,
                                    shape: BoxShape.circle,
                                    boxShadow: [
                                      BoxShadow(
                                        color: p.accent.withValues(alpha: 0.6),
                                        blurRadius: 4,
                                        spreadRadius: 1,
                                      ),
                                    ],
                                  ),
                                )
                              : run.status == 'succeeded'
                              ? AppIcon(
                                  'check',
                                  size: 11,
                                  color: p.ok,
                                  strokeWidth: 1.6,
                                )
                              : run.status == 'failed'
                              ? AppIcon(
                                  'close',
                                  size: 11,
                                  color: p.danger,
                                  strokeWidth: 1.5,
                                )
                              : Container(
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    color: p.textDim,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                        ),
                      ),
                    ],
                  ),
                  if (hasAiSubtitle) ...[
                    SizedBox(height: t.s(3)),
                    Padding(
                      padding: const EdgeInsets.only(left: 20),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            padding: EdgeInsets.all(t.s(1.5)),
                            decoration: BoxDecoration(
                              color: p.bgSunken,
                              borderRadius: BorderRadius.circular(t.s(3)),
                              border: Border.all(
                                color: p.border.withValues(alpha: 0.5),
                              ),
                            ),
                            child: ProviderBrandLogo(
                              provider: provider,
                              size: 10,
                            ),
                          ),
                          SizedBox(width: t.s(4)),
                          Text(
                            provider,
                            style: ts(
                              context,
                              10,
                              scaled: false,
                              color: p.textDim,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),

          // Segmented Pipeline Gauge Rail (matching desktop EasyMode gauge)
          if (hasStages) ...[
            Container(
              margin: EdgeInsets.symmetric(
                horizontal: t.s(6),
                vertical: t.s(2),
              ),
              padding: EdgeInsets.all(t.s(5)),
              decoration: BoxDecoration(
                color: p.bgSunken,
                borderRadius: BorderRadius.circular(t.s(4)),
                border: Border.all(color: p.border.withValues(alpha: 0.4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Segmented bar
                  Row(
                    children: [
                      for (var i = 0; i < run.stages.length; i++) ...[
                        if (i > 0) SizedBox(width: t.s(3)),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Container(
                                height: t.s(3.5),
                                decoration: BoxDecoration(
                                  color: _gaugeSegmentColor(
                                    run.stages[i].lane,
                                    p,
                                  ),
                                  borderRadius: BorderRadius.circular(2),
                                ),
                              ),
                              if (run.stages.length <= 4) ...[
                                SizedBox(height: t.s(3)),
                                Row(
                                  children: [
                                    Text(
                                      _gaugeGlyph(run.stages[i].lane),
                                      style: ts(
                                        context,
                                        8,
                                        scaled: false,
                                        weight: FontWeight.w700,
                                        color: _stageDotColor(
                                          run.stages[i].lane,
                                          p,
                                        ),
                                      ),
                                    ),
                                    SizedBox(width: t.s(2)),
                                    Expanded(
                                      child: Text(
                                        run.stages[i].name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: ts(
                                          context,
                                          9,
                                          scaled: false,
                                          weight:
                                              run.stages[i].lane == 'running' ||
                                                  run.stages[i].lane ==
                                                      'awaiting'
                                              ? FontWeight.w600
                                              : FontWeight.w400,
                                          color:
                                              run.stages[i].lane == 'running' ||
                                                  run.stages[i].lane ==
                                                      'awaiting'
                                              ? p.text
                                              : p.textDim,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                  SizedBox(height: t.s(4)),
                  // Gauge Meta Row
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (activeStage != null) ...[
                              Container(
                                width: 5,
                                height: 5,
                                decoration: BoxDecoration(
                                  color: p.accent,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              SizedBox(width: t.s(4)),
                              Flexible(
                                child: Text(
                                  '${run.stages.indexOf(activeStage) + 1}/${run.stages.length} ${activeStage.name}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ts(
                                    context,
                                    10,
                                    scaled: false,
                                    weight: FontWeight.w500,
                                    color: p.text,
                                  ),
                                ),
                              ),
                            ] else if (run.status == 'succeeded') ...[
                              AppIcon(
                                'check',
                                size: 10,
                                color: p.ok,
                                strokeWidth: 1.6,
                              ),
                              SizedBox(width: t.s(4)),
                              Text(
                                'All ${run.stages.length} stages completed',
                                style: ts(
                                  context,
                                  10,
                                  scaled: false,
                                  color: p.textDim,
                                ),
                              ),
                            ] else ...[
                              Text(
                                '${run.stages.length} stages · ${info.label}',
                                style: ts(
                                  context,
                                  10,
                                  scaled: false,
                                  color: p.textDim,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      Text(
                        '${run.stages.where((s) => s.lane == 'done').length}/${run.stages.length}',
                        style: ts(
                          context,
                          9.5,
                          scaled: false,
                          family: monospace,
                          color: p.textDim,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],

          // Nested Stage Rows (expandable, matching EasyMode .easymode-automation-stages)
          if (hasStages && isExpanded) ...[
            Container(
              margin: EdgeInsets.fromLTRB(t.s(6), 0, t.s(6), t.s(3)),
              padding: EdgeInsets.symmetric(
                horizontal: t.s(4),
                vertical: t.s(2),
              ),
              decoration: BoxDecoration(
                color: p.bgSunken.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(t.s(4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final stage in run.stages) ...[
                    Pressable(
                      label:
                          'Stage ${stage.name}, ${_stageLaneLabel(stage.lane)}',
                      onTap: () {
                        if (stage.sessionKey != null &&
                            widget.onSelectStageSession != null) {
                          widget.onSelectStageSession!(stage.sessionKey!);
                        } else {
                          widget.onTap();
                        }
                      },
                      excludeChildSemantics: true,
                      builder: (context, stagePressed) => Container(
                        padding: EdgeInsets.symmetric(
                          horizontal: t.s(5),
                          vertical: t.s(2.5),
                        ),
                        decoration: BoxDecoration(
                          color: stagePressed
                              ? p.surfaceRaised
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(t.s(3)),
                        ),
                        child: Row(
                          children: [
                            Container(
                              width: 5,
                              height: 5,
                              decoration: BoxDecoration(
                                color: _stageDotColor(stage.lane, p),
                                shape: BoxShape.circle,
                              ),
                            ),
                            if (stage.provider != null &&
                                stage.provider!.isNotEmpty) ...[
                              SizedBox(width: t.s(4)),
                              ProviderBrandLogo(
                                provider: stage.provider!,
                                size: 10,
                              ),
                            ],
                            SizedBox(width: t.s(5)),
                            Expanded(
                              child: Text(
                                stage.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ts(
                                  context,
                                  10.5,
                                  weight:
                                      stage.lane == 'running' ||
                                          stage.lane == 'awaiting'
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                  color:
                                      stage.lane == 'running' ||
                                          stage.lane == 'awaiting'
                                      ? p.text
                                      : p.textSecondary,
                                ),
                              ),
                            ),
                            SizedBox(width: t.s(4)),
                            SizedBox(
                              width: 12,
                              height: 12,
                              child: Center(
                                child: stage.lane == 'done'
                                    ? AppIcon(
                                        'check',
                                        size: 9.5,
                                        color: p.ok,
                                        strokeWidth: 1.6,
                                      )
                                    : stage.lane == 'running'
                                    ? Container(
                                        width: 5,
                                        height: 5,
                                        decoration: BoxDecoration(
                                          color: p.accent,
                                          shape: BoxShape.circle,
                                        ),
                                      )
                                    : stage.lane == 'awaiting'
                                    ? AppIcon(
                                        'warning',
                                        size: 9.5,
                                        color: p.warn,
                                        strokeWidth: 1.4,
                                      )
                                    : stage.lane == 'failed'
                                    ? AppIcon(
                                        'close',
                                        size: 9.5,
                                        color: p.danger,
                                        strokeWidth: 1.5,
                                      )
                                    : Container(
                                        width: 5,
                                        height: 5,
                                        decoration: BoxDecoration(
                                          border: Border.all(
                                            color: p.borderStrong,
                                            width: 1.1,
                                          ),
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Navigation row styled cleanly in EasyMode fashion.
class _EasyNavRow extends StatelessWidget {
  const _EasyNavRow({
    required this.icon,
    required this.label,
    this.caption,
    this.active = false,
    this.badge,
    this.drillsIn = false,
    required this.onTap,
  });

  final String icon;
  final String label;
  final String? caption;
  final bool active;
  final String? badge;
  final bool drillsIn;
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
        constraints: BoxConstraints(minHeight: t.s(36)),
        padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: t.s(6)),
        decoration: BoxDecoration(
          color: active
              ? (p.dark ? Colors.white.withValues(alpha: 0.12) : p.accentSoft)
              : pressed
              ? p.surfaceRaised
              : Colors.transparent,
          borderRadius: BorderRadius.circular(t.s(6)),
          border: Border.all(
            color: active
                ? p.accent.withValues(alpha: 0.35)
                : Colors.transparent,
          ),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 20,
              child: Center(
                child: AppIcon(
                  icon,
                  size: 13,
                  color: active ? p.accent : p.textDim,
                  strokeWidth: 1.3,
                ),
              ),
            ),
            SizedBox(width: t.s(8)),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(
                      context,
                      13,
                      weight: active ? FontWeight.w600 : FontWeight.w500,
                      color: active ? p.text : p.textSecondary,
                    ),
                  ),
                  if (caption != null) ...[
                    SizedBox(height: t.s(1)),
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
              SizedBox(width: t.s(6)),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: p.warn,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  badge!,
                  style: ts(
                    context,
                    10,
                    scaled: false,
                    weight: FontWeight.w700,
                    color: p.bgSunken,
                  ),
                ),
              ),
            ],
            if (drillsIn) ...[
              SizedBox(width: t.s(6)),
              Text(
                '›',
                style: ts(context, 16, scaled: false, color: p.textDim),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      context.t.s(6),
      context.t.s(10),
      context.t.s(6),
      context.t.s(4),
    ),
    child: Text(
      text,
      style: ts(
        context,
        10,
        weight: FontWeight.w700,
        letterSpacing: 0.6,
        color: context.p.textDim,
      ),
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow(
    this.label,
    this.value, {
    this.tone,
    this.selectable = false,
  });
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
              child: Text(
                label,
                style: ts(context, 12, color: p.textSecondary),
              ),
            ),
            const SizedBox(width: 12),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.6),
              child: selectable
                  ? SelectableText(
                      value,
                      textAlign: TextAlign.right,
                      style: valueStyle,
                    )
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
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text, {this.color});
  final String text;
  final Color? color;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.symmetric(
      vertical: context.t.s(12),
      horizontal: context.t.s(4),
    ),
    child: Text(
      text,
      style: ts(context, 11, lineHeight: 17, color: color ?? context.p.textDim),
    ),
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
          style: ts(
            context,
            12,
            scaled: false,
            weight: FontWeight.w700,
            color: p.textSecondary,
          ),
        ),
      ),
    );
  }
}

class _SettingsDetail extends StatelessWidget {
  const _SettingsDetail({
    required this.page,
    required this.onBack,
    required this.onOpenDesktops,
  });
  final _SettingsPage page;
  final VoidCallback onBack;
  final VoidCallback onOpenDesktops;

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
            _DetailRow(
              'Follows',
              t.appearance != null ? 'The desktop' : 'Default until paired',
            ),
          ]),
          const _Note(
            'The phone wears the paired desktop’s theme and changes with it. Choose a theme in the desktop’s Settings → Themes.',
          ),
          const _SectionLabel('DISPLAY SIZE'),
          Row(
            children: [
              for (final mode in const ['compact', 'large']) ...[
                if (mode == 'large') const SizedBox(width: 8),
                Expanded(
                  child: Pressable(
                    label:
                        '${mode == 'large' ? 'Large' : 'Compact'} display size',
                    selected: t.displayMode == mode,
                    onTap: () {
                      if (themeController.applyDisplayMode(mode)) {
                        saveDisplayMode(mode);
                      }
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
                          border: Border.all(
                            color: selected ? p.accent : p.border,
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              mode == 'large' ? 'Large' : 'Compact',
                              style: ts(
                                context,
                                13,
                                weight: FontWeight.w700,
                                color: selected ? p.accent : p.textSecondary,
                              ),
                            ),
                            SizedBox(height: t.s(4)),
                            Text(
                              mode == 'large'
                                  ? 'Larger text and controls'
                                  : 'Current sizing',
                              style: ts(context, 10, color: p.textDim),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
              ],
            ],
          ),
          const _Note(
            'Large mode increases reading size, spacing and touch targets across the mobile app. Compact keeps the current density.',
          ),
          const _SectionLabel('NOTIFICATIONS'),
          const _DetailCard([
            _DetailRow('Push notifications', 'Not available'),
            _DetailRow('Attention while open', 'Live from the desktop'),
          ]),
          const _Note(
            'Praxis mobile does not send notifications yet. Attention requests and session updates arrive live while the app is open and connected.',
          ),
          const _SectionLabel('SECURITY'),
          const _DetailCard([
            _DetailRow('Approvals and allowing agents', 'Face ID or passcode'),
          ]),
          const _Note(
            'Approving a run, rejecting one, allowing an agent to act, or answering a question that changes something asks you to confirm it is you. One check covers a minute of decisions.',
          ),
          const _SectionLabel('DESKTOPS'),
          _DetailCard([
            _DetailRow('Active desktop', store.desktopLabel),
            _DetailRow(
              'Saved desktops',
              '${store.desktops.entries.length} paired',
            ),
          ]),
          const SizedBox(height: 8),
          _SmallButton('Manage desktops', () {
            store.showDesktops();
            onOpenDesktops();
          }),
          const _SectionLabel('DIAGNOSTICS'),
          _DetailCard([
            if (diagnostics.isEmpty)
              const _DetailRow('Recent problems', 'None', tone: Tone.ok),
            for (final entry in diagnostics.take(12))
              _DetailRow(
                '${formatDayAndClock(entry.at)} · ${entry.what}',
                entry.message,
                tone: Tone.warn,
                selectable: true,
              ),
          ]),
          if (diagnostics.isNotEmpty) ...[
            const SizedBox(height: 8),
            _SmallButton('Clear', Diagnostics.instance.clear),
          ],
          const _Note(
            'Background refreshes and screens that fail are listed here, newest first. Nothing is sent anywhere.',
          ),
        ];
      case _SettingsPage.desktops:
        content = [
          const _Note('Switch, rename or forget paired desktops.'),
          const SizedBox(height: 12),
          _SmallButton('Open Desktops', () {
            store.showDesktops();
            onOpenDesktops();
          }),
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
                  decoration: BoxDecoration(
                    color: p.accentSoft,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Text(
                    'P',
                    style: ts(
                      context,
                      19,
                      scaled: false,
                      weight: FontWeight.w800,
                      color: p.accent,
                    ),
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        [
                          store.desktopLabel,
                          config?.hostName,
                          config?.address,
                        ].firstWhere(
                          (value) => value != null && value.isNotEmpty,
                          orElse: () => 'Desktop',
                        )!,
                        style: ts(
                          context,
                          14,
                          scaled: false,
                          weight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '●  ${state.label}${store.connection == ShellConnection.ready ? ' over the local network' : ''}',
                        style: ts(
                          context,
                          10,
                          scaled: false,
                          color: toneOf(context, state.tone),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (store.connectionIssue != null &&
              store.connection != ShellConnection.ready)
            _Note(store.connectionIssue!.message, color: p.warn),
          const _SectionLabel('CONNECTION'),
          _DetailCard([
            _DetailRow('State', state.label, tone: state.tone),
            if (config != null)
              _DetailRow('Address', '${config.address}:${config.port}'),
            _DetailRow(
              'Host ID',
              store.host.hostId.isNotEmpty
                  ? store.host.hostId
                  : config?.hostId ?? '—',
            ),
            if (grant?.hostKeyFingerprint != null)
              _DetailRow('Host key', grant!.hostKeyFingerprint!),
            const _DetailRow('Transport', 'Noise IK, encrypted'),
            _DetailRow(
              'Protocol',
              info != null
                  ? 'v${info.protocolVersion} · revision ${info.surfaceRevision}'
                  : 'v1 · revision 1 (older desktop)',
            ),
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
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (store.connection != ShellConnection.ready) ...[
                _SmallButton('Reconnect now', store.retryConnection),
              ],
              _SmallButton('Switch desktop', () {
                store.showDesktops();
                onOpenDesktops();
              }),
              _SmallButton('Disconnect', () => store.disconnect()),
            ],
          ),
          const _Note(
            'Execution stays on this desktop. The phone never receives provider credentials, repository paths or the desktop’s private key.',
          ),
        ];
      case _SettingsPage.permissions:
        content = [
          const _Note(
            'Granted when this phone was confirmed on the desktop and enforced there on every request. Change it in Settings → Mobile access on the desktop.',
          ),
          if (store.access.status == RemoteStatus.loading ||
              store.access.status == RemoteStatus.idle)
            const _Note('Loading this phone’s grant from the desktop…'),
          if (store.access.status == RemoteStatus.unsupported ||
              store.access.status == RemoteStatus.error)
            _Note(store.access.message ?? '', color: p.warn),
          if (grant != null) ...[
            const _SectionLabel('THIS PHONE'),
            _DetailCard([
              _DetailRow('Name on desktop', grant.label ?? grant.deviceId),
              if (when(grant.pairedAt) != null)
                _DetailRow('Paired', when(grant.pairedAt)!),
              if (when(grant.lastSeenAt) != null)
                _DetailRow('Last connected', when(grant.lastSeenAt)!),
            ]),
            const _SectionLabel('REMOTE ACTIONS'),
            _DetailCard([
              for (final row in _capabilityRows)
                _DetailRow(
                  row.$2,
                  grant.capabilities.contains(row.$1)
                      ? 'Allowed'
                      : 'Not allowed',
                  tone: grant.capabilities.contains(row.$1)
                      ? Tone.ok
                      : Tone.danger,
                ),
              const _DetailRow(
                'Shell or file access',
                'Never offered to phones',
              ),
            ]),
            const _SectionLabel('PROJECTS'),
            _DetailCard([
              if (grant.projects.isEmpty)
                const _DetailRow('Scope', 'All projects'),
              for (final project in grant.projects)
                _DetailRow(project.name, 'Granted', tone: Tone.ok),
            ]),
            const _Note(
              'Each tool permission an agent asks for is answered once, here or on the desktop; the phone cannot grant standing permissions.',
            ),
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
                  decoration: BoxDecoration(
                    color: p.surface,
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Transform.translate(
                    offset: const Offset(0, -2),
                    child: Text(
                      '‹',
                      style: ts(
                        context,
                        27,
                        scaled: false,
                        lineHeight: 28,
                        color: p.textSecondary,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ts(context, 16, weight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 30),
            children: content,
          ),
        ),
      ],
    );
  }
}
