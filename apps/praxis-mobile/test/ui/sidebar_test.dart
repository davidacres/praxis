import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/diagnostics.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/ui/app_icon.dart';
import 'package:praxis_mobile/ui/sidebar.dart';
import 'package:provider/provider.dart';

import '../app/desktop_registry_test.dart' show MemoryDesktopStorage;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppStore store;
  late DesktopRepository repository;
  late ThemeController theme;

  setUp(() {
    repository = DesktopRepository(MemoryDesktopStorage());
    theme = ThemeController();
    store = AppStore(theme: theme, repository: repository, initialize: false);
    store.project = (projectId: 'praxis', name: 'Praxis');
    store.availableProjects = [
      ProjectSummary({'projectId': 'praxis', 'name': 'Praxis'}),
    ];
  });

  tearDown(() {
    store.dispose();
    theme.dispose();
  });

  Widget app() => MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: store),
      ChangeNotifierProvider.value(value: theme),
      ChangeNotifierProvider.value(value: Diagnostics.instance),
    ],
    child: MaterialApp(
      builder: (context, child) => PraxisTheme(data: theme.data, child: child!),
      home: Scaffold(body: AppSidebar(onOpenNavigation: () {})),
    ),
  );

  testWidgets('home renders the desktop sections without obsolete filters', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.byType(AppSidebar), findsOneWidget);
    expect(
      find.byWidgetPredicate((w) => w is AppIcon && w.name == 'folder'),
      findsOneWidget,
    );
    expect(find.text('New'), findsOneWidget);
    expect(find.text('All'), findsNothing);
    expect(find.text('Live'), findsNothing);
    expect(find.text('Gates'), findsNothing);
    expect(find.text('SESSIONS'), findsOneWidget);
    expect(find.text('Activity'), findsOneWidget);
    expect(
      find.byWidgetPredicate((w) => w is AppIcon && w.name == 'radio-tower'),
      findsOneWidget,
    );
    expect(find.text('NAVIGATION'), findsNothing);
    expect(find.text('SETTINGS'), findsNothing);
    expect(find.text('Desktops'), findsNothing);
  });

  testWidgets('home attention shortcut follows live permissions and clears', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    store.host = (hostId: 'desktop', hostName: 'Desktop', online: true);
    store.setSnapshotForTesting(
      SessionSnapshot({
        'sessionId': 'permission-session',
        'sessionKey': 'SESSION-abcdef',
        'projectId': 'praxis',
        'title': 'Waiting session',
        'lifecycle': 'awaiting-input',
        'sequence': 1,
        'pendingPermissions': [
          {
            'requestId': 'read-file',
            'summary': 'Read source',
            'createdAt': '2026-10-24T00:00:00.000Z',
          },
        ],
      }),
    );
    await tester.pumpWidget(app());
    await tester.pump();
    expect(find.text('Attention'), findsOneWidget);
    await tester.tap(find.text('Attention'));
    await tester.pump();
    expect(store.primaryRoute, 'attention');
    expect(store.openWorkId, isNull);
    store.setSnapshotForTesting(
      SessionSnapshot({
        'sessionId': 'permission-session',
        'sessionKey': 'SESSION-abcdef',
        'projectId': 'praxis',
        'title': 'Waiting session',
        'lifecycle': 'active',
        'sequence': 2,
        'pendingPermissions': <Map<String, dynamic>>[],
      }),
    );
    await tester.pump();
    expect(find.text('Attention'), findsNothing);
  });

  testWidgets('collapsed history keeps active and waiting sessions visible', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    store.setWorkForTesting([
      for (var i = 0; i < 6; i++)
        WorkItem(
          workId: 'done-$i',
          title: 'Finished $i',
          status: 'completed',
          sessionId: 'done-$i',
        ),
      const WorkItem(
        workId: 'live',
        title: 'Still running',
        status: 'active',
        sessionId: 'live',
      ),
      const WorkItem(
        workId: 'waiting',
        title: 'Needs your reply',
        status: 'awaiting-input',
        sessionId: 'waiting',
      ),
    ]);
    await tester.pumpWidget(app());
    await tester.pump();
    expect(find.text('Still running'), findsOneWidget);
    expect(find.text('Needs your reply'), findsOneWidget);
    expect(find.text('Finished 5'), findsNothing);
    await tester.tap(find.bySemanticsLabel('Show 1 more sessions'));
    await tester.pump();
    expect(find.text('Finished 5'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Show fewer sessions'));
    await tester.pump();
    expect(find.text('Finished 5'), findsNothing);
    expect(find.text('Still running'), findsOneWidget);
    expect(find.text('Needs your reply'), findsOneWidget);
  });

  testWidgets(
    'session card displays session icon, AI provider badge, and model',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(430, 932));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      // Seed a work item with provider and status
      final work = const WorkItem(
        workId: 'TEST-1',
        title: 'Test AI Session',
        latestActivity: 'Checking workflow hooks',
        status: 'active',
        sessionId: 'sess-test-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      );
      store.setWorkForTesting([work]);

      await tester.pumpWidget(app());
      await tester.pump();

      expect(
        find.byWidgetPredicate((w) => w is AppIcon && w.name == 'chats'),
        findsOneWidget,
      ); // session icon on the left
      expect(find.text('Test AI Session'), findsOneWidget);
      expect(find.text('Checking workflow hooks'), findsOneWidget);
      expect(
        find.text('claude-sonnet-4-6'),
        findsOneWidget,
      ); // model on the subtitle line
      await tester.tap(find.text('Test AI Session'));
      await tester.pump();
      expect(store.primaryRoute, 'work');
      expect(store.openWorkId, 'TEST-1');
    },
  );

  testWidgets('run card displays pipeline gauge and expands stages', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Seed a workflow run with stages
    final run = RunSnapshot({
      'runId': 'run-test-1',
      'workflowName': 'Test Workflow Pipeline',
      'status': 'running',
      'explanation': 'Running workflow',
      'startedAt': '2026-10-10T10:00:00.000Z',
      'aiProvider': 'anthropic',
      'stages': [
        {
          'nodeId': 'plan',
          'name': 'Plan Stage',
          'type': 'agent-task',
          'lane': 'done',
          'attempts': 1,
          'provider': 'anthropic',
        },
        {
          'nodeId': 'impl',
          'name': 'Impl Stage',
          'type': 'agent-task',
          'lane': 'running',
          'attempts': 1,
          'provider': 'codex-cli',
        },
      ],
    });
    store.setWorkflowRunsForTesting([run]);

    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.text('Test Workflow Pipeline'), findsOneWidget);
    expect(find.text('1/2'), findsOneWidget); // gauge progress
    expect(
      find.text('Impl Stage'),
      findsAtLeastNWidgets(1),
    ); // active stage indicator and/or stage item
    expect(
      find.text('Plan Stage'),
      findsNWidgets(2),
    ); // in gauge segment and in expanded stages list

    // Toggle collapse via chevron button
    await tester.tap(
      find
          .byWidgetPredicate((w) => w is AppIcon && w.name == 'chevron-down')
          .last,
    );
    await tester.pump();

    // After collapsing, Plan Stage is only in the gauge segment
    expect(find.text('Plan Stage'), findsOneWidget);
    await tester.tap(find.text('Test Workflow Pipeline'));
    await tester.pump();
    expect(store.openRunId, 'run-test-1');
  });

  testWidgets('activity at the top of home navigates to activity', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Seed session activity
    final work = const WorkItem(
      workId: 'TEST-ACT-1',
      title: 'Activity Session',
      status: 'active',
      sessionId: 'sess-act-1',
    );
    store.setWorkForTesting([work]);

    await tester.pumpWidget(app());
    await tester.pump();

    // Verify Activity button at top
    expect(find.text('Activity'), findsOneWidget);
    expect(find.text('1'), findsAtLeastNWidgets(1)); // count badge
    expect(
      find.byWidgetPredicate((w) => w is AppIcon && w.name == 'radio-tower'),
      findsOneWidget,
    );

    // Tap Activity
    await tester.tap(find.text('Activity'));
    await tester.pump();

    expect(store.primaryRoute, 'activity');
  });

  testWidgets('drawer holds navigation and settings', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var closed = false;
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: store),
          ChangeNotifierProvider.value(value: theme),
          ChangeNotifierProvider.value(value: Diagnostics.instance),
        ],
        child: MaterialApp(
          builder: (context, child) =>
              PraxisTheme(data: theme.data, child: child!),
          home: Scaffold(
            body: AppNavigationDrawer(
              onClose: () => closed = true,
              onGoHome: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Sessions'), findsOneWidget);
    expect(find.text('Attention'), findsOneWidget);
    expect(find.text('Desktops'), findsOneWidget);
    expect(find.text('SETTINGS'), findsOneWidget);
    await tester.tap(find.text('Desktop connection'));
    await tester.pump();
    expect(find.bySemanticsLabel('Back to navigation'), findsOneWidget);
    await tester.ensureVisible(find.text('Switch desktop'));
    await tester.tap(find.text('Switch desktop'));
    await tester.pump();
    expect(closed, isTrue);
    expect(store.desktopsVisible, isTrue);
  });

  testWidgets('title chip drops down available projects', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    store.dispose();
    store = _RecordingProjectStore(theme: theme, repository: repository);
    store.project = (projectId: 'alpha', name: 'Alpha');
    store.availableProjects = [
      ProjectSummary({'projectId': 'alpha', 'name': 'Alpha'}),
      ProjectSummary({'projectId': 'beta', 'name': 'Beta'}),
    ];
    await tester.pumpWidget(app());
    await tester.pump();

    await tester.tap(find.bySemanticsLabel('Switch project, Alpha'));
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel('Use project Alpha'), findsOneWidget);
    expect(find.bySemanticsLabel('Use project Beta'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Use project Beta'));
    await tester.pumpAndSettle();
    expect((store as _RecordingProjectStore).selectedProjectId, 'beta');
  });
}

class _RecordingProjectStore extends AppStore {
  _RecordingProjectStore({required super.theme, required super.repository})
    : super(initialize: false);

  String? selectedProjectId;

  @override
  Future<void> selectProject(String id) async {
    selectedProjectId = id;
    project = (projectId: id, name: 'Beta');
    notifyListeners();
  }
}
