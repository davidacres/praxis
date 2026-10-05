import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/connection.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/protocol/wire.dart';

import 'desktop_registry_test.dart' show MemoryDesktopStorage, hostConfig, lightAppearance;

/// Deliberately colliding IDs and epochs. Deferred responses can be delivered
/// even after close to prove store isolation rather than relying on sockets.
class ControlledDesktop extends NativeMobileConnection {
  ControlledDesktop(super.config);
  bool closed = false;
  Completer<void>? heldConnect;
  bool failConnect = false;
  String? reportedHostId;
  final heldReads = <String, Completer<Object?>>{};
  Completer<Object?>? heldCommand;
  final commands = <Map<String, Object?>>[];
  final historicalEvents = <void Function(Map<String, dynamic>)>[];
  final events = <void Function(Map<String, dynamic>)>[];

  Map<String, dynamic> get snapshot => {
    'sessionId': 'same-session',
    'sessionKey': 'same-work',
    'projectId': 'same-project',
    'title': '${config.hostId} conversation',
    'lifecycle': 'idle',
    'sequence': 1,
    'messages': <Object?>[],
  };
  @override
  Future<void> connect() async {
    if (failConnect) throw MobileConnectionError('unreachable', 'Desktop unavailable', true);
    await heldConnect?.future;
  }

  @override
  Future<Object?> read(Map<String, Object?> request) async {
    final op = request['operation'] as String;
    final held = heldReads[op];
    if (held != null) return held.future;
    return switch (op) {
      'host.info' => {
        'hostId': reportedHostId ?? config.hostId,
        'hostName': '${config.hostId} reported name',
        'surfaceRevision': 7,
        'hostEpoch': 'same-epoch',
        'latestSequence': 1,
        if (config.hostId == 'A') 'appearance': lightAppearance.raw,
        'readOperations': ['access.get', 'providers.list', 'sessions.usage', 'models.list', 'workflowRuns.list'],
        'commandOperations': ['sessions.continue', 'sessions.create', 'workflowGates.approve', 'permissions.respond'],
      },
      'access.get' => {
        'projects': <Object?>[],
        'capabilities': ['view', 'execute', 'approve'],
      },
      'projects.snapshot' => {
        'projects': [
          {'projectId': 'same-project', 'name': '${config.hostId} project'},
        ],
      },
      'sessions.list' => [snapshot],
      'sessions.get' => snapshot,
      'providers.list' => {
        'providers': [
          {'provider': config.hostId, 'label': config.hostId, 'available': true},
        ],
      },
      'models.list' => {
        'models': [
          {'modelId': config.hostId},
        ],
      },
      'sessions.usage' => {
        'tokenUsage': {'totalTokens': config.hostId == 'A' ? 100 : 200},
      },
      _ => [],
    };
  }

  @override
  Future<Object?> command(Map<String, Object?> command) async {
    commands.add(command);
    return heldCommand?.future ?? snapshot;
  }

  @override
  Future<Object?> replay(int afterSequence) async => {'replaying': true};
  @override
  void Function() subscribe(void Function(Map<String, dynamic>) listener) {
    events.add(listener);
    historicalEvents.add(listener);
    return () => events.remove(listener);
  }

