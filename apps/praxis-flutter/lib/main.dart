import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'app/store/store_provider.dart';
import 'app/theme.dart';
import 'app/services/connection_service.dart';
import 'app/services/mobile_client.dart';
import 'screens/connect_screen.dart';
import 'screens/work_screen.dart';
import 'screens/attention_screen.dart';
import 'screens/activity_screen.dart';
import 'screens/run_screen.dart';
import 'widgets/app_sidebar.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PraxisApp());
}

class PraxisApp extends StatelessWidget {
  const PraxisApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final store = AppStore();
    final client = MobileClient(
      connection: ConnectionService(),
      store: store,
    );

    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: store),
        Provider.value(value: client),
      ],
      child: Consumer<AppStore>(
        builder: (context, _, __) {
          return MaterialApp(
            title: 'Praxis',
            theme: buildTheme(store.appearance),
            home: const PraxisShell(),
          );
        },
      ),
    );
  }
}

class PraxisShell extends StatefulWidget {
  const PraxisShell({Key? key}) : super(key: key);

  @override
  State<PraxisShell> createState() => _PraxisShellState();
}

class _PraxisShellState extends State<PraxisShell> {
  bool _sidebarOpen = false;

  @override
  Widget build(BuildContext context) {
    return Consumer2<AppStore, MobileClient>(
      builder: (context, store, client, _) {
        // Show connect screen if not connected
        if (!store.isConnected) {
          return ConnectScreen(
            onConnect: (config) {
              client.connect(config).then((_) {
                store.notifyListeners();
              }).catchError((error) {
                store.setConnectionError('Connection failed: $error');
              });
            },
          );
        }

        // Show run screen if a run is open
        final openRunId = store.openRunId;
        if (openRunId != null) {
          return RunScreen(
            runId: openRunId,
            onOpenSidebar: () => setState(() => _sidebarOpen = true),
          );
        }

        // Build the main shell
        final route = store.primaryRoute;
        Widget body;

        switch (route) {
          case 'work':
            body = WorkScreen(
              onOpenSidebar: () => setState(() => _sidebarOpen = true),
            );
            break;
          case 'attention':
            body = AttentionScreen(
              onOpenSidebar: () => setState(() => _sidebarOpen = true),
            );
            break;
          case 'activity':
            body = ActivityScreen(
              onOpenSidebar: () => setState(() => _sidebarOpen = true),
            );
            break;
          default:
            body = const Center(child: Text('Unknown route'));
        }

        return Scaffold(
          body: Stack(
            children: [
              body,
              AppSidebar(
                visible: _sidebarOpen,
                onClose: () => setState(() => _sidebarOpen = false),
              ),
            ],
          ),
        );
      },
    );
  }
}
