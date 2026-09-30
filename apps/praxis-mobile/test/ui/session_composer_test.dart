import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/core/usage.dart';
import 'package:praxis_mobile/screens/session_composer.dart';

void main() {
  const dummyUsage = UsageView(
    state: UsageState.empty,
    subject: 'session',
    cost: '',
    costReported: false,
    details: [],
    summary: 'No usage reported',
  );

  Widget buildComposer({
    required TextEditingController controller,
    VoidCallback? onSend,
    VoidCallback? onStop,
    bool sending = false,
    bool draft = false,
  }) {
    final theme = ThemeController();
    return MaterialApp(
      home: PraxisTheme(
        data: theme.data,
        child: Scaffold(
          body: SessionComposer(
            controller: controller,
            onSend: onSend ?? () {},
            onStop: onStop,
            sending: sending,
            editable: true,
            draft: draft,
            providerLabel: 'Anthropic',
            modelLabel: 'Claude 3.7 Sonnet',
            mode: 'chat',
            modeOptions: const [ComposerModeOption(mode: 'chat', available: true)],
            usage: dummyUsage,
          ),
        ),
      ),
    );
  }

  testWidgets('session composer has compact input height when idle', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(buildComposer(controller: controller));
    await tester.pump();

    // Input text field should be present and visible
    final inputFinder = find.byType(CupertinoTextField);
    expect(inputFinder, findsOneWidget);

    final inputSize = tester.getSize(inputFinder);
    // Previously minHeight was 58 + padding = 77.
    // Now natural 1-line height with padding is ~30-36.
    expect(inputSize.height, lessThan(42));

    // Shows standard idle controls
    expect(find.text('Anthropic'), findsOneWidget);
    expect(find.text('Claude 3.7 Sonnet'), findsOneWidget);
    expect(find.text('☷'), findsOneWidget);
    expect(find.text('↑'), findsOneWidget);
    expect(find.text('Ask'), findsNothing);
  });

  testWidgets('session composer collapses when sending/running, showing activity and Ask button', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    var stopped = false;
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(buildComposer(
      controller: controller,
      sending: true,
      onStop: () => stopped = true,
    ));
    await tester.pump(const Duration(milliseconds: 250));

    // When collapsed, CupertinoTextField is hidden/collapsed
    expect(find.byType(CupertinoTextField), findsNothing);

    // Shows Working activity dot and text
    expect(find.text('Working…'), findsOneWidget);

    // Shows Ask button and Stop/cancel button
    expect(find.text('Ask'), findsOneWidget);
    expect(find.bySemanticsLabel('Stop response'), findsOneWidget);

    // Standard options (☷) and send (↑) buttons are not present
    expect(find.text('☷'), findsNothing);
    expect(find.text('↑'), findsNothing);

    // Tapping stop button calls onStop
    await tester.tap(find.bySemanticsLabel('Stop response'));
    expect(stopped, isTrue);
  });

  testWidgets('tapping Ask expands composer, allowing follow-up to be queued', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    var sent = false;
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(buildComposer(
      controller: controller,
      sending: true,
      onSend: () => sent = true,
      onStop: () {},
    ));
    await tester.pump(const Duration(milliseconds: 250));

    // Tap Ask button
    await tester.tap(find.text('Ask'));
    await tester.pump(const Duration(milliseconds: 250));

    // Now input is visible with queue follow-up placeholder
    expect(find.byType(CupertinoTextField), findsOneWidget);
    expect(find.text('Queue follow-up (sends automatically when done)…'), findsOneWidget);

    // Shows Hide button, Stop button (×), and Queue send button (↑)
    expect(find.text('Hide'), findsOneWidget);
    expect(find.bySemanticsLabel('Stop response'), findsOneWidget);
    expect(find.text('↑'), findsOneWidget);

    // Type follow up message and send
    controller.text = 'Please also check unit tests';
    await tester.pump();

    await tester.tap(find.text('↑'));
    await tester.pump(const Duration(milliseconds: 250));

    expect(sent, isTrue);
    // After sending, composer collapses back to minimized state
    expect(find.byType(CupertinoTextField), findsNothing);
    expect(find.text('Ask'), findsOneWidget);
  });

  testWidgets('tapping Hide collapses the expanded in-flight composer', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(buildComposer(
      controller: controller,
      sending: true,
      onStop: () {},
    ));
    await tester.pump(const Duration(milliseconds: 250));

    // Tap Ask
    await tester.tap(find.text('Ask'));
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byType(CupertinoTextField), findsOneWidget);

    // Tap Hide
    await tester.tap(find.text('Hide'));
    await tester.pump(const Duration(milliseconds: 250));

    // Should be collapsed again
    expect(find.byType(CupertinoTextField), findsNothing);
    expect(find.text('Ask'), findsOneWidget);
  });
}
