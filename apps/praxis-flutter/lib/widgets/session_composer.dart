import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';
import '../app/store/types.dart';

class SessionComposer extends StatefulWidget {
  final String workId;

  const SessionComposer({
    Key? key,
    required this.workId,
  }) : super(key: key);

  @override
  State<SessionComposer> createState() => _SessionComposerState();
}

class _SessionComposerState extends State<SessionComposer> {
  late TextEditingController _messageController;
  bool _isSending = false;

  @override
  void initState() {
    super.initState();
    _messageController = TextEditingController();
  }

  @override
  void dispose() {
    _messageController.dispose();
    super.dispose();
  }

  Future<void> _handleSend(AppStore store) async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    _messageController.clear();

    setState(() {
      _isSending = true;
    });

    try {
      // Add message to transcript
      final message = TranscriptMessage(
        id: DateTime.now().millisecondsSinceEpoch.toString(),
        role: 'user',
        text: text,
        timestamp: DateTime.now().toString(),
      );
      store.addTranscriptMessage(message);

      // TODO: Send to desktop via connection
    } finally {
      setState(() {
        _isSending = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<AppStore>(
      builder: (context, store, _) {
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(
                color: Theme.of(context).dividerColor,
              ),
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _messageController,
                  enabled: !_isSending,
                  maxLines: null,
                  decoration: InputDecoration(
                    hintText: 'Type a message...',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                    ),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                  ),
                  onSubmitted: (_) => _handleSend(store),
                ),
              ),
              const SizedBox(width: 8),
              if (_isSending)
                const SizedBox(
                  height: 40,
                  width: 40,
                  child: Padding(
                    padding: EdgeInsets.all(8),
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else
                IconButton(
                  icon: const Icon(Icons.send),
                  onPressed: () => _handleSend(store),
                ),
            ],
          ),
        );
      },
    );
  }
}
