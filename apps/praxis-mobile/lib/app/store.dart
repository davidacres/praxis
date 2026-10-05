import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../core/attention.dart';
import '../core/gadgets.dart';
import '../core/invitation.dart';
import '../core/models.dart';
import '../core/palette.dart';
import '../core/session_options.dart';
import '../core/time.dart';
import '../core/usage.dart';
import '../core/workflow_runs.dart';
import '../protocol/session_mirror.dart';
import '../protocol/wire.dart';
import 'confirm_identity.dart';
import 'connection.dart';
import 'desktop_registry.dart';
import 'diagnostics.dart';
import 'theme.dart';

// The phone's state and the actions on it: the connection lifecycle, the
// reads and commands a screen calls, and the pure shaping of host data.
// Port of `app/store/StoreProvider.tsx`, `actions.ts` and `projections.ts`.

enum ShellConnection { offline, connecting, pairing, ready, reconnecting }

class WorkItem {
  const WorkItem({
    required this.workId,
    required this.title,
    required this.status,
    required this.sessionId,
    this.runId,
    this.projectId,
    this.provider,
    this.model,
    this.mode = 'chat',
    this.draft = false,
    this.selection,
  });

  final String workId;
  final String title;
  final String status;
  final String sessionId;
  final String? runId;
  final String? projectId;
  final String? provider;
  final String? model;
  final String mode;

  /// Not yet created on the desktop; [selection] is what the first message will launch.
  final bool draft;
  final SessionSelection? selection;

  WorkItem withSelection(SessionSelection selection) => WorkItem(
    workId: workId,
    title: title,
    status: status,
    sessionId: sessionId,
    runId: runId,
    projectId: projectId,
    provider: provider,
    model: model,
    mode: mode,
    draft: draft,
    selection: selection,
  );
}

WorkItem workFromSession(SessionSnapshot session) => WorkItem(
  workId: session.sessionKey,
  title: session.title,
  status: session.lifecycle,
  sessionId: session.sessionId,
  mode: session.mode,
  provider: session.provider,
  model: session.model,
  runId: session.runId,
  projectId: session.projectId,
);

enum FollowUpState { pending, completed, failed }

class FollowUp {
  const FollowUp({
    required this.messageId,
    required this.sessionId,
    required this.workId,
    required this.text,
    required this.state,
    required this.createdAt,
    this.result,
  });
  final String messageId;
  final String sessionId;
  final String workId;
  final String text;
  final FollowUpState state;
  final String createdAt;
  final String? result;

  FollowUp copyWith(FollowUpState state, [String? result]) =>
      FollowUp(messageId: messageId, sessionId: sessionId, workId: workId, text: text, state: state, createdAt: createdAt, result: result);
}

class TranscriptMessage {
  const TranscriptMessage({
    required this.id,
    required this.author,
    required this.text,
    required this.at,
    required this.streaming,
    this.sessionId,
    this.gadgets = const [],
    this.attachments = const [],
    this.model,
    this.tokens,
    this.cost,
  });
  final String id;

  /// `system`: runtime notices (handover, model change) and errors.
  final String author;
  final String text;
  final String at;
  final bool streaming;
  final String? sessionId;
  final List<GadgetView> gadgets;
  final List<SessionImageAttachment> attachments;
  final String? model;
  final TokenUsage? tokens;
  final Cost? cost;

  TranscriptMessage withMeta({String? model, TokenUsage? tokens, Cost? cost}) => TranscriptMessage(
    id: id,
    author: author,
    text: text,
    at: at,
    streaming: streaming,
    sessionId: sessionId,
    gadgets: gadgets,
    attachments: attachments,
    model: this.model ?? model,
    tokens: this.tokens ?? tokens,
    cost: this.cost ?? cost,
  );
}

List<TranscriptMessage> transcriptOf(SessionSnapshot? snapshot) {
  if (snapshot == null) return const [];
  return snapshot.messages.map((message) {
    final assistant = message.role == 'assistant';
    return TranscriptMessage(
      id: message.id,
      author: message.role,
      text: message.text,
      at: formatDayAndClock(message.at) ?? (formatClock(message.at).isNotEmpty ? formatClock(message.at) : message.at),
      streaming: message.status == 'streaming',
      sessionId: snapshot.sessionId,
      gadgets: message.gadgets,
      attachments: message.attachments,
      model: message.model ?? (assistant ? snapshot.model : null),
      tokens: message.tokenUsage ?? (assistant ? snapshot.tokenUsage : null),
      cost: message.cost ?? (assistant ? snapshot.cost : null),
    );
  }).toList();
}

class ActivityEntry {
  const ActivityEntry({required this.id, required this.at, required this.workId, required this.title, required this.text});
  final String id;
  final String at;
  final String workId;
  final String title;
  final String text;
}

const _lifecycleText = {
  'active': 'Working',
  'awaiting-input': 'Waiting for you',
  'completed': 'Finished',
  'failed': 'Failed',
  'stopped': 'Stopped',
  'idle': 'Idle',
};

enum RemoteStatus { idle, loading, ready, unsupported, error }

class Remote<T> {
  const Remote(this.status, [this.value, this.message]);
  final RemoteStatus status;
  final T? value;
  final String? message;
}

class PairingState {
  const PairingState(this.message, [this.deviceLabel]);
  final String message;
  final String? deviceLabel;
}

const Map<String, Object> caller = {
  'deviceId': 'praxis-mobile',
  'capabilities': ['view', 'execute', 'approve'],
};

final _random = Random();

String commandId(String prefix) {
  final random = List.generate(8, (_) => _random.nextInt(36).toRadixString(36)).join();
  return '$prefix:${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}:$random';
}

/// The desktop authenticated under the pinned key but reports another host ID.
class _HostIdMismatch extends StateError {
  _HostIdMismatch() : super('The authenticated desktop has a different host ID. Scan its pairing invitation again.');
}

/// The captured transport refuses both new operations and late replies once
/// replaced. This also covers each individual read in a multi-read bootstrap.
class _GuardedConnection extends NativeMobileConnection {
  _GuardedConnection(super.config, this.delegate, this.current, this.disposed);
  final NativeMobileConnection delegate;
  final NativeMobileConnection? Function() current;
  final bool Function() disposed;
  void check() {
    if (disposed() || !identical(current(), this)) throw StateError('The desktop selection changed.');
  }

  Future<Object?> guard(Future<Object?> Function() operation) async {
    check();
    final result = await operation();
    check();
    return result;
  }

  @override
  Future<void> connect() async {
    await guard(() async {
      await delegate.connect();
      return null;
    });
  }

