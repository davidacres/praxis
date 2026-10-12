import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/screens/activity_screen.dart';
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
      home: PraxisTheme(
        data: theme.data,
        child: Scaffold(
          body: ActivityScreen(onOpenSidebar: () {}),
        ),
      ),
    ),
  );

  testWidgets('ActivityScreen renders concise status without chat transcript dump', (tester) async {
    final work = const WorkItem(
      workId: 'TEST-1',
      title: 'Feature Refactor',
      status: 'active',
      sessionId: 'sess-1',
    );
    final snapshot = SessionSnapshot({
      'sessionId': 'sess-1',
      'sessionKey': 'TEST-1',
      'startedAt': '2026-10-12T11:00:00.000Z',
      'messages': <Map<String, dynamic>>[],
    });
    store.setWorkForTesting([work]);
    store.setSnapshotForTesting(snapshot);

    await tester.pumpWidget(app());
    await tester.pump();

    expect(find.text('Activity'), findsOneWidget);
    expect(find.text('Feature Refactor'), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);

    // Tapping opens the session
    await tester.tap(find.text('Feature Refactor'));
    await tester.pump();

    expect(store.primaryRoute, 'work');
    expect(store.openWorkId, 'TEST-1');
  });
}