  @override
  void close() {
    closed = true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppStore store;
  late DesktopRepository repository;
  late List<ControlledDesktop> connections;
  Completer<bool>? identity;
  setUp(() {
    connections = [];
    identity = null;
    repository = DesktopRepository(MemoryDesktopStorage());
    store = AppStore(
      theme: ThemeController(),
      repository: repository,
      initialize: false,
      connectionFactory: (config) {
        final connection = ControlledDesktop(config);
        connections.add(connection);
        return connection;
      },
      identityCheck: (_) => identity?.future ?? Future.value(true),
    );
  });
  tearDown(() => store.dispose());

  test('pairing A then B is additive; same IDs, projects and appearance stay scoped', () async {
    await store.connect(hostConfig('A'));
    final a = store.selectedDesktop!;
    expect(store.theme.appearance!.themeName, 'Praxis Light');
    store.saveComposerDraft(a.entryId, 'same-work', 'Unsent for A');
    await store.connect(hostConfig('B'));
    expect(connections.first.closed, isTrue);
    expect(store.desktops.entries, hasLength(2));
    expect(store.work.single.title, 'B conversation');
    expect(store.composerDraft('same-work'), isNull);
    expect(store.theme.appearance, isNull);
    await store.selectDesktop(a.entryId);
    expect(store.work.single.title, 'A conversation');
    expect(store.composerDraft('same-work')!.text, 'Unsent for A');
  });

  test('delayed A bootstrap cannot mutate or persist B', () async {
    final held = Completer<Object?>();
    final original = ControlledDesktop(hostConfig('A'))..heldReads['host.info'] = held;
    store.dispose();
    store = AppStore(
      theme: ThemeController(),
      repository: repository,
      initialize: false,
      connectionFactory: (config) => config.hostId == 'A' ? original : ControlledDesktop(config),
    );
    final connectingA = store.connect(hostConfig('A'));
    await Future<void>.delayed(Duration.zero);
    await store.connect(hostConfig('B'));
    held.complete({'hostId': 'A', 'hostName': 'Wrong desktop', 'appearance': lightAppearance.raw});
    await connectingA;
    expect(store.host.hostId, 'B');
    expect(store.work.single.title, 'B conversation');
    expect((await repository.load()).entries.map((e) => e.configuration.hostId), ['A', 'B']);
    expect((await repository.load()).entries.first.configuration.hostName, 'Desktop');
    expect(store.theme.appearance, isNull);
  });

  test('rapid A-B-A switches discard retired transport events even with colliding sequences', () async {
    await store.connect(hostConfig('A'));
    final oldA = connections.first;
    await store.connect(hostConfig('B'));
    await store.connect(hostConfig('A'));
    for (final listener in oldA.historicalEvents) {
      listener({
        'sequence': 1000,
        'event': {
          'type': 'session.snapshot',
          'snapshot': {...oldA.snapshot, 'title': 'stale', 'sequence': 1000},
        },
      });
    }
    expect(store.work.single.title, 'A conversation');
    expect(connections.take(2).every((connection) => connection.closed), isTrue);
  });

  test('pending biometric approval cannot send to newly selected desktop', () async {
    await store.connect(hostConfig('A'));
    identity = Completer<bool>();
    final approval = store.approve('colliding-run');
    final expectation = expectLater(approval, throwsStateError);
    await store.connect(hostConfig('B'));
    identity!.complete(true);
    await expectation;
    expect(connections.every((connection) => connection.commands.isEmpty), isTrue);
  });

  test('late command outcome neither opens nor marks a conversation on B', () async {
    await store.connect(hostConfig('A'));
    final a = connections.first;
    a.heldCommand = Completer<Object?>();
    final sending = store.sendFollowUp(store.work.single, 'Only A');
    await store.connect(hostConfig('B'));
    a.heldCommand!.complete({...a.snapshot, 'title': 'Late result'});
    await sending;
    expect(store.work.single.title, 'B conversation');
    expect(store.followUps, isEmpty);
    expect(a.commands, hasLength(1));
    expect(connections.last.commands, isEmpty);
    expect((a.commands.single['target'] as Map)['hostId'], 'A');
  });

  test('a failed selected desktop offers retry without falling back', () async {
    await store.connect(hostConfig('A'));
    final b = (await repository.saveAuthenticated(hostConfig('B'))).active!;
    store.dispose();
    store = AppStore(
      theme: ThemeController(),
      repository: repository,
      initialize: false,
      connectionFactory: (config) => ControlledDesktop(config)..failConnect = config.hostId == 'B',
    );
    await store.selectDesktop(b.entryId);
    expect(store.connection, ShellConnection.offline);
    expect(store.hostConfig!.hostId, 'B');
    expect(store.connectionIssue, isNotNull);
    expect((await repository.load()).active!.configuration.hostId, 'B');
    expect(store.work, isEmpty);
  });

  test('cancelled pairing leaves previously saved desktops intact', () async {
    await store.connect(hostConfig('A'));
    final held = Completer<void>();
    store.dispose();
    store = AppStore(
      theme: ThemeController(),
      repository: repository,
      initialize: false,
      connectionFactory: (config) => ControlledDesktop(config)..heldConnect = held,
    );
    final pairing = store.connect(hostConfig('B', invitation: 'candidate'));
    await Future<void>.delayed(Duration.zero);
    store.cancelConnect();
    held.complete();
    await pairing;
    expect((await repository.load()).entries.map((entry) => entry.configuration.hostId), ['A']);
  });

  test('startup uses only the saved selection, and forget removes only its drafts', () async {
    final a = (await repository.saveAuthenticated(hostConfig('A'))).active!;
    final b = (await repository.saveAuthenticated(hostConfig('B'))).active!;
    store.dispose();
    store = AppStore(theme: ThemeController(), repository: repository, connectionFactory: (config) => ControlledDesktop(config));
    await store.startup;
    expect(store.host.hostId, 'B');
    await store.forgetDesktop(b.entryId);
    expect(store.connection, ShellConnection.offline);
    expect(store.desktopsVisible, isTrue);
    expect(store.desktops.entries.single.entryId, a.entryId);
    expect(store.desktops.active, isNull);
  });

  test('a desktop reporting another host ID is not left saved', () async {
    store.dispose();
    store = AppStore(
      theme: ThemeController(),
      repository: repository,
      initialize: false,
      connectionFactory: (config) => ControlledDesktop(config)..reportedHostId = 'other',
    );
    await store.connect(hostConfig('A', invitation: 'candidate'));
    expect(store.connection, ShellConnection.offline);
    expect(store.connectionIssue, isNotNull);
    expect((await repository.load()).entries, isEmpty);
    expect(store.desktops.entries, isEmpty);
  });

  test('adding a desktop does not keep the previous one selected', () async {
    await store.connect(hostConfig('A'));
    expect(store.selectedDesktop, isNotNull);
    store.addDesktop();
    expect(store.selectedDesktop, isNull);
    expect(store.composerDraft('same-work'), isNull);
  });

  test('empty drafts are not stored and clearing text removes the stored draft', () async {
    await store.connect(hostConfig('A'));
    final id = store.selectedDesktop!.entryId;
    store.startNewChat();
    await Future<void>.delayed(Duration.zero);
    expect((await repository.load()).find(id)!.drafts, isEmpty);
    store.saveComposerDraft(id, 'same-work', 'typed');
    await Future<void>.delayed(Duration.zero);
    expect((await repository.load()).find(id)!.drafts.keys, ['same-work']);
    store.saveComposerDraft(id, 'same-work', '  ');
    await Future<void>.delayed(Duration.zero);
    expect((await repository.load()).find(id)!.drafts, isEmpty);
    expect(store.composerDraft('same-work'), isNull);
  });
}
