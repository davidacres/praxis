import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'app/confirm_identity.dart';
import 'app/connection.dart';
import 'app/diagnostics.dart';
import 'app/store.dart';
import 'app/theme.dart';
import 'screens/activity_screen.dart';
import 'screens/attention_screen.dart';
import 'screens/connect_screen.dart';
import 'screens/desktops_screen.dart';
import 'screens/work_screen.dart';
import 'ui/error_card.dart';
import 'ui/kit.dart';
import 'ui/permission_card.dart';
import 'ui/sidebar.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    Diagnostics.instance.record('Showing ${details.context?.toDescription() ?? 'a screen'}', details.exception);
  };
  ErrorWidget.builder = (details) => ErrorCard(details: details);
  final theme = ThemeController();
  loadDisplayMode().then((mode) {
    if (mode != null) theme.applyDisplayMode(mode);
  });
  runApp(PraxisApp(theme: theme));
}

class PraxisApp extends StatefulWidget {
  const PraxisApp({super.key, required this.theme});
  final ThemeController theme;

  @override
  State<PraxisApp> createState() => _PraxisAppState();
}

class _PraxisAppState extends State<PraxisApp> {
  late final AppStore _store = AppStore(theme: widget.theme);

  @override
  void dispose() {
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: widget.theme),
        ChangeNotifierProvider.value(value: _store),
        ChangeNotifierProvider.value(value: Diagnostics.instance),
      ],
      // Re-render from the root when the desktop's theme arrives or changes, so every screen repaints.
      child: Consumer<ThemeController>(
        builder: (context, theme, _) {
          final data = theme.data;
          final p = data.palette;
          return PraxisTheme(
            data: data,
            child: AnnotatedRegion<SystemUiOverlayStyle>(
              value: p.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark,
              child: MaterialApp(
                title: 'Praxis',
                debugShowCheckedModeBanner: false,
                navigatorKey: rootNavigatorKey,
                theme: ThemeData(
                  useMaterial3: true,
                  brightness: p.dark ? Brightness.dark : Brightness.light,
                  scaffoldBackgroundColor: p.bg,
                  canvasColor: p.bg,
                  splashFactory: NoSplash.splashFactory,
                  highlightColor: Colors.transparent,
                  textSelectionTheme: TextSelectionThemeData(cursorColor: p.accent, selectionColor: p.accentMuted, selectionHandleColor: p.accent),
                  colorScheme: ColorScheme.fromSeed(seedColor: p.accent, brightness: p.dark ? Brightness.dark : Brightness.light, surface: p.surface),
                ),
                // A neutral base, as React Native has: Material's type scale adds letter spacing and line height to every Text.
                builder: (context, child) => PraxisTheme(
                  data: data,
                  child: DefaultTextStyle(
                    style: TextStyle(fontSize: 14, color: p.text),
                    child: child!,
                  ),
                ),
                home: const _Root(),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();
  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  bool _sidebarOpen = false;

  void _open() => setState(() => _sidebarOpen = true);
  void _close() => setState(() => _sidebarOpen = false);

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final p = context.p;
    if (!store.showsWork && _sidebarOpen) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _close());
    }
    final Widget body;
    if (store.desktopsVisible) {
      body = const DesktopsScreen();
    } else if (!store.showsWork) {
      body = ConnectScreen(key: ValueKey(store.contextKey));
    } else {
      body = Column(
        children: [
          const StaleBanner(),
          const PermissionBanner(),
          Expanded(
            child: switch (store.primaryRoute) {
              'attention' => AttentionScreen(key: ValueKey(store.contextKey), onOpenSidebar: _open),
              'activity' => ActivityScreen(key: ValueKey(store.contextKey), onOpenSidebar: _open),
              _ => WorkScreen(key: ValueKey(store.contextKey), onOpenSidebar: _open),
            },
          ),
        ],
      );
    }
    return Scaffold(
      backgroundColor: p.bg,
      body: Stack(
        children: [
          Positioned.fill(child: SafeArea(child: body)),
          if (store.showsWork && !store.desktopsVisible)
            Positioned.fill(
              child: AppSidebar(visible: _sidebarOpen, onClose: _close),
            ),
        ],
      ),
    );
  }
}
