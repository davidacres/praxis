import 'package:flutter/material.dart';

import '../app/store.dart';
import '../app/theme.dart';
import '../core/markdown.dart';
import '../core/models.dart';
import '../core/transcript_follow.dart';
import '../core/usage.dart';
import 'gadget_view.dart';
import 'kit.dart';
import 'markdown_view.dart';

String? _tokensDetail(TokenUsage tokens) {
  int? total = tokens.totalTokens;
  if (total == null) {
    final sum = (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0);
    total = sum == 0 ? null : sum;
  }
  if (total == null && tokens.inputTokens == null && tokens.outputTokens == null) return null;
  final count = total ?? 0;
  if (tokens.inputTokens != null && tokens.outputTokens != null) {
    return '${formatTokenCount(count)} tok (${formatTokenCount(tokens.inputTokens!)} in · ${formatTokenCount(tokens.outputTokens!)} out)';
  }
  return '${formatTokenCount(count)} tokens';
}

/// One message. The agent's words are markdown; a user's are shown as typed.
/// Gadgets the message asked for follow its prose, answerable in place.
/// Port of `ChatMessage` in `app/Transcript.tsx`.
class ChatMessage extends StatelessWidget {
  const ChatMessage({super.key, required this.message, this.connected = false, this.onAnswer});
  final TranscriptMessage message;
  final bool connected;
  final GadgetAnswer? onAnswer;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    if (message.author == 'system') {
      return Padding(
        padding: EdgeInsets.only(bottom: t.s(12)),
        child: Center(
          child: FractionallySizedBox(
            widthFactor: 0.9,
            child: Center(
              child: Container(
                padding: EdgeInsets.symmetric(horizontal: t.s(10), vertical: t.s(4)),
                decoration: BoxDecoration(
                  color: p.surface,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: p.border, width: 0.5),
                ),
                child: Text(
                  '${message.text} · ${message.at}',
                  textAlign: TextAlign.center,
                  style: ts(context, 11, color: p.textDim),
                ),
              ),
            ),
          ),
        ),
      );
    }
    final user = message.author == 'user';
    final tokensText = !user && message.tokens != null ? _tokensDetail(message.tokens!) : null;
    final costText = !user && message.cost != null ? formatCost(message.cost!) : null;
    final hasMeta = !user && (message.model != null || tokensText != null || costText != null);

    Widget chip(String label, String value) => Container(
      padding: EdgeInsets.symmetric(horizontal: t.s(6), vertical: t.s(2.5)),
      decoration: BoxDecoration(
        color: p.surfaceRaised,
        borderRadius: BorderRadius.circular(t.s(4)),
        border: Border.all(color: p.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: ts(context, 9, weight: FontWeight.w700, letterSpacing: 0.5, color: p.textDim),
          ),
          SizedBox(width: t.s(5)),
          Flexible(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ts(context, 10.5, weight: FontWeight.w500, color: p.textSecondary, features: tabular),
            ),
          ),
        ],
      ),
    );

    final bubble = Container(
      padding: EdgeInsets.fromLTRB(t.s(12), t.s(9), t.s(12), t.s(11)),
      decoration: BoxDecoration(
        color: user ? p.userMessage : p.assistantMessage,
        borderRadius: BorderRadius.circular(t.s(7)),
        border: Border.all(color: user ? p.accentMuted : p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: EdgeInsets.only(bottom: t.s(7)),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  user ? 'YOU' : 'AI AGENT',
                  style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.8, color: p.textDim),
                ),
                SizedBox(width: t.s(18)),
                Text(
                  message.streaming ? 'STREAMING' : message.at,
                  style: ts(context, 10, color: p.textDim, features: tabular),
                ),
              ],
            ),
          ),
          if (user) SelectableText(message.text, style: ts(context, 13, lineHeight: 19)) else MarkdownView(message.text),
          if (hasMeta)
            Container(
              margin: EdgeInsets.only(top: t.s(9)),
              padding: EdgeInsets.only(top: t.s(7)),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: p.border, width: 0.5)),
              ),
              child: Wrap(
                spacing: t.s(6),
                runSpacing: t.s(6),
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (message.model != null) chip('MODEL', message.model!),
                  if (tokensText != null) chip('TOKENS', tokensText),
                  if (costText != null) chip('COST', costText),
                ],
              ),
            ),
        ],
      ),
    );

    final gadgets = message.gadgets;
    return Padding(
      padding: EdgeInsets.only(bottom: t.s(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (message.text.isNotEmpty)
            Semantics(
              label: '${user ? 'You' : 'Agent'}: ${user ? message.text : markdownPlainText(message.text)}',
            explicitChildNodes: true,
              child: user
                  ? LayoutBuilder(
                      builder: (context, box) => Align(
                        alignment: Alignment.centerRight,
                        child: ConstrainedBox(
                          constraints: BoxConstraints(maxWidth: box.maxWidth * 0.85),
                          child: IntrinsicWidth(child: bubble),
                        ),
                      ),
                    )
                  : bubble,
            ),
          for (final view in gadgets) ...[
            if (message.text.isNotEmpty || view != gadgets.first) SizedBox(height: t.s(8)),
            GadgetViewWidget(
              key: ValueKey(view.gadget.gadgetId),
              view: view,
              connected: connected,
              onAnswer: onAnswer ?? (_, _, _) async => throw StateError('Answer this on the desktop.'),
            ),
          ],
        ],
      ),
    );
  }
}