  @override
  Future<Object?> read(Map<String, Object?> request) => guard(() => delegate.read(request));
  @override
  Future<Object?> command(Map<String, Object?> command) => guard(() => delegate.command(command));
  @override
  Future<Object?> replay(int afterSequence) => guard(() => delegate.replay(afterSequence));
  @override
  void Function() subscribe(void Function(Map<String, dynamic>) listener) => delegate.subscribe(listener);
  @override
  void Function() subscribeStatus(void Function(MobileConnectionStatus) listener) => delegate.subscribeStatus(listener);
  @override
  void Function() subscribeClose(void Function(MobileConnectionError) listener) => delegate.subscribeClose(listener);
  @override
  void close() => delegate.close();
}

Map<String, Object?> readRequest(String operation, Map<String, Object?> target, [Map<String, Object?>? params]) => {
  'protocolVersion': 1,
  'requestId': commandId(operation),
  'caller': caller,
  'target': target,
  'operation': operation,
  if (params != null) 'params': params,
};

/// How often the phone re-reads the desktop's attention list — a safety net
/// behind live run and session events, unless the desktop is too old to send them.
const _attentionSafetyPoll = Duration(seconds: 60);
const _attentionLegacyPoll = Duration(seconds: 5);
const _updateDesktop = 'Update Praxis on the desktop to do this from the phone.';

bool _visibleSession(SessionSnapshot session, String? projectId) => session.projectId != null
    ? session.projectId == projectId
    : session.runId == null && RegExp(r'^SESSION-[0-9a-f]{6,}$', caseSensitive: false).hasMatch(session.sessionKey);

class AppStore extends ChangeNotifier {
  AppStore({
    required this.theme,
    DesktopRepository? repository,
    NativeMobileConnection Function(HostConfiguration)? connectionFactory,
    Future<bool> Function(String)? identityCheck,
    bool initialize = true,
  }) : repository = repository ?? desktopRepository,
       _connectionFactory = connectionFactory ?? NativeMobileConnection.new,
       _identityCheck = identityCheck ?? confirmIdentity {
    _lifecycle = AppLifecycleListener(onResume: _onResume);
    if (initialize) startup = _initialize();
  }

  final ThemeController theme;
  final DesktopRepository repository;
  final NativeMobileConnection Function(HostConfiguration) _connectionFactory;
  final Future<bool> Function(String) _identityCheck;
  late final AppLifecycleListener _lifecycle;
  Future<void> startup = Future.value();
  DesktopRegistry desktops = DesktopRegistry();
  String? registryError;
  bool registryLoaded = false;
  bool desktopsVisible = true;
  bool pairingFormVisible = false;
  int _generation = 0;
  int get generation => _generation;
  SavedDesktop? get selectedDesktop {
    final active = desktops.active;
    final config = hostConfig;
    return active != null && config != null && active.sameIdentity(config) ? active : null;
  }

  String get desktopLabel => selectedDesktop?.name ?? hostConfig?.hostName ?? hostConfig?.address ?? 'Desktop';
  String get contextKey => '${selectedDesktop?.entryId ?? 'candidate'}:$_generation';

  Future<void> _initialize() async {
    final generation = _generation;
    try {
      final loaded = await repository.load();
      if (_disposed || generation != _generation) return;
      desktops = loaded;
      registryLoaded = true;
      registryError = null;
      final active = loaded.active;
      if (active != null) {
        theme.applyAppearance(active.appearance);
        desktopsVisible = false;
        await connect(active.configuration);
      }
    } catch (error) {
      if (_disposed || generation != _generation) return;
      registryError = Diagnostics.messageOf(error);
      registryLoaded = true;
    }
    _changed();
  }

  Future<void> reloadDesktops() async {
    final generation = _generation;
    try {
      final loaded = await repository.load();
      if (_disposed || generation != _generation) return;
      desktops = loaded;
      registryLoaded = true;
      registryError = null;
    } catch (error) {
      if (_disposed || generation != _generation) return;
      registryError = Diagnostics.messageOf(error);
    }
    _changed();
  }

  void showDesktops() {
    desktopsVisible = true;
    pairingFormVisible = false;
    _changed();
  }

  void addDesktop() {
    disconnect();
    hostConfig = null;
    desktopsVisible = false;
    pairingFormVisible = true;
    theme.applyAppearance(null);
    _changed();
  }

  Future<void> selectDesktop(String id) async {
    disconnect();
    final generation = _generation;
    try {
      final selected = await repository.select(id);
      if (_disposed || generation != _generation) return;
      desktops = selected;
      registryError = null;
      desktopsVisible = false;
      pairingFormVisible = false;
      theme.applyAppearance(selected.active?.appearance);
      await connect(selected.active!.configuration);
    } catch (error) {
      if (_disposed || generation != _generation) return;
      registryError = Diagnostics.messageOf(error);
      showDesktops();
    }
  }

  Future<void> renameDesktop(String id, String? nickname) async {
    final generation = _generation;
    final renamed = await repository.rename(id, nickname);
    if (_disposed || generation != _generation) return;
    desktops = renamed;
    _changed();
  }

  Future<void> forgetDesktop(String id) async {
    final active = selectedDesktop?.entryId == id;
    if (active) disconnect();
    final generation = _generation;
    final forgotten = await repository.forget(id);
    if (_disposed || generation != _generation) return;
    desktops = forgotten;
    _composerDrafts.removeWhere((key, _) => key.startsWith('$id:'));
    if (active) {
      hostConfig = null;
      theme.applyAppearance(null);
    }
    showDesktops();
  }

  bool _current(NativeMobileConnection connection) => !_disposed && identical(_live, connection);
  void _ensureCurrent(NativeMobileConnection connection) {
    if (!_current(connection)) throw StateError('The desktop selection changed. Open the item again on its desktop.');
  }

  // ---------------------------------------------------------------- state

  ShellConnection _connection = ShellConnection.offline;
  String primaryRoute = 'work';
  String detail = 'chat';
  bool autoConnectEnabled = true;
  ({String hostId, String hostName, bool online}) host = (hostId: '', hostName: '', online: false);
  HostInfo? hostInfo;
  HostConfiguration? hostConfig;
  ({String projectId, String name}) project = (projectId: '', name: '');
  List<ProjectSummary> availableProjects = [];
  String? projectNotice;
  List<WorkItem> work = const [];
  Map<String, SessionSnapshot> _snapshots = {};
  final Map<String, SessionUsage> _usageReads = {};
  List<AttentionItem> _polledAttention = const [];
  Set<String> _resolvedIds = {};
  List<FollowUp> followUps = const [];
  List<WorkflowChoice> workflows = const [];
  final Map<String, RunSummary> runs = {};
  List<RunSnapshot> workflowRuns = const [];
  bool runsSupported = false;
  String? openWorkId;
  String? openRunId;
  ConnectionIssue? connectionIssue;
  PairingState? pairing;
  Remote<ProviderCatalog> providers = const Remote(RemoteStatus.idle);
  final Map<String, Remote<ModelCatalog>> models = {};
  Remote<DeviceAccess> access = const Remote(RemoteStatus.idle);

