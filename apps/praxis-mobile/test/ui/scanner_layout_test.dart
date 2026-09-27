import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:praxis_mobile/app/theme.dart';
import 'package:praxis_mobile/screens/connect_screen.dart';

void main() {
  // The page once shrank to its 250pt guide box and sat in the top-left corner,
  // with the camera preview squeezed inside it.
  testWidgets('the scanner fills the page with the guide box centred', (tester) async {
    await tester.binding.setSurfaceSize(const Size(430, 932));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(home: PraxisTheme(data: ThemeController().data, child: const PairingScanner())));
    await tester.pump();

    expect(tester.getSize(find.byType(MobileScanner)), const Size(430, 932));
    expect(tester.getCenter(find.byKey(const ValueKey('scan-guide'))), const Offset(215, 466));
    expect(tester.getSize(find.byKey(const ValueKey('scan-guide'))), const Size(250, 250));
  });
}
