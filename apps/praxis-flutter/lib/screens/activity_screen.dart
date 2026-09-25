import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';

class ActivityScreen extends StatelessWidget {
  final VoidCallback onOpenSidebar;

  const ActivityScreen({
    Key? key,
    required this.onOpenSidebar,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: Theme.of(context).dividerColor,
              ),
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Activity',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              IconButton(
                icon: const Icon(Icons.menu),
                onPressed: onOpenSidebar,
              ),
            ],
          ),
        ),
        Expanded(
          child: Consumer<AppStore>(
            builder: (context, store, _) {
              if (store.activity.isEmpty) {
                return Center(
                  child: Text(
                    'No recent activity',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                );
              }

              return ListView.builder(
                itemCount: store.activity.length,
                itemBuilder: (context, index) {
                  final entry = store.activity[index];
                  return ListTile(
                    title: Text(entry.title),
                    subtitle: Text(entry.text),
                    trailing: Text(
                      entry.at,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    onTap: () => store.openWork(entry.workId),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }
}