  ShellConnection get connection => _connection;
  bool get loading => _connection == ShellConnection.connecting || _connection == ShellConnection.pairing;

  /// The session UI (not the Connect screen) is shown while ready or briefly reconnecting.
  bool get showsWork => _connection == ShellConnection.ready || _connection == ShellConnection.reconnecting;

  NativeMobileConnection? _live;
  List<void Function()> _unsubscribe = [];
  String? _projectId;
  final MobileEventCursor _cursor = MobileEventCursor();
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  Timer? _attentionTimer;
  final Map<String, ({Map<String, Object?> command, String workId, bool draft})> _commands = {};
  bool _disposed = false;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _setPhase(ShellConnection phase) {
    _connection = phase;
    _syncAttentionPoll();
    _changed();
  }

  @visibleForTesting
  void setConnectionForTesting(ShellConnection phase) => _setPhase(phase);

  // ---------------------------------------------------------------- derived

  SessionSnapshot? sessionFor(String sessionId) => _snapshots[sessionId];

  List<TranscriptMessage> transcriptFor(String sessionId) => transcriptOf(_snapshots[sessionId]);

  List<AttentionItem> get attention {
    final hostId = hostConfig?.hostId ?? host.hostId;
    final permissions = <AttentionItem>[];
    for (final snapshot in _snapshots.values) {
      final projectId = snapshot.projectId;
      if (projectId == null) continue;
      for (final permission in snapshot.pendingPermissions) {
        permissions.add(
          AttentionItem(
            id: 'permission:${permission.requestId}',
            kind: 'permission',
            hostId: hostId,
            projectId: projectId,
            sessionId: snapshot.sessionId,
            requestId: permission.requestId,
            summary: permission.summary,
            detail: permission.detail,
            createdAt: permission.createdAt,
          ),
        );
      }
    }
    final fromRuns = runsSupported ? runAttentionItems(hostId, project.projectId, workflowRuns) : null;
    final combined = combineAttention(polled: _polledAttention, permissions: permissions, fromRuns: fromRuns, resolvedIds: _resolvedIds);
    // Forget an acted-on item once the desktop no longer reports it, so a later request with the same id shows.
    if (_resolvedIds.isNotEmpty) {
      final present = combined.map((item) => item.id).toSet();
      _resolvedIds = _resolvedIds.where(present.contains).toSet();
    }
    return combined;
  }

  List<AttentionItem> get openAttention => openMobileAttention(attention, hostId: host.hostId, projectId: project.projectId);

  /// The Activity screen: each chat's latest line, newest first.
  List<ActivityEntry> get activity {
    final entries = <ActivityEntry>[];
    for (final item in work) {
      if (item.draft) continue;
      final snapshot = _snapshots[item.sessionId];
      final messages = snapshot?.messages ?? const <SessionMessage>[];
      final last = messages.isEmpty ? null : messages.last;
      final at = last?.at ?? snapshot?.completedAt ?? snapshot?.startedAt ?? '';
      if (at.isEmpty) continue;
      final lastText = last == null ? '' : (last.text.isNotEmpty ? last.text : (last.gadgets.isNotEmpty ? '[${last.gadgets.first.gadget.kind}]' : ''));
      final who = last == null
          ? ''
          : last.role == 'user'
          ? 'You'
          : last.role == 'system'
          ? 'Desktop'
          : 'Agent';
      final text =
          '${_lifecycleText[item.status] ?? item.status}${last != null ? ' — $who: ${lastText.length > 120 ? lastText.substring(0, 120) : lastText}' : ''}';
      entries.add(ActivityEntry(id: item.sessionId, at: at, workId: item.workId, title: item.title, text: text));
    }
    entries.sort((left, right) => right.at.compareTo(left.at));
    return entries
        .take(40)
        .map((entry) => ActivityEntry(id: entry.id, at: formatClock(entry.at), workId: entry.workId, title: entry.title, text: entry.text))
        .toList();
  }

  UsageView usageFor(WorkItem item) {
    final catalog = providers.value;
    if (item.draft) {
      final selection = effectiveSelection(catalog, item.selection ?? defaultSessionSelection);
      return describeUsage(source: null, loading: false, draft: true, providerLabel: selection.providerOption?.label);
    }
    final snapshot = _snapshots[item.sessionId];
    final label = providerOption(catalog, item.provider)?.label;
    return describeUsage(source: latestUsage(snapshot, _usageReads[item.sessionId]), loading: snapshot == null, providerLabel: label);
  }

  bool _supports(String operation) => hostInfo?.readOperations.contains(operation) ?? false;
  bool _offers(String operation) => hostInfo?.commandOperations.contains(operation) ?? false;

  /// Whether this desktop accepts [operation] from the phone now.
  bool canCommand(String operation) => _connection == ShellConnection.ready && _offers(operation);

  bool get changesSupported => (hostInfo?.surfaceRevision ?? 0) >= 5 && _supports('changes.get');

  // ---------------------------------------------------------------- events

  void _wearAppearance(Object? value) {
    final appearance = readMobileAppearance(value);
    if (appearance != null) {
      theme.applyAppearance(appearance);
      final id = selectedDesktop?.entryId;
      final connection = _live;
      if (id != null && connection != null) {
        repository
            .cacheAppearance(id, appearance, isCurrent: () => _current(connection))
            .then((registry) {
              if (_current(connection)) desktops = registry;
            })
            .catchError((Object error) {
              if (_current(connection)) Diagnostics.instance.record('Saving the desktop theme', error);
            });
      }
    }
  }

  void _applySnapshot(SessionSnapshot snapshot) {
    if (!_visibleSession(snapshot, _projectId)) return;
    final existing = _snapshots[snapshot.sessionId];
    if (existing == null || existing.sequence <= snapshot.sequence) {
      _snapshots = {..._snapshots, snapshot.sessionId: snapshot};
    }
    final index = work.indexWhere((item) => item.sessionId == snapshot.sessionId || item.workId == snapshot.sessionKey);
    if (snapshot.archived) {
      if (index >= 0) work = [...work]..removeAt(index);
    } else {
      final next = workFromSession(snapshot);
      work = index < 0 ? [next, ...work] : ([...work]..[index] = next);
    }
    _changed();
  }

  void _applyEvent(Map<String, dynamic> envelope) {
    final sequence = envelope['sequence'];
    if (sequence is! num || !_cursor.observe(sequence)) return;
    final event = envelope['event'];
    if (event is! Map<String, dynamic>) return;
    switch (event['type']) {
      case 'host.appearance':
        _wearAppearance(event['appearance']);
      case 'run.snapshot':
        final run = event['run'];
        if (run is Map<String, dynamic>) workflowRuns = mergeRun(workflowRuns, RunSnapshot(run));
        _changed();
      case 'run.removed':
        final runId = event['runId'] as String?;
        workflowRuns = removeRun(workflowRuns, runId ?? '');
        if (openRunId == runId) openRunId = null;
        _changed();
      case 'session.snapshot':
        final snapshot = event['snapshot'];
        if (snapshot is Map<String, dynamic>) _applySnapshot(SessionSnapshot(snapshot));
      case 'session.removed':
        final sessionId = event['sessionId'] as String?;
        work = work.where((item) => item.sessionId != sessionId).toList();
        _snapshots = {..._snapshots}..remove(sessionId);
        _changed();
    }
  }

