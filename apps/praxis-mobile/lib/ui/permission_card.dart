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
  String? _busyDecision;
  String? _failure;

  Future<void> _respond(AppStore store, String decision) async {
    setState(() {
      _busy = true;
      _busyDecision = decision;
      _failure = null;
    });
    try {
      await store.respondToPermission(widget.item.requestId!, decision);
    } catch (error) {
      if (mounted) setState(() => _failure = Diagnostics.messageOf(error));
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyDecision = null;
        });
      }
    }
  }

  Widget _cardButton({
    required BuildContext context,
    required String label,
    required String decision,
    required bool primary,
    bool danger = false,
    required bool enabled,
    required VoidCallback onTap,
  }) {
    final t = context.t;
    final p = t.palette;
    final isThisBusy = _busy && _busyDecision == decision;

    return Pressable(
      label: label,
      enabled: enabled && !_busy,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) {
        final bg = primary
            ? (pressed ? Color.lerp(p.accent, Colors.black, 0.15) : p.accent)
            : (danger && pressed
                ? p.dangerSoft
                : pressed
                    ? p.surfaceRaised
                    : p.surface);
        final textColor = primary
            ? p.onAccent
            : danger
                ? p.danger
                : p.text;
        final border = primary
            ? null
            : Border.all(color: p.border, width: 0.5);

        return Opacity(
          opacity: !enabled || (_busy && !isThisBusy) ? 0.45 : 1.0,
          child: Container(
            height: t.s(36),
            alignment: Alignment.center,
            padding: EdgeInsets.symmetric(horizontal: t.s(4)),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(t.s(8)),
              border: border,
            ),
            child: isThisBusy
                ? Spinner(color: textColor, small: true)
                : Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: ts(
                      context,
                      13,
                      weight: FontWeight.w600,
                      color: textColor,
                    ),
                  ),
          ),
        );
      },
    );
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
          children: [
            Expanded(
              child: _cardButton(
                context: context,
                label: 'Deny',
                decision: 'deny',
                primary: false,
                danger: true,
                enabled: canAnswer,
                onTap: () => _respond(store, 'deny'),
              ),
            ),
            SizedBox(width: t.s(8)),
            Expanded(
              child: _cardButton(
                context: context,
                label: 'Approve all',
                decision: 'allow_always',
                primary: false,
                enabled: canAnswer,
                onTap: () => _respond(store, 'allow_always'),
              ),
            ),
            SizedBox(width: t.s(8)),
            Expanded(
              child: _cardButton(
                context: context,
                label: 'Approve',
                decision: 'allow',
                primary: true,
                enabled: canAnswer,
                onTap: () => _respond(store, 'allow'),
              ),
            ),
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
