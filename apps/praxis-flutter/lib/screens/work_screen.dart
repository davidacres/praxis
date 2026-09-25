import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';
import '../app/store/types.dart';
import '../app/services/mobile_client.dart';
import '../widgets/transcript_view.dart';
import '../widgets/session_composer.dart';

class WorkScreen extends StatefulWidget {
  final VoidCallback onOpenSidebar;

  const WorkScreen({
    Key? key,
    required this.onOpenSidebar,
  }) : super(key: key);

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  @override
  Widget build(BuildContext context) {
    return Consumer2<AppStore, MobileClient>(
      builder: (context, store, client, _) {
        final openWorkId = store.openWorkId;
        final work = openWorkId != null
            ? store.work.firstWhere(
                (item) => item.workId == openWorkId,
                orElse: () => null,
              )
            : null;

        if (work == null) {
          return _EmptyWorkView(onOpenSidebar: widget.onOpenSidebar);
        }

        return Column(
          children: [
            // Header
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
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          work.title,
                          style: Theme.of(context).textTheme.titleLarge,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          work.status,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.menu),
                    onPressed: widget.onOpenSidebar,
                  ),
                ],
              ),
            ),
            // Transcript
            Expanded(
              child: TranscriptView(
                messages: store.currentTranscript,
              ),
            ),
            // Composer
            SessionComposer(
              workId: work.workId,
              onSendMessage: client.sendMessage,
            ),
          ],
        );
      },
    );
  }
}

class _EmptyWorkView extends StatelessWidget {
  final VoidCallback onOpenSidebar;

  const _EmptyWorkView({
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
                'Conversations',
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
                    'No conversations yet',
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