  // ---------------------------------------------------------------- connection

  void _clearReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _scheduleReconnect() {
    _clearReconnectTimer();
    final delay = reconnectDelay(_reconnectAttempt);
    _reconnectAttempt += 1;
    final generation = _generation;
    _reconnectTimer = Timer(delay, () {
      if (_disposed || generation != _generation) return;
      final config = hostConfig;
      if (config != null && _connection == ShellConnection.reconnecting) _openConnection(config, reconnect: true);
    });
  }

  void _closeConnection() {
    for (final unsubscribe in _unsubscribe) {
      unsubscribe();
    }
    _unsubscribe = [];
    _live?.close();
    _live = null;
  }

  Future<List<dynamic>> _readList(NativeMobileConnection connection, String operation, Map<String, Object?> target) async {
    final value = await connection.read(readRequest(operation, target));
    return value is List ? value : const [];
  }

  /// Everything the phone shows is re-read from the desktop; replay then resumes after the pinned cursor.
  Future<HostConfiguration> _bootstrap(NativeMobileConnection connection, HostConfiguration config) async {
    final hostTarget = {'hostId': config.hostId};
    HostInfo? info;
    try {
      info = HostInfo(await connection.read(readRequest('host.info', hostTarget)) as Map<String, dynamic>);
    } catch (_) {
      _ensureCurrent(connection);
      info = null; // A desktop from before revision 2: no catalog, usage or access reads.
    }
    final epochChanged = hostInfo?.hostEpoch != info?.hostEpoch;
    if (info != null && info.hostId != config.hostId) {
      throw _HostIdMismatch();
    }
    hostInfo = info;
    _wearAppearance(info?.appearance);
    if (epochChanged) {
      // The desktop restarted: its event sequence restarted too.
      _cursor.reset(info?.latestSequence ?? 0);
      _snapshots = {};
      _usageReads.clear();
    }
    host = (hostId: config.hostId, hostName: info?.hostName ?? config.hostName?.trim() ?? config.address, online: true);

    if (info?.readOperations.contains('access.get') ?? false) {
      try {
        access = Remote(RemoteStatus.ready, DeviceAccess(await connection.read(readRequest('access.get', hostTarget)) as Map<String, dynamic>));
      } catch (error) {
        _ensureCurrent(connection);
        access = Remote(RemoteStatus.error, null, Diagnostics.messageOf(error));
      }
    } else {
      access = const Remote(RemoteStatus.unsupported, null, 'This desktop does not report the phone’s access grant. Update Praxis on the desktop.');
    }

    final available = await connection.read(readRequest('projects.snapshot', hostTarget)) as Map<String, dynamic>;
    final projects = (available['projects'] as List? ?? const []).whereType<Map<String, dynamic>>().map(ProjectSummary.new).toList();
    if (projects.isEmpty) {
      throw StateError('This phone has not been granted access to a project. Change its grant in Settings → Mobile access on the desktop.');
    }
    availableProjects = projects;
    final remembered = projects.where((project) => project.projectId == config.projectId).firstOrNull;
    projectNotice = config.projectId != null && remembered == null
        ? 'The saved project is no longer available on this desktop. Select a permitted project.'
        : null;
    final projectSummary = remembered ?? projects.first;
    final projectId = projectSummary.projectId;
    final target = {...hostTarget, 'projectId': projectId};
    _projectId = projectId;
    project = (projectId: projectId, name: projectSummary.name);
    final saved = HostConfiguration.fromJson({
      ...config.withProject(projectId).withoutInvitation().toJson(),
      if (info?.hostName.isNotEmpty == true) 'hostName': info!.hostName,
    });
    _ensureCurrent(connection);
    // Persist only after authentication; every write is bound to this transport.
    final registry = await repository.saveAuthenticated(saved, replaceKey: config.pairingTokenId != null, isCurrent: () => _current(connection));
    _ensureCurrent(connection);
    desktops = registry;
    _wearAppearance(info?.appearance);
    final entry = registry.active;
    if (entry != null) {
      for (final draft in entry.drafts.entries) {
        if (draft.value.newChat && !work.any((item) => item.workId == draft.key) && draft.value.projectId == projectId) {
          work = [
            ...work,
            WorkItem(
              workId: draft.key,
              title: 'New chat',
              status: 'idle',
              sessionId: draft.key,
              draft: true,
              projectId: projectId,
              selection: SessionSelection(provider: draft.value.provider, model: draft.value.model, mode: draft.value.mode),
            ),
          ];
        }
      }
    }

    final sessions = (await _readList(
      connection,
      'sessions.list',
      access.value?.projects.isEmpty == true ? hostTarget : target,
    )).whereType<Map<String, dynamic>>().map(SessionSnapshot.new).where((session) => !session.archived && _visibleSession(session, projectId)).toList();
    final loaded = await Future.wait(
      sessions.map(
        (session) async => SessionSnapshot(
          await connection.read(
                readRequest('sessions.get', {...hostTarget, if (session.projectId != null) 'projectId': session.projectId, 'sessionId': session.sessionId}),
              )
              as Map<String, dynamic>,
        ),
      ),
    );
    // Sessions the desktop no longer lists drop out; a live event newer than the read is kept.
    final next = <String, SessionSnapshot>{};
    for (final snapshot in loaded) {
      final existing = _snapshots[snapshot.sessionId];
      next[snapshot.sessionId] = existing != null && existing.sequence > snapshot.sequence ? existing : snapshot;
    }
    _snapshots = next;
    work = [...work.where((item) => item.draft), ...sessions.map(workFromSession)];
    // Land on a chat, not on one of a workflow run's stage sessions (those open through their run).
    final current = openWorkId;
    if (!(current != null && (sessions.any((session) => session.sessionKey == current) || current.startsWith('draft-')))) {
      openWorkId = sessions.where((session) => !isStageSessionKey(session.sessionKey, session.runId)).map((session) => session.sessionKey).firstOrNull;
    }

    workflows = (await _readList(
      connection,
      'workflows.list',
      target,
    )).whereType<Map<String, dynamic>>().map(WorkflowChoice.new).where((choice) => choice.trigger != 'ticket').toList();
    runsSupported = info?.readOperations.contains('workflowRuns.list') ?? false;
    if (runsSupported) {
      final listed = (await _readList(connection, 'workflowRuns.list', target)).whereType<Map<String, dynamic>>().map(RunSnapshot.new).toList();
      workflowRuns = replaceRuns(workflowRuns, listed);
      if (openRunId != null && !listed.any((run) => run.runId == openRunId)) openRunId = null;
    } else {
      workflowRuns = const [];
      openRunId = null;
    }
    _polledAttention = (await _readList(connection, 'attention.list', target)).whereType<Map<String, dynamic>>().map(AttentionItem.fromJson).toList();
    Diagnostics.instance.refreshSucceeded();
    _changed();

    if (info?.readOperations.contains('providers.list') ?? false) {
      providers = Remote(RemoteStatus.loading, providers.value);
      try {
        providers = Remote(RemoteStatus.ready, ProviderCatalog(await connection.read(readRequest('providers.list', target)) as Map<String, dynamic>));
      } catch (error) {
        _ensureCurrent(connection);
        providers = Remote(RemoteStatus.error, null, Diagnostics.messageOf(error));
      }
    } else {
      providers = const Remote(
        RemoteStatus.unsupported,
        null,
        'This desktop does not share its AI providers with the phone. Update Praxis on the desktop to choose a provider and model here.',
      );
    }

    // The reads are current as of latestSequence: replay what came after.
    final latest = info?.latestSequence ?? 0;
    if (_cursor.sequence < latest) _cursor.reset(latest);
    await connection.replay(latest);
    return saved;
  }