/// A conversation as a lazily-built, reversed list: the newest message sits at
/// the bottom, and it follows new output only while the reader is there.
/// Scrolled up, a chip counts what arrived, with a tap back to the latest.
class Transcript<T> extends StatefulWidget {
  const Transcript({super.key, required this.data, required this.keyOf, required this.itemBuilder, this.header, this.resetKey});

  /// Oldest first, as the conversation reads.
  final List<T> data;
  final String Function(T item) keyOf;
  final Widget Function(BuildContext context, T item) itemBuilder;

  /// Shown above the first message.
  final Widget? header;

  /// Changing it (another session or stage) returns to the latest message.
  final String? resetKey;

  @override
  State<Transcript<T>> createState() => _TranscriptState<T>();
}

class _TranscriptState<T> extends State<Transcript<T>> {
  final _controller = ScrollController();
  late FollowState _follow = FollowState.initial(widget.data.length);

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(Transcript<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.resetKey != widget.resetKey) {
      _follow = FollowState.initial(widget.data.length);
      if (_controller.hasClients) _controller.jumpTo(0);
    } else if (oldWidget.data.length != widget.data.length) {
      _follow = followOnMessages(_follow, widget.data.length);
    }
  }

  void _onScroll() {
    final next = followOnScroll(_follow, _controller.offset, widget.data.length);
    if (!identical(next, _follow)) setState(() => _follow = next);
  }

  void _jump() {
    _controller.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
    setState(() => _follow = FollowState.initial(widget.data.length));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final count = widget.data.length + (widget.header != null ? 1 : 0);
    return Stack(
      children: [
        Positioned.fill(
          child: ListView.builder(
            controller: _controller,
            reverse: true,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: EdgeInsets.fromLTRB(t.s(12), t.s(8), t.s(12), t.s(14)),
            itemCount: count,
            findChildIndexCallback: (key) {
              if (key is! ValueKey<String>) return null;
              final index = widget.data.indexWhere((item) => widget.keyOf(item) == key.value);
              return index < 0 ? null : widget.data.length - 1 - index;
            },
            itemBuilder: (context, index) {
              if (index >= widget.data.length) return widget.header!;
              final item = widget.data[widget.data.length - 1 - index];
              return KeyedSubtree(key: ValueKey<String>(widget.keyOf(item)), child: widget.itemBuilder(context, item));
            },
          ),
        ),
        if (!_follow.following)
          Positioned(
            left: 0,
            right: 0,
            bottom: t.s(10),
            child: Center(
              child: Pressable(
                label: jumpLabel(_follow.unseen),
                onTap: _jump,
                excludeChildSemantics: true,
                builder: (context, _) => Container(
                  padding: EdgeInsets.symmetric(horizontal: t.s(14), vertical: t.s(8)),
                  decoration: BoxDecoration(
                    color: p.surfaceRaised,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: p.borderStrong),
                  ),
                  child: Text('↓ ${jumpLabel(_follow.unseen)}', style: ts(context, 12.5, weight: FontWeight.w700)),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
