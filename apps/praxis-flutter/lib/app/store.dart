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
import 'confirm_identity.dart';
import 'connection.dart';
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
    this.gadgets = const [],
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
  final List<GadgetView> gadgets;
  final String? model;
  final TokenUsage? tokens;
  final Cost? cost;

  TranscriptMessage withMeta({String? model, TokenUsage? tokens, Cost? cost}) => TranscriptMessage(
    id: id,
    author: author,
    text: text,
    at: at,
    streaming: streaming,
    gadgets: gadgets,
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
      gadgets: message.gadgets,
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

class AppStore extends ChangeNotifier {
  AppStore({required this.theme}) {
    _lifecycle = AppLifecycleListener(onResume: _onResume);
    loadDesktopAppearance()
        .then((stored) {
          if (stored != null && theme.appearance == null) theme.applyAppearance(stored);
        })
        .catchError((Object error) => Diagnostics.instance.record('Loading the saved desktop theme', error));
  }

  final ThemeController theme;
  late final AppLifecycleListener _lifecycle;

  // ---------------------------------------------------------------- state

  ShellConnection _connection = ShellConnection.offline;
  String primaryRoute = 'work';
  String detail = 'chat';
  bool autoConnectEnabled = true;
  ({String hostId, String hostName, bool online}) host = (hostId: '', hostName: '', online: false);
  HostInfo? hostInfo;
  HostConfiguration? hostConfig;
  ({String projectId, String name}) project = (projectId: '', name: '');
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
    if (appearance != null && theme.applyAppearance(appearance)) {
      saveDesktopAppearance(appearance).catchError((Object error) => Diagnostics.instance.record('Saving the desktop theme', error));
    }
  }

  void _applySnapshot(SessionSnapshot snapshot) {
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
    _reconnectTimer = Timer(delay, () {
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
      info = null; // A desktop from before revision 2: no catalog, usage or access reads.
    }
    final epochChanged = hostInfo?.hostEpoch != info?.hostEpoch;
    hostInfo = info;
    _wearAppearance(info?.appearance);
    if (epochChanged) {
      // The desktop restarted: its event sequence restarted too.
      _cursor.reset(info?.latestSequence ?? 0);
      _snapshots = {};
      _usageReads.clear();
    }
    host = (hostId: config.hostId, hostName: info?.hostName ?? config.hostName?.trim() ?? config.address, online: true);

    ProjectSummary projectSummary;
    if (config.projectId != null) {
      projectSummary = ProjectSummary(
        await connection.read(readRequest('projects.snapshot', {...hostTarget, 'projectId': config.projectId})) as Map<String, dynamic>,
      );
    } else {
      final available = await connection.read(readRequest('projects.snapshot', hostTarget)) as Map<String, dynamic>;
      final projects = (available['projects'] as List? ?? const []).whereType<Map<String, dynamic>>().toList();
      if (projects.isEmpty) {
        throw StateError('This phone has not been granted access to a project. Change its grant in Settings → Mobile access on the desktop.');
      }
      projectSummary = ProjectSummary(projects.first);
    }
    final projectId = projectSummary.projectId;
    final target = {...hostTarget, 'projectId': projectId};
    _projectId = projectId;
    project = (projectId: projectId, name: projectSummary.name);
    final saved = config.withProject(projectId);
    await saveHostConfiguration(saved);

    final sessions = (await _readList(
      connection,
      'sessions.list',
      target,
    )).whereType<Map<String, dynamic>>().map(SessionSnapshot.new).where((session) => !session.archived).toList();
    final loaded = await Future.wait(
      sessions.map(
        (session) async =>
            SessionSnapshot(await connection.read(readRequest('sessions.get', {...target, 'sessionId': session.sessionId})) as Map<String, dynamic>),
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
        providers = Remote(RemoteStatus.error, null, Diagnostics.messageOf(error));
      }
    } else {
      providers = const Remote(
        RemoteStatus.unsupported,
        null,
        'This desktop does not share its AI providers with the phone. Update Praxis on the desktop to choose a provider and model here.',
      );
    }
    if (info?.readOperations.contains('access.get') ?? false) {
      try {
        access = Remote(RemoteStatus.ready, DeviceAccess(await connection.read(readRequest('access.get', hostTarget)) as Map<String, dynamic>));
      } catch (error) {
        access = Remote(RemoteStatus.error, null, Diagnostics.messageOf(error));
      }
    } else {
      access = const Remote(RemoteStatus.unsupported, null, 'This desktop does not report the phone’s access grant. Update Praxis on the desktop.');
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
    final connection = NativeMobileConnection(config);
    _live = connection;
    hostConfig = config;
    bool current() => identical(_live, connection);
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
    try {
      await connection.connect();
      if (!current()) return;
      var effective = config;
      if (config.pairingTokenId != null) {
        effective = config.withoutInvitation();
        hostConfig = effective;
      }
      final saved = await _bootstrap(connection, effective);
      if (!current()) return;
      hostConfig = saved;
      _reconnectAttempt = 0;
      connectionIssue = null;
      pairing = null;
      _setPhase(ShellConnection.ready);
    } catch (error) {
      if (!current()) return;
      _closeConnection();
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
            _polledAttention = (items is List ? items : const <Object?>[]).whereType<Map<String, dynamic>>().map(AttentionItem.fromJson).toList();
            Diagnostics.instance.refreshSucceeded();
            _changed();
          })
          .catchError((Object error) => Diagnostics.instance.refreshFailed('Refreshing attention', error));
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
          final info = HostInfo(value as Map<String, dynamic>);
          if (info.hostEpoch != hostInfo?.hostEpoch) return _openConnection(config, reconnect: true);
          return connection.replay(_cursor.sequence).then((_) {});
        })
        .catchError((Object error) {
          Diagnostics.instance.record('Checking the desktop after returning to the app', error);
          _setPhase(ShellConnection.reconnecting);
          _reconnectAttempt = 0;
          _openConnection(config, reconnect: true);
        });
  }

  @override
  void dispose() {
    _disposed = true;
    _lifecycle.dispose();
    _clearReconnectTimer();
    _attentionTimer?.cancel();
    _closeConnection();
    super.dispose();
  }

  // ---------------------------------------------------------------- connect / navigation

  Future<void> connect(HostConfiguration config) {
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
    _clearReconnectTimer();
    _closeConnection();
    autoConnectEnabled = false;
    pairing = null;
    _setPhase(ShellConnection.offline);
  }

  void disconnect({bool forget = false}) {
    _clearReconnectTimer();
    _closeConnection();
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
    if (forget) {
      hostConfig = null;
      forgetHostConfiguration();
      theme.applyAppearance(null);
    }
    _setPhase(ShellConnection.offline);
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
    work = [WorkItem(workId: id, title: 'New chat', status: 'idle', sessionId: id, draft: true, selection: defaultSessionSelection), ...work];
    openWorkId = id;
    primaryRoute = 'work';
    detail = 'chat';
    _changed();
  }

  void updateDraftSelection(String workId, SessionSelection Function(SessionSelection current) patch) {
    work = work.map((item) => item.workId == workId && item.draft ? item.withSelection(patch(item.selection ?? defaultSessionSelection)) : item).toList();
    _changed();
  }

  // ---------------------------------------------------------------- actions

  Map<String, Object?> _target([Map<String, String?> extra = const {}]) => {
    'hostId': hostConfig?.hostId ?? host.hostId,
    if (_projectId != null) 'projectId': _projectId,
    for (final entry in extra.entries)
      if (entry.value != null) entry.key: entry.value,
  };

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
    try {
      final value = await _requireConnection().command(entry.command);
      final snapshot = SessionSnapshot(value as Map<String, dynamic>);
      _commands.remove(messageId);
      _applySnapshot(snapshot);
      openWorkId = snapshot.sessionKey;
      if (entry.draft) work = work.where((item) => !item.draft || item.workId != entry.workId).toList();
      followUps = followUps.where((message) => message.messageId != messageId).toList();
      _changed();
    } catch (error) {
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
    // Same command id: if the desktop already ran it, it answers with the recorded outcome.
    followUps = followUps.map((message) => message.messageId == messageId ? message.copyWith(FollowUpState.pending) : message).toList();
    _changed();
    await _sendCommand(messageId);
  }

  Future<void> cancelSession(String sessionId) async {
    _applySnapshot(SessionSnapshot(await _command('sessions.cancel', 'cancel', {'sessionId': sessionId}, const {}) as Map<String, dynamic>));
  }

  /// Allowing asks the person to prove it is them first; false when they cancel.
  Future<bool> respondToPermission(String requestId, String decision) async {
    if (decision == 'allow' && !await confirmIdentity('Allow the agent to do this on your desktop')) return false;
    await _command('permissions.respond', 'permission', {'requestId': requestId}, {'decision': decision});
    _markResolved('permission:$requestId');
    return true;
  }

  Future<void> startWorkflow(String workflowId, String task) async {
    await _command('workflowRuns.start', 'workflow', const {}, {'workflowId': workflowId, 'task': task});
  }

  Future<bool> approve(String runId) async {
    if (!await confirmIdentity('Approve this workflow run')) return false;
    await _command('workflowGates.approve', 'approve', {'runId': runId}, const {});
    _markResolved('approval:$runId');
    return true;
  }

  Future<bool> reject(String runId, String reason) async {
    if (!_offers('workflowGates.reject')) throw StateError(_updateDesktop);
    if (reason.trim().isEmpty) throw StateError('Say why you are rejecting — the reason is recorded on the run.');
    if (!await confirmIdentity('Reject this workflow run')) return false;
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
    if (!_offers('gadgets.submit')) throw StateError(_updateDesktop);
    if (answerNeedsIdentity(action) && !await confirmIdentity(action.label)) throw StateError('Not sent — the phone could not confirm it was you.');
    final result =
        await _requireConnection().command({
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
}