  void _handleConnectionLoss(Object error) {
    final issue = describeConnectionIssue(error);
    connectionIssue = issue;
    host = (hostId: host.hostId, hostName: host.hostName, online: false);
    if (issue.retryable && (_connection == ShellConnection.ready || _connection == ShellConnection.reconnecting)) {
      _setPhase(ShellConnection.reconnecting);
      _scheduleReconnect();
      return;
    }
    _clearReconnectTimer();
    pairing = null;
    _setPhase(ShellConnection.offline);
  }

  Future<void> _openConnection(HostConfiguration config, {required bool reconnect}) async {
    _clearReconnectTimer();
    _closeConnection();
    final connection = _GuardedConnection(config, _connectionFactory(config), () => _live, () => _disposed);
    _live = connection;
    hostConfig = config;
    bool current() => _current(connection);
    if (!reconnect) {
      connectionIssue = null;
      _setPhase(ShellConnection.connecting);
    }
    _unsubscribe = [
      connection.subscribe((envelope) {
        if (current()) _applyEvent(envelope);
      }),
      connection.subscribeStatus((status) {
        if (!current()) return;
        if (status.code == 'pairing-pending') {
          _setPhase(ShellConnection.pairing);
          deviceKeyPrefix().then((prefix) {
            if (!current()) return;
            pairing = PairingState(status.message, 'Phone $prefix');
            _changed();
          });
        } else if (status.code == 'pairing-required' && config.pairingTokenId != null) {
          pairing = const PairingState('Presenting the pairing invitation to the desktop…');
          _changed();
        }
      }),
      connection.subscribeClose((error) {
        if (current()) _handleConnectionLoss(error);
      }),
    ];
    String? newlySaved;
    try {
      await connection.connect();
      if (!current()) return;
      var effective = config;
      if (config.pairingTokenId != null) {
        effective = config.withoutInvitation();
        hostConfig = effective;
      }
      // A spent invitation must be kept even if the reads below fail; a known desktop is saved once, by the bootstrap.
      final known = desktops.entries.any((entry) => entry.sameIdentity(effective));
      if (config.pairingTokenId != null || !known) {
        final registry = await repository.saveAuthenticated(effective, replaceKey: config.pairingTokenId != null, isCurrent: current);
        if (!current()) return;
        desktops = registry;
        newlySaved = !known ? registry.active?.entryId : null;
      }
      final saved = await _bootstrap(connection, effective);
      if (!current()) return;
      hostConfig = saved;
      _reconnectAttempt = 0;
      connectionIssue = null;
      pairing = null;
      if (projectNotice != null) desktopsVisible = true;
      _setPhase(ShellConnection.ready);
    } catch (error) {
      if (!current()) return;
      _closeConnection();
      if (error is _HostIdMismatch && newlySaved != null) {
        // Do not leave a desktop that failed verification saved and selected for the next launch.
        final generation = _generation;
        try {
          final forgotten = await repository.forget(newlySaved);
          if (generation == _generation) desktops = forgotten;
        } catch (forgetError) {
          Diagnostics.instance.record('Removing an unverified desktop', forgetError);
        }
        if (_disposed || generation != _generation) return;
      }
      if (reconnect) {
        _handleConnectionLoss(error);
        return;
      }
      pairing = null;
      connectionIssue = describeConnectionIssue(error);
      _setPhase(ShellConnection.offline);
    }
  }

  void _syncAttentionPoll() {
    _attentionTimer?.cancel();
    _attentionTimer = null;
    if (_connection != ShellConnection.ready) return;
    _attentionTimer = Timer.periodic(runsSupported ? _attentionSafetyPoll : _attentionLegacyPoll, (_) {
      final connection = _live;
      final projectId = _projectId;
      final hostId = hostConfig?.hostId;
      if (connection == null || projectId == null || hostId == null) return;
      connection
          .read(readRequest('attention.list', {'hostId': hostId, 'projectId': projectId}))
          .then((items) {
            if (!_current(connection)) return;
            _polledAttention = (items is List ? items : const <Object?>[]).whereType<Map<String, dynamic>>().map(AttentionItem.fromJson).toList();
            Diagnostics.instance.refreshSucceeded();
            _changed();
          })
          .catchError((Object error) {
            if (_current(connection)) Diagnostics.instance.refreshFailed('Refreshing attention', error);
          });
    });
  }

  /// Returning to the foreground: a suspended socket is often dead without a close event.
  void _onResume() {
    final config = hostConfig;
    if (config == null) return;
    if (_connection == ShellConnection.reconnecting) {
      _reconnectAttempt = 0;
      _openConnection(config, reconnect: true);
      return;
    }
    final connection = _live;
    if (_connection != ShellConnection.ready || connection == null) return;
    connection
        .read(readRequest('host.info', {'hostId': config.hostId}))
        .then((value) {
          if (!_current(connection)) return null;
          final info = HostInfo(value as Map<String, dynamic>);
          if (info.hostEpoch != hostInfo?.hostEpoch) return _openConnection(config, reconnect: true);
          return connection.replay(_cursor.sequence).then((_) {});
        })
        .catchError((Object error) {
          if (!_current(connection)) return;
          Diagnostics.instance.record('Checking the desktop after returning to the app', error);
          _setPhase(ShellConnection.reconnecting);
          _reconnectAttempt = 0;
          _openConnection(config, reconnect: true);
        });
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    forgetIdentityCheck();
    _lifecycle.dispose();
    _clearReconnectTimer();
    _attentionTimer?.cancel();
    _closeConnection();
    super.dispose();
  }

