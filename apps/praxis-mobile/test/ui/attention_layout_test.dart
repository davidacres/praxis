import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/screens/attention_screen.dart';
import 'package:praxis_mobile/ui/kit.dart';
import 'package:praxis_mobile/ui/permission_card.dart';
import 'package:provider/provider.dart';

void main() {
  testWidgets('PermissionCard renders title header, dividing line, and right-aligned buttons', (tester) async {
    final theme = ThemeController();
    final store = AppStore(theme: theme);
    addTearDown(store.dispose);

    final item = AttentionItem(
      id: 'permission:req-1',
      kind: 'permission',
      hostId: 'host-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      summary: 'Read a file or project resource',
      detail: 'The agent needs to inspect index.ts',
      createdAt: '2026-09-26T20:00:00.000Z',
    );

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      ChangeNotifierProvider<AppStore>.value(
        value: store,
        child: MaterialApp(
          home: PraxisTheme(
            data: theme.data,
            child: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(16),
                child: PermissionCard(
                  item: item,
                  subject: 'Pre-fill the saved address',
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // Verify "Permission Request" header is displayed and Pill is not used
    expect(find.text('Permission Request'), findsOneWidget);
    expect(find.text('permission'), findsNothing);

    // Verify subject, summary, and detail are stacked
    expect(find.text('Pre-fill the saved address'), findsOneWidget);
    expect(find.text('Read a file or project resource'), findsOneWidget);
    expect(find.text('The agent needs to inspect index.ts'), findsOneWidget);

    // Verify buttons are present
    final denyFinder = find.widgetWithText(PraxisButton, 'Deny');
    final allowFinder = find.widgetWithText(PraxisButton, 'Allow once');
    expect(denyFinder, findsOneWidget);
    expect(allowFinder, findsOneWidget);

    // Verify buttons are right-aligned
    final denyRect = tester.getRect(denyFinder);
    final allowRect = tester.getRect(allowFinder);
    final cardRect = tester.getRect(find.byType(PraxisCard));

    expect(denyRect.right, lessThan(allowRect.left));
    // Allow button should be near the right padding of the card
    expect(allowRect.right, closeTo(cardRect.right - theme.data.space, 1.0));
  });

  testWidgets('AttentionScreen renders Approval Required with divider and right-aligned buttons', (tester) async {
    final theme = ThemeController();
    final store = AppStore(theme: theme);
    addTearDown(store.dispose);

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Put a run needing approval in workflowRuns
    final run = RunSnapshot({
      'runId': 'run-1',
      'projectId': '',
      'workflowName': 'Release review — Checkout 2.4',
      'status': 'awaiting-approval',
      'paused': false,
      'explanation': 'A run is waiting for your approval.',
      'startedAt': '2026-09-26T20:00:00.000Z',
      'canApprove': true,
      'sequence': 1,
      'stages': <dynamic>[],
    });
    store.runsSupported = true;
    store.hostInfo = HostInfo({
      'commandOperations': ['workflowGates.reject', 'workflowGates.approve', 'workflowRuns.retryStage'],
      'readOperations': ['workflowRuns.list'],
      'surfaceRevision': 5,
    });
    store.setConnectionForTesting(ShellConnection.ready);
    store.workflowRuns = [run];

    await tester.pumpWidget(
      ChangeNotifierProvider<AppStore>.value(
        value: store,
        child: MaterialApp(
          home: PraxisTheme(
            data: theme.data,
            child: Scaffold(
              body: AttentionScreen(onOpenSidebar: () {}),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // Verify "Approval Required" header is displayed and Pill is not used
    expect(find.text('Approval Required'), findsOneWidget);
    expect(find.text('approval'), findsNothing);

    // Verify subject and body
    expect(find.text('Release review — Checkout 2.4'), findsOneWidget);
    expect(find.text('A run is waiting for your approval.'), findsOneWidget);

    // Verify only 2 action buttons for approval: Deny… and Approve
    final approveFinder = find.text('Approve');
    final denyFinder = find.text('Deny…');
    expect(approveFinder, findsOneWidget);
    expect(denyFinder, findsOneWidget);

    // Verify Open run is an inline button in the subject row, not a bottom card button
    final openRunFinder = find.text('Open run');
    expect(openRunFinder, findsOneWidget);
    // Open run should be above Approve
    expect(tester.getCenter(openRunFinder).dy, lessThan(tester.getCenter(approveFinder).dy));

    // Verify Approve and Deny… are right-aligned
    final approveCenter = tester.getCenter(approveFinder).dx;
    final screenCenter = 390 / 2;
    expect(approveCenter, greaterThan(screenCenter));
    expect(tester.getCenter(denyFinder).dx, greaterThan(screenCenter - 50));

    store.dispose();
  });

  testWidgets('AttentionScreen renders Step Failed with divider and right-aligned buttons', (tester) async {
    final theme = ThemeController();
    final store = AppStore(theme: theme);
    addTearDown(store.dispose);

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Put a run with a failed stage
    final run = RunSnapshot({
      'runId': 'run-2',
      'projectId': '',
      'workflowName': 'Integration tests',
      'status': 'failed',
      'paused': false,
      'explanation': 'Tests failed',
      'startedAt': '2026-09-26T20:00:00.000Z',
      'canApprove': false,
      'sequence': 2,
      'stages': [
        {'nodeId': 'test-node', 'name': 'Unit tests', 'lane': 'failed', 'type': 'check', 'attempts': 1, 'lastError': 'Assertion failed at line 42'},
      ],
    });
    store.runsSupported = true;
    store.hostInfo = HostInfo({
      'commandOperations': ['workflowGates.reject', 'workflowGates.approve', 'workflowRuns.retryStage'],
      'readOperations': ['workflowRuns.list'],
      'surfaceRevision': 5,
    });
    store.setConnectionForTesting(ShellConnection.ready);
    store.workflowRuns = [run];

    await tester.pumpWidget(
      ChangeNotifierProvider<AppStore>.value(
        value: store,
        child: MaterialApp(
          home: PraxisTheme(
            data: theme.data,
            child: Scaffold(
              body: AttentionScreen(onOpenSidebar: () {}),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // Verify "Step Failed" header is displayed and Pill is not used
    expect(find.text('Step Failed'), findsOneWidget);
    expect(find.text('failure'), findsNothing);

    // Verify error detail is displayed
    expect(find.text('Assertion failed at line 42'), findsOneWidget);

    // Verify Open run is in the subject row
    final openRunFinder = find.text('Open run');
    expect(openRunFinder, findsOneWidget);

    // Verify Retry step button exists and is right-aligned
    final retryFinder = find.widgetWithText(PraxisButton, 'Retry step');
    expect(retryFinder, findsOneWidget);
    final retryRect = tester.getRect(retryFinder);
    final cardRect = tester.getRect(find.byType(PraxisCard));
    expect(retryRect.right, closeTo(cardRect.right - theme.data.space, 1.0));

    store.dispose();
  });
}
