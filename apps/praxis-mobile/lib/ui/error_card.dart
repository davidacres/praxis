import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../app/theme.dart';
import 'kit.dart';

/// Shown in place of a widget that failed to build, so one bad payload — a
/// desktop newer than the phone, a field the phone did not expect — costs that
/// widget, not the app. The sidebar stays reachable. Port of `app/ErrorBoundary.tsx`.
class ErrorCard extends StatelessWidget {
  const ErrorCard({super.key, required this.details});
  final FlutterErrorDetails details;

  @override
  Widget build(BuildContext context) {
    final theme = PraxisTheme.maybeOf(context);
    if (theme == null) return const SizedBox.shrink();
    final t = theme;
    final p = t.palette;
    final message = details.exceptionAsString();
    return SingleChildScrollView(
      padding: EdgeInsets.all(t.space),
      child: Semantics(
        liveRegion: true,
        child: Container(
          padding: EdgeInsets.all(t.space),
          decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: p.danger)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
            Text('Something went wrong showing this screen', style: ts(context, 16, weight: FontWeight.w700)),
            SizedBox(height: t.s(10)),
            Text(
              'The rest of Praxis still works — open the menu to go elsewhere. If this keeps happening, the desktop may be newer than this app.',
              style: ts(context, 13.5, lineHeight: 20, color: p.textSecondary),
            ),
            SizedBox(height: t.s(10)),
            SelectableText(message, style: ts(context, 12.5, color: p.danger)),
            SizedBox(height: t.s(10)),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              PraxisButton(
                label: 'Share details',
                ghost: true,
                expand: false,
                onPressed: () => Share.share('Praxis mobile — error showing a screen\n\n$message\n${details.stack ?? ''}'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}