  // ---------------------------------------------------------------- connect / navigation

  Future<void> connect(HostConfiguration config) {
    disconnect();
    desktopsVisible = false;
    pairingFormVisible = false;
    theme.applyAppearance(desktops.entries.where((e) => e.sameIdentity(config)).firstOrNull?.appearance);
    autoConnectEnabled = true;
    return _openConnection(config, reconnect: false);
  }

  void retryConnection() {
    final config = hostConfig;
    if (config == null) return;
    autoConnectEnabled = true;
    _reconnectAttempt = 0;
    _openConnection(config, reconnect: _connection == ShellConnection.reconnecting);
  }

  void cancelConnect() {
    disconnect();
    autoConnectEnabled = false;
    pairing = null;
    _setPhase(ShellConnection.offline);
  }

  void disconnect() {
    _generation++;
    _clearReconnectTimer();
    _closeConnection();
    _attentionTimer?.cancel();
    forgetIdentityCheck();
    autoConnectEnabled = false;
    _projectId = null;
    _cursor.reset(0);
    _commands.clear();
    primaryRoute = 'work';
    detail = 'chat';
    host = (hostId: '', hostName: '', online: false);
    hostInfo = null;
    project = (projectId: '', name: '');
    availableProjects = [];
    projectNotice = null;
    work = const [];
    _snapshots = {};
    _usageReads.clear();
    _polledAttention = const [];
    _resolvedIds = {};
    followUps = const [];
    workflows = const [];
    runs.clear();
    workflowRuns = const [];
    runsSupported = false;
    openRunId = null;
    providers = const Remote(RemoteStatus.idle);
    models.clear();
    access = const Remote(RemoteStatus.idle);
    openWorkId = null;
    connectionIssue = null;
    pairing = null;
    _setPhase(ShellConnection.offline);
  }

  Future<void> selectProject(String id) async {
    final config = hostConfig;
    if (config == null || !availableProjects.any((p) => p.projectId == id)) {
      throw StateError('That project is not available on this desktop.');
    }
    await connect(config.withProject(id));
  }

  final Map<String, DesktopDraft> _composerDrafts = {};
  DesktopDraft? composerDraft(String workId) {
    final id = selectedDesktop?.entryId;
    return _composerDrafts['$id:$workId'] ?? selectedDesktop?.drafts[workId];
  }

  void _removeComposerDraft(String entryId, String workId) {
    _composerDrafts.remove('$entryId:$workId');
    final entries = desktops.entries
        .map(
          (entry) => entry.entryId == entryId
              ? SavedDesktop(
                  entryId: entry.entryId,
                  configuration: entry.configuration,
                  nickname: entry.nickname,
                  appearance: entry.appearance,
                  lastUsedAt: entry.lastUsedAt,
                  drafts: {...entry.drafts}..remove(workId),
                )
              : entry,
        )
        .toList();
    desktops = DesktopRegistry(entries: entries, activeEntryId: desktops.activeEntryId);
    repository.saveDraft(entryId, workId, null).catchError((Object error) {
      Diagnostics.instance.record('Removing an unsent draft', error);
      return desktops;
    });
  }

  void saveComposerDraft(String entryId, String workId, String text, {WorkItem? item}) {
    final previous = _composerDrafts['$entryId:$workId'] ?? desktops.find(entryId)?.drafts[workId];
    if (text.trim().isEmpty) {
      // Nothing unsent: drop any stored draft instead of keeping an empty placeholder.
      if (previous != null) _removeComposerDraft(entryId, workId);
      return;
    }
    final draft = DesktopDraft(
      text: text,
      updatedAt: isoNow(),
      newChat: item?.draft ?? previous?.newChat ?? false,
      projectId: item?.projectId ?? previous?.projectId ?? _projectId,
      provider: item?.selection?.provider ?? previous?.provider,
      model: item?.selection?.model ?? previous?.model,
      mode: item?.selection?.mode ?? previous?.mode ?? 'chat',
    );
    _composerDrafts['$entryId:$workId'] = draft;
    final entries = desktops.entries
        .map(
          (entry) => entry.entryId == entryId
              ? SavedDesktop(
                  entryId: entry.entryId,
                  configuration: entry.configuration,
                  nickname: entry.nickname,
                  appearance: entry.appearance,
                  lastUsedAt: entry.lastUsedAt,
                  drafts: {...entry.drafts, workId: draft},
                )
              : entry,
        )
        .toList();
    desktops = DesktopRegistry(entries: entries, activeEntryId: desktops.activeEntryId);
    repository.saveDraft(entryId, workId, draft).catchError((Object error) {
      Diagnostics.instance.record('Saving an unsent draft', error);
      return desktops;
    });
  }

  void setRoute(String primary) {
    primaryRoute = primary;
    if (primary != 'work') detail = 'chat';
    _changed();
  }

  void setDetail(String next) {
    detail = next;
    _changed();
  }

  void openWork(String? workId) {
    openWorkId = workId;
    if (workId != null) openRunId = null;
    _changed();
  }

  void openRun(String? runId) {
    openRunId = runId;
    if (runId != null) {
      openWorkId = null;
      primaryRoute = 'work';
      detail = 'chat';
    }
    _changed();
  }

  void startNewChat() {
    openRunId = null;
    final id = 'draft-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}';
    work = [
      WorkItem(workId: id, title: 'New chat', status: 'idle', sessionId: id, draft: true, projectId: _projectId, selection: defaultSessionSelection),
      ...work,
    ];
    openWorkId = id;
    primaryRoute = 'work';
    detail = 'chat';
    _changed();
  }

  void updateDraftSelection(String workId, SessionSelection Function(SessionSelection current) patch) {
    work = work.map((item) => item.workId == workId && item.draft ? item.withSelection(patch(item.selection ?? defaultSessionSelection)) : item).toList();
    final item = work.where((item) => item.workId == workId).firstOrNull;
    final entry = selectedDesktop;
    if (item != null && entry != null) saveComposerDraft(entry.entryId, workId, entry.drafts[workId]?.text ?? '', item: item);
    _changed();
  }

  // ---------------------------------------------------------------- actions

  Map<String, Object?> _target([Map<String, String?> extra = const {}]) {
    final session = _snapshots[extra['sessionId']];
    // Existing sessions carry their own scope; a standalone conversation must
    // not inherit the project currently selected for workflows and new sessions.
    final projectId = session != null ? session.projectId : _projectId;
    return {
      'hostId': hostConfig?.hostId ?? host.hostId,
      if (projectId != null) 'projectId': projectId,
      for (final entry in extra.entries)
        if (entry.value != null) entry.key: entry.value,
    };
  }

