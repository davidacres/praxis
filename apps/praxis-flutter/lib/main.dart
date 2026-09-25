import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'app/store/store_provider.dart';
import 'app/theme.dart';
import 'screens/connect_screen.dart';
import 'screens/work_screen.dart';
import 'screens/attention_screen.dart';
import 'screens/activity_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PraxisApp());
}

class PraxisApp extends StatelessWidget {
  const PraxisApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AppStore(),
      child: Consumer<AppStore>(
        builder: (context, store, _) {
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
    return Consumer<AppStore>(
      builder: (context, store, _) {
        // Show connect screen if not connected
        if (!store.isConnected) {
          return const ConnectScreen();
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
              if (_sidebarOpen)
                GestureDetector(
                  onTap: () => setState(() => _sidebarOpen = false),
                  child: Container(
                    color: Colors.black26,
                  ),
                ),
              if (_sidebarOpen)
                Positioned(
                  right: 0,
                  top: 0,
                  bottom: 0,
                  child: Container(
                    width: 300,
                    color: Theme.of(context).scaffoldBackgroundColor,
                    child: Column(
                      children: [
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text(
                                'Menu',
                                style: TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              IconButton(
                                icon: const Icon(Icons.close),
                                onPressed: () =>
                                    setState(() => _sidebarOpen = false),
                              ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: ListView(
                            children: [
                              ListTile(
                                title: const Text('Work'),
                                onTap: () {
                                  store.setRoute('work');
                                  setState(() => _sidebarOpen = false);
                                },
                              ),
                              ListTile(
                                title: const Text('Attention'),
                                onTap: () {
                                  store.setRoute('attention');
                                  setState(() => _sidebarOpen = false);
                                },
                              ),
                              ListTile(
                                title: const Text('Activity'),
                                onTap: () {
                                  store.setRoute('activity');
                                  setState(() => _sidebarOpen = false);
                                },
                              ),
                            ],
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: ElevatedButton(
                            onPressed: () => store.disconnect(),
                            child: const Text('Disconnect'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
