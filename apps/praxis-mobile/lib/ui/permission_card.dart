import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/attention.dart';
import '../core/models.dart';
import 'app_icon.dart';
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

/// A notification banner shown when attention is required:
/// approvals, failed stages, and agent permissions.
/// Includes a clickable link that takes the user directly to the session or run.
class AttentionBanner extends StatelessWidget {
  const AttentionBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final openChat = store.primaryRoute == 'work' && store.openRunId == null
        ? store.work.where((entry) => entry.workId == store.openWorkId).firstOrNull?.sessionId
        : null;
    final openRun = store.primaryRoute == 'work' ? store.openRunId : null;

    final waiting = store.openAttention.where((item) {
      if (item.kind == 'permission' && item.sessionId != null && item.sessionId == openChat) {
        return false;
      }
      if ((item.kind == 'approval' || item.kind == 'failure') && item.runId != null && item.runId == openRun) {
        return false;
      }
      return true;
    }).toList();

    if (waiting.isEmpty) return const SizedBox.shrink();

    waiting.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final first = waiting.first;
    final isDanger = first.kind == 'failure';
    final more = waiting.length > 1 ? ' (+${waiting.length - 1} more)' : '';

    final String message;
    final String actionText;
    final VoidCallback onTap;

    if (first.kind == 'permission') {
      final chat = first.sessionId != null
          ? store.work.where((entry) => entry.sessionId == first.sessionId && !entry.draft).firstOrNull
          : null;
      message = '${chat?.title ?? 'An agent'} is asking: ${first.summary ?? 'permission to act'}$more';
      actionText = 'Review';
      onTap = () {
        if (chat != null) {
          store.openWork(chat.workId);
          store.setRoute('work');
        } else if (first.runId != null) {
          store.openRun(first.runId);
        }
      };
    } else if (first.kind == 'approval') {
      final run = first.runId != null
          ? store.workflowRuns.where((r) => r.runId == first.runId).firstOrNull
          : null;
      message = 'Approval required: ${first.summary ?? run?.workflowName ?? 'Workflow run'}$more';
      actionText = 'Review';
      onTap = () {
        if (first.runId != null) {
          store.openRun(first.runId);
        }
      };
    } else if (first.kind == 'failure') {
      final run = first.runId != null
          ? store.workflowRuns.where((r) => r.runId == first.runId).firstOrNull
          : null;
      message = 'Step failed: ${first.summary ?? run?.workflowName ?? 'Workflow run'}$more';
      actionText = 'View run';
      onTap = () {
        if (first.runId != null) {
          store.openRun(first.runId);
        }
      };
    } else {
      message = '${first.summary ?? attentionTypeTitle(first.kind)}$more';
      actionText = 'View';
      onTap = () {
        if (first.sessionId != null) {
          final chat = store.work.where((entry) => entry.sessionId == first.sessionId && !entry.draft).firstOrNull;
          if (chat != null) {
            store.openWork(chat.workId);
            store.setRoute('work');
            return;
          }
        }
        if (first.runId != null) {
          store.openRun(first.runId);
        }
      };
    }

    final t = context.t;
    final p = t.palette;
    final toneBg = isDanger ? p.dangerSoft : p.warnSoft;
    final toneBorder = isDanger ? p.danger : p.warn;
    final toneText = isDanger ? p.danger : p.text;
    final linkColor = isDanger ? p.danger : p.accent;

    return Pressable(
      label: '$message. $actionText.',
      excludeChildSemantics: true,
      onTap: onTap,
      builder: (context, pressed) => Container(
        key: const ValueKey('attention-banner'),
        width: double.infinity,
        padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(8)),
        decoration: BoxDecoration(
          color: pressed ? toneBg.withValues(alpha: 0.8) : toneBg,
          border: Border(bottom: BorderSide(color: toneBorder)),
        ),
        child: Row(
          children: [
            AppIcon('warning', size: 14, color: isDanger ? p.danger : p.warn),
            SizedBox(width: t.s(8)),
            Expanded(
              child: Text(
                message,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ts(context, 12.5, lineHeight: 18, weight: FontWeight.w600, color: toneText),
              ),
            ),
            SizedBox(width: t.s(8)),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  actionText,
                  style: ts(context, 12, weight: FontWeight.w700, color: linkColor, decoration: TextDecoration.underline),
                ),
                SizedBox(width: t.s(2)),
                Text(
                  '›',
                  style: ts(context, 13, weight: FontWeight.w700, color: linkColor),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Backwards compatibility alias for PermissionBanner.
class PermissionBanner extends StatelessWidget {
  const PermissionBanner({super.key});

  @override
  Widget build(BuildContext context) => const AttentionBanner();
}
