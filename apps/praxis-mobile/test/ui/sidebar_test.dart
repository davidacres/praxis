import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
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
  });

  tearDown(() {
    store.dispose();
    theme.dispose();
  });

  Widget app() => MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: store),
      ChangeNotifierProvider.value(value: theme),
    ],
    child: MaterialApp(
      builder: (context, child) => PraxisTheme(data: theme.data, child: child!),
      home: Scaffold(
        body: AppSidebar(visible: true, onClose: () {}),
      ),
    ),
  );

  testWidgets('sidebar renders with filter rail and sections', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.byType(AppSidebar), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is AppIcon && w.name == 'folder'), findsOneWidget);
    expect(find.text('New'), findsOneWidget);
    expect(find.text('All'), findsOneWidget);
    expect(find.text('Live'), findsOneWidget);
    expect(find.text('Gates'), findsOneWidget);
    expect(find.text('SESSIONS'), findsOneWidget);
    expect(find.text('Activity'), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is AppIcon && w.name == 'radio-tower'), findsOneWidget);
    expect(find.text('NAVIGATION'), findsNothing);
    expect(find.text('SETTINGS'), findsOneWidget);
    expect(find.text('Desktops'), findsOneWidget);
  });

  testWidgets('filter rail switches active filter tab', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(app());
    await tester.pump();

    await tester.tap(find.text('Live'));
    await tester.pump();

    await tester.tap(find.text('Gates'));
    await tester.pump();

    await tester.tap(find.text('All'));
    await tester.pump();
  });

  testWidgets('session card displays session icon, AI provider badge, and model', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Seed a work item with provider and status
    final work = const WorkItem(
      workId: 'TEST-1',
      title: 'Test AI Session',
      status: 'active',
      sessionId: 'sess-test-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    );
    store.setWorkForTesting([work]);

    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.byWidgetPredicate((w) => w is AppIcon && w.name == 'chats'), findsOneWidget); // session icon on the left
    expect(find.text('Test AI Session'), findsOneWidget);
    expect(find.text('claude-sonnet-4-6'), findsOneWidget); // model on the subtitle line
  });

  testWidgets('run card displays pipeline gauge and expands stages', (tester) async {
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
        {'nodeId': 'plan', 'name': 'Plan Stage', 'type': 'agent-task', 'lane': 'done', 'attempts': 1, 'provider': 'anthropic'},
        {'nodeId': 'impl', 'name': 'Impl Stage', 'type': 'agent-task', 'lane': 'running', 'attempts': 1, 'provider': 'codex-cli'},
      ],
    });
    store.setWorkflowRunsForTesting([run]);

    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.text('Test Workflow Pipeline'), findsOneWidget);
    expect(find.text('1/2'), findsOneWidget); // gauge progress
    expect(find.text('Impl Stage'), findsAtLeastNWidgets(1)); // active stage indicator and/or stage item
    expect(find.text('Plan Stage'), findsNWidgets(2)); // in gauge segment and in expanded stages list

    // Toggle collapse via chevron button
    await tester.tap(find.byWidgetPredicate((w) => w is AppIcon && w.name == 'chevron-down'));
    await tester.pump();

    // After collapsing, Plan Stage is only in the gauge segment
    expect(find.text('Plan Stage'), findsOneWidget);
  });

  testWidgets('activity at the top of sidebar shows icon, count and navigates to activity', (tester) async {
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
    expect(find.byWidgetPredicate((w) => w is AppIcon && w.name == 'radio-tower'), findsOneWidget);

    // Tap Activity
    await tester.tap(find.text('Activity'));
    await tester.pump();

    expect(store.primaryRoute, 'activity');
  });

  testWidgets('desktops is accessible from settings in sidebar', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.text('Desktops'), findsOneWidget);
    await tester.tap(find.text('Desktops'));
    await tester.pump();

    expect(store.desktopsVisible, isTrue);
  });
}
