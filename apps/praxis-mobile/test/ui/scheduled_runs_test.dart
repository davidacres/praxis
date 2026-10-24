import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/models.dart';
import 'package:praxis_mobile/ui/scheduled_runs.dart';
import '../app/desktop_registry_test.dart' show MemoryDesktopStorage;

class ScheduleStore extends AppStore {
  ScheduleStore(ThemeController theme) : super(theme: theme, repository: DesktopRepository(MemoryDesktopStorage()), initialize: false);
  Map<String, Object?>? saved;
  @override
  Future<List<Map<String, dynamic>>> scheduleTickets() async => [
    {'workId': 'PRX-1', 'title': 'First ticket'}, {'workId': 'PRX-2', 'title': 'Second ticket'},
  ];
  @override
  Future<void> createSchedule(Map<String, Object?> input) async {
    saved = input;
    schedules = Remote(RemoteStatus.ready, [ScheduledRunSnapshot({'id': 'created', 'projectId': 'praxis', 'name': input['name']})]);
    notifyListeners();
  }
}

void main() {
  testWidgets('composer saves tickets in chosen order and keeps UTC explicit', (tester) async {
    final theme = ThemeController();
    final store = ScheduleStore(theme);
    addTearDown(() { store.dispose(); theme.dispose(); });
    await tester.pumpWidget(ChangeNotifierProvider<AppStore>.value(value: store, child: MaterialApp(
      builder: (context, child) => PraxisTheme(data: theme.data, child: child!),
      home: Scaffold(body: ScheduleComposer(contextKey: store.contextKey)),
    )));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'Evening checks');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Queue PRX-2'));
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Queue PRX-1'));
    await tester.pump();
    await tester.ensureVisible(find.bySemanticsLabel('Save schedule draft'));
    await tester.tap(find.bySemanticsLabel('Save schedule draft'));
    await tester.pump();
    expect(store.saved?['issueKeys'], ['PRX-2', 'PRX-1']);
    expect(store.saved?['timezone'], 'UTC');
    expect(store.saved?['name'], 'Evening checks');
  });

  testWidgets('saving from the home bottom sheet closes safely during live list updates', (tester) async {
    final theme = ThemeController();
    final store = ScheduleStore(theme);
    addTearDown(() { store.dispose(); theme.dispose(); });
    store.hostInfo = HostInfo({'readOperations': ['scheduledRuns.list'], 'commandOperations': ['scheduledRuns.save']});
    store.setConnectionForTesting(ShellConnection.ready);
    store.schedules = const Remote(RemoteStatus.ready, <ScheduledRunSnapshot>[]);
    await tester.pumpWidget(ChangeNotifierProvider<AppStore>.value(value: store, child: MaterialApp(
      builder: (context, child) => PraxisTheme(data: theme.data, child: child!),
      home: const Scaffold(body: SingleChildScrollView(child: ScheduledRunsSection())),
    )));
    await tester.tap(find.bySemanticsLabel('New scheduled run'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Modal save');
    await tester.pump();
    await tester.tap(find.bySemanticsLabel('Queue PRX-1'));
    await tester.pump();
    await tester.ensureVisible(find.bySemanticsLabel('Save schedule draft'));
    await tester.tap(find.bySemanticsLabel('Save schedule draft'));
    await tester.pumpAndSettle();
    expect(find.byType(ScheduleComposer), findsNothing);
    expect(find.text('Modal save'), findsOneWidget);
    expect(tester.takeException(), isNull);
    store.disconnect();
  });

  testWidgets('older desktop shows upgrade guidance without schedule controls', (tester) async {
    final theme = ThemeController();
    final store = ScheduleStore(theme);
    addTearDown(() { store.dispose(); theme.dispose(); });
    store.schedules = const Remote(RemoteStatus.ready, <ScheduledRunSnapshot>[]);
    await tester.pumpWidget(ChangeNotifierProvider<AppStore>.value(value: store, child: MaterialApp(
      builder: (context, child) => PraxisTheme(data: theme.data, child: child!),
      home: const Scaffold(body: ScheduledRunsSection()),
    )));
    expect(find.text('Update Praxis on the desktop to share scheduled runs with this phone.'), findsOneWidget);
    expect(find.bySemanticsLabel('New scheduled run'), findsNothing);
  });
}
