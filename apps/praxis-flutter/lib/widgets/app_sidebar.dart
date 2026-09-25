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
          child: Container(
            color: Colors.black26,
            child: GestureDetector(
              onTap: () {}, // Prevent dismissal on sidebar tap
              child: Positioned(
                right: 0,
                top: 0,
                bottom: 0,
                child: Container(
                  width: 300,
                  color: Theme.of(context).scaffoldBackgroundColor,
                  child: Column(
                    children: [
                      // Header
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
                      // Navigation
                      Expanded(
                        child: ListView(
                          padding: EdgeInsets.zero,
                          children: [
                            _NavItem(
                              icon: Icons.work,
                              label: 'Work',
                              isActive: store.primaryRoute == 'work',
                              onTap: () {
                                store.setRoute('work');
                                onClose();
                              },
                            ),
                            _NavItem(
                              icon: Icons.lightbulb,
                              label: 'Attention',
                              isActive: store.primaryRoute == 'attention',
                              onTap: () {
                                store.setRoute('attention');
                                onClose();
                              },
                            ),
                            _NavItem(
                              icon: Icons.history,
                              label: 'Activity',
                              isActive: store.primaryRoute == 'activity',
                              onTap: () {
                                store.setRoute('activity');
                                onClose();
                              },
                            ),
                            const Divider(),
                            if (store.workflows.isNotEmpty) ...[
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 8,
                                ),
                                child: Text(
                                  'Workflows',
                                  style: Theme.of(context).textTheme.labelSmall,
                                ),
                              ),
                              ...store.workflows.map((workflow) => ListTile(
                                    title: Text(workflow.name),
                                    subtitle: Text(
                                      workflow.trigger,
                                      style:
                                          Theme.of(context).textTheme.bodySmall,
                                    ),
                                    onTap: () {
                                      // TODO: Start workflow
                                      onClose();
                                    },
                                  )),
                              const Divider(),
                            ],
                          ],
                        ),
                      ),
                      // Footer
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (store.connectionError != null)
                              Container(
                                padding: const EdgeInsets.all(8),
                                margin: const EdgeInsets.only(bottom: 12),
                                decoration: BoxDecoration(
                                  color: Colors.red.withAlpha(20),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(
                                  store.connectionError!,
                                  style: Theme.of(context)
                                      .textTheme
                                      .bodySmall
                                      ?.copyWith(
                                        color: Colors.red,
                                      ),
                                ),
                              ),
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
          ),
        );
      },
    );
  }
}

class _NavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool isActive;
  final VoidCallback onTap;

  const _NavItem({
    Key? key,
    required this.icon,
    required this.label,
    required this.isActive,
    required this.onTap,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(label),
      selected: isActive,
      selectedTileColor: Theme.of(context).colorScheme.primary.withAlpha(30),
      onTap: onTap,
    );
  }
}
