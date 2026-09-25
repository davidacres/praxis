import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';

class AttentionScreen extends StatelessWidget {
  final VoidCallback onOpenSidebar;

  const AttentionScreen({
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
                'Attention',
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
              if (store.work.isEmpty) {
                return Center(
                  child: Text(
                    'No items requiring attention',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                );
              }

              return ListView.builder(
                itemCount: store.work.length,
                itemBuilder: (context, index) {
                  final item = store.work[index];
                  return ListTile(
                    title: Text(item.title),
                    subtitle: Text(item.status),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => store.openWork(item.workId),
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
