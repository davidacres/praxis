import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/ui/error_card.dart';

class _Broken extends StatelessWidget {
  const _Broken();
  @override
  Widget build(BuildContext context) => throw StateError('an unexpected field from the desktop');
}

void main() {
  testWidgets('a widget that fails to build shows the error card, not a red screen', (tester) async {
    final previous = ErrorWidget.builder;
    ErrorWidget.builder = (details) => ErrorCard(details: details);
    await tester.pumpWidget(MaterialApp(home: PraxisTheme(data: ThemeController().data, child: const Scaffold(body: _Broken()))));
    expect(tester.takeException(), isA<StateError>());
    expect(find.text('Something went wrong showing this screen'), findsOneWidget);
    expect(find.textContaining('an unexpected field from the desktop'), findsOneWidget);
    expect(find.text('Share details'), findsOneWidget);
    ErrorWidget.builder = previous;
  });
}
