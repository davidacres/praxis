import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import 'kit.dart';

/// An agent asking to use a tool, answered here or on the desktop. Shown in the
/// chat that is waiting on it and on the Attention screen.
class PermissionCard extends StatefulWidget {
  const PermissionCard({super.key, required this.item, this.subject});
  final AttentionItem item;

  /// What the request is about, when the card is shown away from its chat.
  final String? subject;

  @override
  State<PermissionCard> createState() => _PermissionCardState();
}

class _PermissionCardState extends State<PermissionCard> {
  bool _busy = false;
  String? _failure;

  Future<void> _respond(AppStore store, String decision) async {
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      await store.respondToPermission(widget.item.requestId!, decision);
    } catch (error) {
      if (mounted) setState(() => _failure = Diagnostics.messageOf(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final item = widget.item;
    final canAnswer = !_busy && item.requestId != null && store.connection == ShellConnection.ready;
    return PraxisCard(
      borderColor: t.palette.warn,
      children: [
        Text(
          'Permission Request',
          style: ts(context, 14, weight: FontWeight.w700, color: t.palette.warn),
        ),
        Container(height: 1, color: t.palette.border),
        if (widget.subject != null && widget.subject!.isNotEmpty) Body(widget.subject!, dim: true),
        Body(item.summary ?? 'The agent is asking permission to act.'),
        if (item.detail != null && item.detail!.isNotEmpty) Body(item.detail!, dim: true),
        if (_failure != null) Text(_failure!, style: ts(context, 12.5, lineHeight: 18, color: t.palette.danger)),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            PraxisButton(label: 'Deny', ghost: true, expand: false, disabled: !canAnswer, onPressed: () => _respond(store, 'deny')),
            SizedBox(width: t.s(8)),
            PraxisButton(label: 'Allow once', expand: false, disabled: !canAnswer, onPressed: () => _respond(store, 'allow')),
          ],
        ),
      ],
    );
  }
}

/// A request waiting on the person that they cannot see from where they are:
/// shown above every screen except the chat that already shows the request.
class PermissionBanner extends StatelessWidget {
  const PermissionBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final openChat = store.primaryRoute == 'work' && store.openRunId == null && store.detail == 'chat'
        ? store.work.where((entry) => entry.workId == store.openWorkId).firstOrNull?.sessionId
        : null;
    final waiting = store.openAttention.where((item) => item.kind == 'permission' && item.sessionId != openChat).toList();
    // The Attention screen lists every request already.
    if (waiting.isEmpty || store.primaryRoute == 'attention') return const SizedBox.shrink();
    waiting.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final first = waiting.first;
    final sessions = waiting.map((item) => item.sessionId).toSet();
    final chat = sessions.length == 1 ? store.work.where((entry) => entry.sessionId == first.sessionId && !entry.draft).firstOrNull : null;
    final more = waiting.length > 1 ? ' (+${waiting.length - 1} more)' : '';
    final text = sessions.length == 1
        ? '${chat?.title ?? 'An agent'} is asking: ${first.summary ?? 'permission to act'}$more. Tap to review.'
        : '${sessions.length} chats are asking for permission. Tap to review.';
    final t = context.t;
    return Pressable(
      label: text,
      excludeChildSemantics: true,
      onTap: () {
        if (chat != null) {
          store.openWork(chat.workId);
          store.setRoute('work');
        } else {
          store.setRoute('attention');
        }
      },
      builder: (context, _) => Container(
        key: const ValueKey('permission-banner'),
        width: double.infinity,
        padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(8)),
        decoration: BoxDecoration(
          color: t.palette.warnSoft,
          border: Border(bottom: BorderSide(color: t.palette.warn)),
        ),
        child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: ts(context, 12.5, lineHeight: 18, weight: FontWeight.w600)),
      ),
    );
  }
}
