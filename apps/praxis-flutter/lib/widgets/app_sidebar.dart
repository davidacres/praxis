import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';

class AppSidebar extends StatelessWidget {
  final bool visible;
  final VoidCallback onClose;

  const AppSidebar({
    Key? key,
    required this.visible,
    required this.onClose,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    if (!visible) return const SizedBox.shrink();

    return Consumer<AppStore>(
      builder: (context, store, _) {
        return GestureDetector(
          onTap: onClose,
          child: Stack(
            children: [
              Container(color: Colors.black26),
              Positioned(
                right: 0,
                top: 0,
                bottom: 0,
                width: 300,
                child: GestureDetector(
                  onTap: () {},
                  child: Container(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    child: Column(
                      children: [
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    store.host?.hostName ?? 'Praxis',
                                    style: Theme.of(context).textTheme.titleMedium,
                                  ),
                                  if (store.project != null)
                                    Text(
                                      store.project!.name,
                                      style: Theme.of(context).textTheme.bodySmall,
                                    ),
                                ],
                              ),
                              IconButton(
                                icon: const Icon(Icons.close),
                                onPressed: onClose,
                              ),
                            ],
                          ),
                        ),
                        const Divider(height: 1),
                        Expanded(
                          child: ListView(
                            padding: EdgeInsets.zero,
                            children: [
                              ListTile(
                                leading: const Icon(Icons.work),
                                title: const Text('Work'),
                                onTap: () {
                                  store.setRoute('work');
                                  onClose();
                                },
                              ),
                              ListTile(
                                leading: const Icon(Icons.lightbulb),
                                title: const Text('Attention'),
                                onTap: () {
                                  store.setRoute('attention');
                                  onClose();
                                },
                              ),
                              ListTile(
                                leading: const Icon(Icons.history),
                                title: const Text('Activity'),
                                onTap: () {
                                  store.setRoute('activity');
                                  onClose();
                                },
                              ),
                            ],
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              ElevatedButton(
                                onPressed: () {
                                  store.disconnect(forget: false);
                                  onClose();
                                },
                                child: const Text('Disconnect'),
                              ),
                              const SizedBox(height: 8),
                              OutlinedButton(
                                onPressed: () {
                                  store.disconnect(forget: true);
                                  onClose();
                                },
                                child: const Text('Forget Device'),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
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
