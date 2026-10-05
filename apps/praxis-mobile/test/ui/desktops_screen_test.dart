import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/desktop_registry.dart';
import 'package:praxis_mobile/app/store.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/screens/desktops_screen.dart';
import 'package:provider/provider.dart';

import '../app/desktop_registry_test.dart' show MemoryDesktopStorage, hostConfig, lightAppearance;

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
      home: const Scaffold(body: SafeArea(child: DesktopsScreen())),
    ),
  );

  testWidgets('empty picker offers additive pairing', (tester) async {
    await tester.runAsync(store.reloadDesktops);
    await tester.pumpWidget(app());
    expect(find.text('No saved desktops. Add one with its pairing invitation.'), findsOneWidget);
    await tester.tap(find.text('Add desktop'));
    expect(store.pairingFormVisible, isTrue);
    expect(store.desktopsVisible, isFalse);
  });

  testWidgets('nickname reset and named forget preserve the other desktop', (tester) async {
    await tester.runAsync(() async {
      await repository.saveAuthenticated(hostConfig('A'));
      await repository.saveAuthenticated(hostConfig('B'));
    });
    await tester.runAsync(store.reloadDesktops);
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(app());
    await tester.tap(find.bySemanticsLabel('Rename Desktop').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(CupertinoTextField), 'Office');
    await tester.tap(find.text('Save nickname'));
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(store.desktops.entries.first.name, 'Office');
    await tester.tap(find.bySemanticsLabel('Rename Office'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reset nickname'));
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(store.desktops.entries.first.name, 'Desktop');
    await tester.tap(find.bySemanticsLabel('Forget Desktop').first);
    await tester.pumpAndSettle();
    expect(find.text('Forget Desktop?'), findsOneWidget);
    expect(find.textContaining('Revoke it separately'), findsOneWidget);
    await tester.tap(find.text('Forget desktop'));
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(store.desktops.entries, hasLength(1));
    expect(store.desktops.entries.single.configuration.hostId, 'B');
  });

  for (final light in [false, true]) {
    for (final large in [false, true]) {
      testWidgets('long duplicate names fit ${light ? 'light' : 'dark'} ${large ? 'large' : 'compact'}', (tester) async {
        const longName = 'Desktop with a very long shared name for isolation verification';
        await tester.runAsync(() async {
          final a = (await repository.saveAuthenticated(hostConfig('A'))).active!;
          final b = (await repository.saveAuthenticated(hostConfig('B'))).active!;
          await repository.rename(a.entryId, longName);
          await repository.rename(b.entryId, longName);
        });
        await tester.runAsync(store.reloadDesktops);
        if (light) theme.applyAppearance(lightAppearance);
        if (large) theme.applyDisplayMode('large');
        await tester.binding.setSurfaceSize(const Size(320, 700));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(app());
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.textContaining('127.0.0.1:43100 · A'), findsOneWidget);
        expect(find.text('Saved'), findsOneWidget);
        await tester.scrollUntilVisible(find.textContaining('127.0.0.1:43100 · B'), 250);
        expect(find.textContaining('127.0.0.1:43100 · B'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
