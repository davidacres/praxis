import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:praxis_mobile/main.dart';
import 'package:praxis_mobile/app/store/store_provider.dart';
import 'package:praxis_mobile/app/store/types.dart';

void main() {
  group('Praxis Mobile App', () {
    testWidgets('Connect screen shows when not connected',
        (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      expect(find.text('Connect to Praxis Desktop'), findsOneWidget);
      expect(find.byType(TextField), findsWidgets);
    });

    testWidgets('Navigation works between screens', (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      // Simulate being connected
      final store = Provider.of<AppStore>(
        tester.element(find.byType(MaterialApp)),
        listen: false,
      );

      await store.connect(MobileHostConfiguration(
        hostId: 'test-host',
        address: 'localhost',
        port: 9876,
        hostPublicKeyHex: '0' * 64,
      ));

      await tester.pumpWidget(const PraxisApp());

      // Menu button should be visible
      expect(find.byIcon(Icons.menu), findsWidgets);
    });

    testWidgets('Work items display correctly', (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      final store = Provider.of<AppStore>(
        tester.element(find.byType(MaterialApp)),
        listen: false,
      );

      // Add test work items
      store.updateWork([
        MobileWorkItem(
          workId: 'w1',
          title: 'Test Work Item',
          status: 'pending',
          sessionId: 's1',
          mode: 'interactive',
        ),
      ]);

      await tester.pumpWidget(const PraxisApp());

      expect(find.text('Test Work Item'), findsWidgets);
    });

    testWidgets('Transcript messages render correctly',
        (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      final store = Provider.of<AppStore>(
        tester.element(find.byType(MaterialApp)),
        listen: false,
      );

      // Add test messages
      store.updateTranscript([
        TranscriptMessage(
          id: '1',
          role: 'user',
          text: 'Hello',
          timestamp: DateTime.now().toString(),
        ),
        TranscriptMessage(
          id: '2',
          role: 'assistant',
          text: 'Hi there!',
          timestamp: DateTime.now().toString(),
        ),
      ]);

      await tester.pumpWidget(const PraxisApp());

      expect(find.text('Hello'), findsWidgets);
      expect(find.text('Hi there!'), findsWidgets);
    });

    testWidgets('Theme updates reflect in UI', (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      final store = Provider.of<AppStore>(
        tester.element(find.byType(MaterialApp)),
        listen: false,
      );

      final initialThemeVersion = store.themeVersion;

      // Update appearance
      store.updateAppearance(MobileAppearance(
        name: 'test',
        mode: 'dark',
        primaryColor: '#FF0000',
        backgroundColor: '#000000',
        surfaceColor: '#111111',
        textColor: '#FFFFFF',
        secondaryTextColor: '#CCCCCC',
      ));

      expect(store.themeVersion, greaterThan(initialThemeVersion));
    });

    testWidgets('Sidebar opens and closes', (WidgetTester tester) async {
      await tester.pumpWidget(const PraxisApp());

      final store = Provider.of<AppStore>(
        tester.element(find.byType(MaterialApp)),
        listen: false,
      );

      await store.connect(MobileHostConfiguration(
        hostId: 'test-host',
        address: 'localhost',
        port: 9876,
        hostPublicKeyHex: '0' * 64,
      ));

      await tester.pumpWidget(const PraxisApp());

      // Open sidebar
      await tester.tap(find.byIcon(Icons.menu).first);
      await tester.pumpAndSettle();

      expect(find.byType(Drawer), findsWidgets);
    });
  });
}