  NativeMobileConnection _requireConnection() {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready) {
      throw StateError(
        _connection == ShellConnection.reconnecting
            ? 'The desktop connection dropped. Praxis is reconnecting — try again in a moment.'
            : 'Connect to a desktop project first.',
      );
    }
    return connection;
  }

  Future<Object?> _command(String operation, String prefix, Map<String, String?> extraTarget, Object payload) => _requireConnection().command({
    'protocolVersion': 1,
    'commandId': commandId(prefix),
    'issuedAt': isoNow(),
    'caller': caller,
    'target': _target(extraTarget),
    'operation': operation,
    'payload': payload,
  });

  Future<void> _sendCommand(String messageId) async {
    final entry = _commands[messageId];
    if (entry == null) return;
    final connection = _requireConnection();
    try {
      final value = await connection.command(entry.command);
      if (value is! Map<String, dynamic>) {
        throw StateError('The desktop did not return the session for this message. Refresh and send it again.');
      }
      final snapshot = SessionSnapshot(value);
      _commands.remove(messageId);
      _applySnapshot(snapshot);
      openWorkId = snapshot.sessionKey;
      if (entry.draft) {
        work = work.where((item) => !item.draft || item.workId != entry.workId).toList();
        final desktop = selectedDesktop;
        if (desktop != null) {
          _composerDrafts.remove('${desktop.entryId}:${entry.workId}');
          repository.saveDraft(desktop.entryId, entry.workId, null).catchError((Object error) {
            Diagnostics.instance.record('Removing a sent draft', error);
            return desktops;
          });
        }
      }
      followUps = followUps.where((message) => message.messageId != messageId).toList();
      _changed();
    } catch (error) {
      if (!_current(connection)) return;
      // The desktop refused it, so it did not run: a retry must be a new command, or the
      // desktop replays the refused one's empty outcome instead of trying again.
      if (error is MobileRequestError) {
        _commands[messageId] = (command: {...entry.command, 'commandId': commandId('message'), 'issuedAt': isoNow()}, workId: entry.workId, draft: entry.draft);
      }
      followUps = followUps
          .map((message) => message.messageId == messageId ? message.copyWith(FollowUpState.failed, Diagnostics.messageOf(error)) : message)
          .toList();
      _changed();
    }
  }

  void _markResolved(String id) {
    _resolvedIds = {..._resolvedIds, id};
    _changed();
  }

  Future<void> loadSession(String sessionId) async {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready) return;
    _applySnapshot(SessionSnapshot(await connection.read(readRequest('sessions.get', _target({'sessionId': sessionId}))) as Map<String, dynamic>));
  }

  Future<void> retryStage(String runId, String nodeId) async {
    await _command('workflowRuns.retryStage', 'retry', {'runId': runId}, {'nodeId': nodeId});
  }

  Future<void> refreshUsage(String sessionId) async {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready || !_supports('sessions.usage')) return;
    _usageReads[sessionId] = SessionUsage(await connection.read(readRequest('sessions.usage', _target({'sessionId': sessionId}))) as Map<String, dynamic>);
    _changed();
  }

  Future<void> refreshProviders() async {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready || !_supports('providers.list')) return;
    providers = Remote(RemoteStatus.loading, providers.value);
    _changed();
    try {
      providers = Remote(RemoteStatus.ready, ProviderCatalog(await connection.read(readRequest('providers.list', _target())) as Map<String, dynamic>));
    } catch (error) {
      _ensureCurrent(connection);
      providers = Remote(RemoteStatus.error, providers.value, Diagnostics.messageOf(error));
    }
    _changed();
  }

  Future<void> loadModels(String provider, {bool refresh = false}) async {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready || !_supports('models.list')) return;
    models[provider] = Remote(RemoteStatus.loading, models[provider]?.value);
    _changed();
    try {
      final value = await connection.read(readRequest('models.list', _target(), {'provider': provider, if (refresh) 'refresh': true}));
      models[provider] = Remote(RemoteStatus.ready, ModelCatalog(value as Map<String, dynamic>));
    } catch (error) {
      _ensureCurrent(connection);
      models[provider] = Remote(RemoteStatus.error, null, Diagnostics.messageOf(error));
    }
    _changed();
  }

  /// Between-turn provider handover / model change / mode switch of an existing session.
  Future<void> configureSession(WorkItem item, {String? provider, String? model, String? mode}) async {
    final value = await _command(
      'sessions.configure',
      'configure',
      {'sessionId': item.sessionId},
      {if (provider != null) 'provider': provider, if (model != null) 'model': model, if (mode != null) 'mode': mode},
    );
    _applySnapshot(SessionSnapshot(value as Map<String, dynamic>));
  }

  Future<void> sendFollowUp(WorkItem item, String text) async {
    final projectId = _projectId;
    if (projectId == null) throw StateError('Connect to a desktop project before sending a message.');
    final messageId = commandId('message');
    final base = {'protocolVersion': 1, 'commandId': messageId, 'issuedAt': isoNow(), 'caller': caller};
    Map<String, Object?> next;
    if (item.draft) {
      final catalog = providers.value;
      final selection = effectiveSelection(catalog, item.selection ?? defaultSessionSelection, models[item.selection?.provider ?? '']?.value);
      final verdict = validateSelection(catalog, selection, selection.provider != null ? models[selection.provider]?.value : null);
      if (verdict != null) throw StateError(verdict);
      next = {
        ...base,
        'operation': 'sessions.create',
        'target': _target(),
        'payload': {'title': text.length > 80 ? text.substring(0, 80) : text, 'message': text, ...selectionPayload(selection)},
      };
    } else {
      next = {
        ...base,
        'operation': 'sessions.continue',
        'target': _target({'sessionId': item.sessionId}),
        'payload': {'message': text},
      };
    }
    _commands[messageId] = (command: next, workId: item.workId, draft: item.draft);
    followUps = [
      ...followUps,
      FollowUp(messageId: messageId, sessionId: item.sessionId, workId: item.workId, text: text, state: FollowUpState.pending, createdAt: isoNow()),
    ];
    _changed();
    await _sendCommand(messageId);
  }

  Future<void> retryFollowUp(String messageId) async {
    // A lost reply keeps its command id, so a desktop that already ran it answers with the recorded outcome.
    followUps = followUps.map((message) => message.messageId == messageId ? message.copyWith(FollowUpState.pending) : message).toList();
    _changed();
    await _sendCommand(messageId);
  }

  Future<void> cancelSession(String sessionId) async {
    _applySnapshot(SessionSnapshot(await _command('sessions.cancel', 'cancel', {'sessionId': sessionId}, const {}) as Map<String, dynamic>));
  }

  /// Allowing asks the person to prove it is them first; false when they cancel.
  Future<bool> respondToPermission(String requestId, String decision) async {
    final connection = _requireConnection();
    if (decision != 'deny' && !await _identityCheck('Allow the agent to do this on $desktopLabel')) return false;
    _ensureCurrent(connection);
    await _command('permissions.respond', 'permission', {'requestId': requestId}, {'decision': decision});
    _markResolved('permission:$requestId');
    return true;
  }

  Future<void> startWorkflow(String workflowId, String task) async {
    await _command('workflowRuns.start', 'workflow', const {}, {'workflowId': workflowId, 'task': task});
  }

  Future<bool> approve(String runId) async {
    final connection = _requireConnection();
    if (!await _identityCheck('Approve this workflow run on $desktopLabel')) return false;
    _ensureCurrent(connection);
    await _command('workflowGates.approve', 'approve', {'runId': runId}, const {});
    _markResolved('approval:$runId');
    return true;
  }

  Future<bool> approveAll([String? currentRunId]) async {
    final connection = _requireConnection();
    if (!await _identityCheck('Approve all workflow runs on $desktopLabel')) return false;
    _ensureCurrent(connection);
    final toApprove = <String>{if (currentRunId != null) currentRunId};
    for (final run in workflowRuns) {
      if (run.status == 'awaiting-approval' && run.canApprove) {
        toApprove.add(run.runId);
      }
    }
    for (final item in openAttention) {
      if (item.kind == 'approval' && item.runId != null) {
        toApprove.add(item.runId!);
      }
    }
    for (final runId in toApprove) {
      try {
        _ensureCurrent(connection);
        await _command('workflowGates.approve', 'approve', {'runId': runId}, const {});
        _markResolved('approval:$runId');
      } catch (_) {
        _ensureCurrent(connection);
      }
    }
    return true;
  }

  Future<bool> reject(String runId, String reason) async {
    final connection = _requireConnection();
    if (!_offers('workflowGates.reject')) throw StateError(_updateDesktop);
    if (reason.trim().isEmpty) throw StateError('Say why you are rejecting — the reason is recorded on the run.');
    if (!await _identityCheck('Reject this workflow run on $desktopLabel')) return false;
    _ensureCurrent(connection);
    await _command('workflowGates.reject', 'reject', {'runId': runId}, {'reason': reason.trim()});
    _markResolved('approval:$runId');
    return true;
  }

  Future<void> loadRun(String runId) async {
    final connection = _live;
    if (connection == null || _connection != ShellConnection.ready) return;
    runs[runId] = RunSummary(await connection.read(readRequest('workflowRuns.get', _target({'runId': runId}))) as Map<String, dynamic>);
    _changed();
  }

  /// Answers a gadget; approving or changing answers ask the person to prove it is them first.
  Future<void> answerGadget(String sessionId, GadgetEnvelope gadget, GadgetActionDescriptor action, Map<String, Object?> value) async {
    final connection = _requireConnection();
    if (!_offers('gadgets.submit')) throw StateError(_updateDesktop);
    if (answerNeedsIdentity(action) && !await _identityCheck('${action.label} on $desktopLabel')) {
      throw StateError('Not sent — the phone could not confirm it was you.');
    }
    _ensureCurrent(connection);
    final result =
        await connection.command({
              'protocolVersion': 1,
              'commandId': commandId('gadget'),
              'issuedAt': isoNow(),
              'caller': caller,
              'target': _target({'sessionId': sessionId}),
              'operation': 'gadgets.submit',
              'payload': {
                'gadgetId': gadget.gadgetId,
                'actionId': action.actionId,
                'value': value,
                'idempotencyKey': gadgetIdempotencyKey(gadget.gadgetId, action.actionId, value),
              },
            })
            as Map<String, dynamic>?;
    final status = result?['status'];
    if (status == 'rejected' || status == 'failed') {
      final error = result?['error'];
      throw StateError((error is Map ? error['message'] as String? : null) ?? result?['message'] as String? ?? 'The desktop did not accept this answer.');
    }
  }

  Future<SessionChanges> sessionChanges(String sessionId) async {
    if ((hostInfo?.surfaceRevision ?? 0) < 5) throw StateError(_updateDesktop);
    return SessionChanges(await _requireConnection().read(readRequest('changes.get', _target({'sessionId': sessionId}))) as Map<String, dynamic>);
  }

  Future<FileDiff> fileDiff(String sessionId, String path) async =>
      FileDiff(await _requireConnection().read(readRequest('changes.get', _target({'sessionId': sessionId}), {'path': path})) as Map<String, dynamic>);

  /// Bytes for a reply/gadget image or user attachment. Reads bounded chunks
  /// because a full image is larger than the mobile protocol's record limit.
  Future<String?> imagePreview(String sessionId, String path) => _readImagePreview(sessionId, {'path': path});

  Future<String?> imageAttachmentPreview(String sessionId, SessionImageAttachment attachment) =>
      _readImagePreview(sessionId, {'eventIndex': attachment.eventIndex, 'attachmentIndex': attachment.attachmentIndex});

  Future<String?> _readImagePreview(String sessionId, Map<String, Object?> source) async {
    if (!_supports('sessions.imagePreview')) {
      Diagnostics.instance.record('Loading a chat image', StateError('The connected desktop does not support image previews. Update Praxis on the desktop.'));
      return null;
    }
    final connection = _requireConnection();
    final target = _target({'sessionId': sessionId});
    try {
      final encoded = StringBuffer();
      var offset = 0;
      String? mimeType;
      int? totalLength;
      while (true) {
        final result = await connection.read(readRequest('sessions.imagePreview', target, {...source, 'offset': offset})) as Map<String, dynamic>;
        final legacyDataUrl = result['dataUrl'];
        if (offset == 0 && legacyDataUrl is String) return legacyDataUrl;
        final chunkType = result['mimeType'];
        final chunk = result['dataBase64'];
        final nextOffset = result['nextOffset'];
        final chunkLength = result['totalLength'];
        if (chunkType is! String ||
            chunk is! String ||
            nextOffset is! int ||
            chunkLength is! int ||
            !RegExp(r'^image/(?:png|jpeg|webp|gif|bmp|avif)$').hasMatch(chunkType)) {
          Diagnostics.instance.record('Loading a chat image', StateError('The desktop returned no image data.'));
          return null;
        }
        mimeType ??= chunkType;
        totalLength ??= chunkLength;
        if (mimeType != chunkType ||
            totalLength != chunkLength ||
            nextOffset != offset + chunk.length ||
            nextOffset <= offset ||
            nextOffset > totalLength ||
            nextOffset % 4 != 0 ||
            totalLength > 16 * 1024 * 1024) {
          Diagnostics.instance.record('Loading a chat image', StateError('The desktop returned an invalid image chunk.'));
          return null;
        }
        encoded.write(chunk);
        if (nextOffset == totalLength) return 'data:$mimeType;base64,$encoded';
        offset = nextOffset;
      }
    } catch (error) {
      if (!_current(connection)) return null;
      Diagnostics.instance.record('Loading a chat image', error);
      return null;
    }
  }
}
