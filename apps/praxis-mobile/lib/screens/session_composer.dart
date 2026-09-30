import 'package:flutter/cupertino.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../app/theme.dart';
import '../core/models.dart';
import '../core/session_options.dart';
import '../core/usage.dart';
import '../ui/kit.dart';

class ComposerModeOption {
  const ComposerModeOption({required this.mode, required this.available, this.toolAccess, this.unavailableMessage});
  final String mode;
  final bool available;
  final String? toolAccess;
  final String? unavailableMessage;
}

/// The composer at the foot of a chat. Port of `screens/SessionComposer.tsx`.
class SessionComposer extends StatefulWidget {
  const SessionComposer({
    super.key,
    required this.controller,
    required this.onSend,
    this.onStop,
    this.sending = false,
    this.blockedReason,
    this.error,
    required this.editable,
    required this.draft,
    this.lockedReason,
    required this.providerLabel,
    required this.modelLabel,
    required this.mode,
    this.onOpenProviderPicker,
    this.onOpenModelPicker,
    required this.modeOptions,
    this.onChangeMode,
    required this.usage,
    this.onRefreshUsage,
    this.workflows = const [],
    this.onStartWorkflow,
    this.activityText,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback? onStop;
  final bool sending;

  /// Why sending is impossible right now (e.g. reconnecting); shown instead of sending.
  final String? blockedReason;
  final String? error;

  /// Provider/model/mode can be changed right now.
  final bool editable;

  /// A new chat (choices apply at launch) rather than an existing session.
  final bool draft;
  final String? lockedReason;
  final String providerLabel;
  final String modelLabel;
  final String mode;
  final VoidCallback? onOpenProviderPicker;
  final VoidCallback? onOpenModelPicker;
  final List<ComposerModeOption> modeOptions;
  final ValueChanged<String>? onChangeMode;
  final UsageView usage;
  final VoidCallback? onRefreshUsage;
  final List<WorkflowChoice> workflows;
  final ValueChanged<String>? onStartWorkflow;
  final String? activityText;

  @override
  State<SessionComposer> createState() => _SessionComposerState();
}

class _SessionComposerState extends State<SessionComposer> {
  bool _usageVisible = true;
  String? _notice;
  bool _inflightExpanded = false;
  bool _hadTypedInInflight = false;
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
    _focusNode.addListener(_onFocus);
  }

  @override
  void didUpdateWidget(SessionComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
    if (oldWidget.sending && !widget.sending) {
      _inflightExpanded = false;
      _hadTypedInInflight = false;
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    _focusNode.removeListener(_onFocus);
    _focusNode.dispose();
    super.dispose();
  }

  void _onText() {
    final text = widget.controller.text;
    if (widget.sending && _inflightExpanded) {
      if (text.trim().isEmpty && _hadTypedInInflight) {
        setState(() {
          _inflightExpanded = false;
          _hadTypedInInflight = false;
        });
        return;
      } else if (text.trim().isNotEmpty) {
        _hadTypedInInflight = true;
      }
    }
    setState(() {});
  }

  void _onFocus() {
    if (!_focusNode.hasFocus && widget.sending && _inflightExpanded && widget.controller.text.trim().isEmpty) {
      setState(() {
        _inflightExpanded = false;
        _hadTypedInInflight = false;
      });
    }
  }

  void _handleSend() {
    if (widget.controller.text.trim().isEmpty || widget.blockedReason != null) return;
    widget.onSend();
    if (widget.sending) {
      setState(() {
        _inflightExpanded = false;
        _hadTypedInInflight = false;
      });
      _focusNode.unfocus();
    }
  }

  void _openOptions() {
    showPraxisSheet<void>(
      context,
      builder: (_) => _SessionOptionsSheet(
        editable: widget.editable,
        draft: widget.draft,
        lockedReason: widget.lockedReason,
        mode: widget.mode,
        modeOptions: widget.modeOptions,
        onChangeMode: widget.onChangeMode,
        usageHidden: !_usageVisible,
        onShowUsage: () => setState(() => _usageVisible = true),
        workflows: widget.workflows,
        onStartWorkflow: widget.onStartWorkflow,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final lockedHint = widget.lockedReason ?? 'Provider and model are fixed right now.';
    final hasText = widget.controller.text.trim().isNotEmpty;
    final canSend = hasText && widget.blockedReason == null;
    final gap = SizedBox(height: t.s(7));
    final isCollapsed = widget.sending && !_inflightExpanded;

    return Container(
      padding: EdgeInsets.fromLTRB(t.s(10), t.s(7), t.s(10), t.s(9)),
      decoration: BoxDecoration(
        color: p.chrome,
        border: Border(top: BorderSide(color: p.border, width: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_usageVisible) ...[_UsagePanel(usage: widget.usage, onHide: () => setState(() => _usageVisible = false), onRefresh: widget.onRefreshUsage), gap],
          if (widget.blockedReason != null) ...[
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: t.s(4)),
                child: Text(widget.blockedReason!, style: ts(context, 11, lineHeight: 15, color: p.warn)),
              ),
            ),
            gap,
          ],
          if (widget.error != null) ...[
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: t.s(4)),
                child: Text(widget.error!, style: ts(context, 11, lineHeight: 15, color: p.danger)),
              ),
            ),
            gap,
          ],
          if (_notice != null && !widget.editable) ...[
            GestureDetector(
              onTap: () => setState(() => _notice = null),
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: t.s(4)),
                child: Text(_notice!, style: ts(context, 11, lineHeight: 15, color: p.warn)),
              ),
            ),
            gap,
          ],
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: p.input,
              borderRadius: BorderRadius.circular(t.s(11)),
              border: Border.all(color: p.borderStrong),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AnimatedSize(
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeInOut,
                  alignment: Alignment.topCenter,
                  child: isCollapsed
                      ? const SizedBox.shrink()
                      : Semantics(
                          label: 'Session message',
                          textField: true,
                          child: ConstrainedBox(
                            constraints: BoxConstraints(maxHeight: t.s(124)),
                            child: Padding(
                              padding: EdgeInsets.fromLTRB(t.s(12), t.s(8), t.s(12), t.s(6)),
                              child: CupertinoTextField.borderless(
                                focusNode: _focusNode,
                                textAlignVertical: TextAlignVertical.top,
                                controller: widget.controller,
                                padding: EdgeInsets.zero,
                                minLines: 1,
                                maxLines: null,
                                placeholder: widget.sending
                                    ? 'Queue follow-up (sends automatically when done)…'
                                    : widget.draft
                                        ? 'Describe what the agent should do…'
                                        : 'Ask the agent to clarify, change, or continue…',
                                placeholderStyle: ts(context, 13, lineHeight: 18, color: p.textDim),
                                style: ts(context, 13, lineHeight: 18),
                                cursorColor: p.accent,
                                keyboardType: TextInputType.multiline,
                                textInputAction: TextInputAction.send,
                                onSubmitted: (_) {
                                  if (canSend) _handleSend();
                                },
                              ),
                            ),
                          ),
                        ),
                ),
                Container(
                  constraints: BoxConstraints(minHeight: t.s(40)),
                  padding: EdgeInsets.fromLTRB(t.s(5), isCollapsed ? t.s(4) : 0, t.s(5), t.s(5)),
                  child: Row(
                    children: [
                      if (isCollapsed) ...[
                        Container(
                          height: t.s(29),
                          padding: EdgeInsets.symmetric(horizontal: t.s(7)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _ActivityDot(color: p.accent),
                              SizedBox(width: t.s(6)),
                              Text(
                                widget.activityText ?? 'Working…',
                                style: ts(context, 11, weight: FontWeight.w500, color: p.textSecondary),
                              ),
                            ],
                          ),
                        ),
                        const Spacer(),
                        Pressable(
                          label: 'Ask, queue a follow-up message while the agent is working',
                          onTap: () {
                            setState(() {
                              _inflightExpanded = true;
                              _hadTypedInInflight = false;
                            });
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              if (mounted) _focusNode.requestFocus();
                            });
                          },
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Container(
                            height: t.s(29),
                            padding: EdgeInsets.symmetric(horizontal: t.s(8)),
                            decoration: BoxDecoration(
                              color: pressed ? p.surfaceRaised : p.surface,
                              borderRadius: BorderRadius.circular(t.s(6)),
                              border: Border.all(color: p.border, width: 0.5),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                _chatsIcon(p.textSecondary, size: t.s(12)),
                                SizedBox(width: t.s(5)),
                                Text('Ask', style: ts(context, 11, weight: FontWeight.w600, color: p.text)),
                              ],
                            ),
                          ),
                        ),
                        SizedBox(width: t.s(4)),
                        Pressable(
                          label: 'Stop response',
                          enabled: widget.onStop != null,
                          onTap: widget.onStop,
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Container(
                            width: t.s(34),
                            height: t.s(34),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: pressed ? p.dangerSoft : null,
                              borderRadius: BorderRadius.circular(t.s(8)),
                            ),
                            child: Text(
                              '×',
                              style: ts(context, 20, lineHeight: 22, weight: FontWeight.w600, color: p.danger),
                            ),
                          ),
                        ),
                      ] else if (widget.sending) ...[
                        Pressable(
                          label: 'Hide follow-up input',
                          onTap: () {
                            setState(() {
                              _inflightExpanded = false;
                              _hadTypedInInflight = false;
                            });
                            _focusNode.unfocus();
                          },
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Container(
                            height: t.s(29),
                            padding: EdgeInsets.symmetric(horizontal: t.s(6)),
                            decoration: BoxDecoration(
                              color: pressed ? p.surfaceRaised : null,
                              borderRadius: BorderRadius.circular(t.s(6)),
                              border: Border.all(color: p.border, width: 0.5),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text('▾', style: ts(context, 9, scaled: false, color: p.textDim)),
                                SizedBox(width: t.s(3)),
                                Text('Hide', style: ts(context, 11, color: p.textSecondary)),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 1),
                        _Chip(
                          icon: '‹›',
                          label: widget.providerLabel,
                          editable: false,
                          hint: lockedHint,
                          onTap: () => setState(() => _notice = lockedHint),
                        ),
                        const Spacer(),
                        Pressable(
                          label: 'Stop response',
                          enabled: widget.onStop != null,
                          onTap: widget.onStop,
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Container(
                            width: t.s(34),
                            height: t.s(34),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              color: pressed ? p.dangerSoft : null,
                              borderRadius: BorderRadius.circular(t.s(8)),
                            ),
                            child: Text(
                              '×',
                              style: ts(context, 20, lineHeight: 22, weight: FontWeight.w600, color: p.danger),
                            ),
                          ),
                        ),
                        SizedBox(width: t.s(4)),
                        Pressable(
                          label: 'Queue follow-up',
                          enabled: canSend,
                          onTap: canSend ? _handleSend : null,
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Opacity(
                            opacity: !canSend ? 0.48 : 1,
                            child: Container(
                              width: t.s(34),
                              height: t.s(34),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: pressed ? p.surfaceRaised : null,
                                borderRadius: BorderRadius.circular(t.s(8)),
                              ),
                              child: Text(
                                '↑',
                                style: ts(context, 22, lineHeight: 24, weight: FontWeight.w600, color: canSend ? p.text : p.textDim),
                              ),
                            ),
                          ),
                        ),
                      ] else ...[
                        _Chip(
                          icon: '‹›',
                          label: widget.providerLabel,
                          editable: widget.editable,
                          hint: widget.editable
                              ? (widget.draft ? 'Choose the AI provider for this new chat' : 'Hand this session over to another AI provider')
                              : lockedHint,
                          onTap: () => widget.editable ? widget.onOpenProviderPicker?.call() : setState(() => _notice = lockedHint),
                        ),
                        const SizedBox(width: 1),
                        _Chip(
                          icon: '✦',
                          label: widget.modelLabel,
                          editable: widget.editable,
                          hint: widget.editable ? (widget.draft ? 'Choose the model for this new chat' : 'Change the model for the next turn') : lockedHint,
                          onTap: () => widget.editable ? widget.onOpenModelPicker?.call() : setState(() => _notice = lockedHint),
                        ),
                        const Spacer(),
                        Pressable(
                          label: 'Session options, ${modeLabels[widget.mode]} mode',
                          onTap: _openOptions,
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Container(
                            width: t.s(34),
                            height: t.s(34),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: pressed ? p.surfaceRaised : null, borderRadius: BorderRadius.circular(t.s(8))),
                            child: Text(
                              '☷',
                              style: ts(context, 20, lineHeight: 22, weight: FontWeight.w700, color: p.textSecondary),
                            ),
                          ),
                        ),
                        const SizedBox(width: 1),
                        Pressable(
                          label: 'Send message',
                          enabled: canSend,
                          onTap: canSend ? widget.onSend : null,
                          excludeChildSemantics: true,
                          builder: (context, pressed) => Opacity(
                            opacity: !canSend ? 0.48 : 1,
                            child: Container(
                              width: t.s(34),
                              height: t.s(34),
                              alignment: Alignment.center,
                              decoration: BoxDecoration(color: pressed ? p.surfaceRaised : null, borderRadius: BorderRadius.circular(t.s(8))),
                              child: Text(
                                '↑',
                                style: ts(context, 22, lineHeight: 24, weight: FontWeight.w600, color: canSend ? p.text : p.textDim),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ActivityDot extends StatefulWidget {
  const _ActivityDot({required this.color});
  final Color color;

  @override
  State<_ActivityDot> createState() => _ActivityDotState();
}

class _ActivityDotState extends State<_ActivityDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) => Opacity(
        opacity: 0.35 + (_controller.value * 0.65),
        child: Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
        ),
      ),
    );
  }
}

Widget _chatsIcon(Color color, {double size = 12}) {
  return SvgPicture.string(
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
    '<path d="M1.9 3.4h8.4v5.6H5.1L2.6 11.1V9H1.9z"/>'
    '<path d="M6.2 5.3h7.9v5.6h-.7v2.1l-2.5-2.1H8.4"/>'
    '</svg>',
    width: size,
    height: size,
    colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
  );
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label, required this.editable, required this.hint, required this.onTap});
  final String icon;
  final String label;
  final bool editable;
  final String hint;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    return Pressable(
      label: label,
      hint: hint,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        height: t.s(29),
        constraints: BoxConstraints(maxWidth: t.s(124)),
        padding: EdgeInsets.symmetric(horizontal: t.s(6)),
        decoration: BoxDecoration(
          color: pressed ? p.surfaceRaised : null,
          borderRadius: BorderRadius.circular(t.s(6)),
          border: editable ? Border.all(color: p.border, width: 0.5) : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              icon,
              style: ts(context, 13, weight: FontWeight.w500, color: p.textSecondary),
            ),
            SizedBox(width: t.s(4)),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ts(context, 11, color: editable ? p.textSecondary : p.textDim),
              ),
            ),
            if (editable) ...[SizedBox(width: t.s(4)), Text('▾', style: ts(context, 9, scaled: false, color: p.textDim))],
          ],
        ),
      ),
    );
  }
}

class _UsagePanel extends StatefulWidget {
  const _UsagePanel({required this.usage, required this.onHide, this.onRefresh});
  final UsageView usage;
  final VoidCallback onHide;
  final VoidCallback? onRefresh;

  @override
  State<_UsagePanel> createState() => _UsagePanelState();
}

class _UsagePanelState extends State<_UsagePanel> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final usage = widget.usage;
    return Container(
      constraints: BoxConstraints(minHeight: t.s(42)),
      padding: EdgeInsets.only(left: t.s(11)),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(t.s(8)),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Pressable(
                  label: 'Usage: ${usage.summary}',
                  hint: 'Shows token and cost details from the desktop',
                  onTap: () {
                    if (!_expanded) widget.onRefresh?.call();
                    setState(() => _expanded = !_expanded);
                  },
                  excludeChildSemantics: true,
                  builder: (context, _) => ConstrainedBox(
                    constraints: BoxConstraints(minHeight: t.s(40)),
                    child: Row(
                      children: [
                        Text(
                          '⌁',
                          style: ts(context, 13, weight: FontWeight.w500, color: p.accent),
                        ),
                        SizedBox(width: t.s(7)),
                        Text('Usage', style: ts(context, 13, color: p.textSecondary)),
                        SizedBox(width: t.s(8)),
                        if (usage.state == UsageState.loading) ...[const Spinner(), SizedBox(width: t.s(8))],
                        Expanded(
                          child: Text(
                            usage.summary,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ts(context, 11, color: p.textDim),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              Pressable(
                label: 'Hide usage',
                onTap: widget.onHide,
                excludeChildSemantics: true,
                builder: (context, _) => SizedBox(
                  width: t.s(32),
                  height: t.s(40),
                  child: Center(
                    child: Text(
                      '×',
                      style: ts(context, 17, weight: FontWeight.w300, color: p.textDim),
                    ),
                  ),
                ),
              ),
            ],
          ),
          if (_expanded && usage.details.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(right: t.s(11), bottom: t.s(9)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final row in usage.details)
                    Padding(
                      padding: EdgeInsets.only(bottom: t.s(4)),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(row.label, style: ts(context, 11, color: p.textDim)),
                          const SizedBox(width: 12),
                          Flexible(
                            child: Text(
                              row.value,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ts(context, 11, color: p.textSecondary, features: tabular),
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (!usage.costReported)
                    Padding(
                      padding: EdgeInsets.only(top: t.s(3)),
                      child: Text(
                        'Cost appears only when the provider reports it; Praxis does not estimate it.',
                        style: ts(context, 10, lineHeight: 14, color: p.textDim),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _SessionOptionsSheet extends StatefulWidget {
  const _SessionOptionsSheet({
    required this.editable,
    required this.draft,
    this.lockedReason,
    required this.mode,
    required this.modeOptions,
    this.onChangeMode,
    required this.usageHidden,
    required this.onShowUsage,
    required this.workflows,
    this.onStartWorkflow,
  });

  final bool editable;
  final bool draft;
  final String? lockedReason;
  final String mode;
  final List<ComposerModeOption> modeOptions;
  final ValueChanged<String>? onChangeMode;
  final bool usageHidden;
  final VoidCallback onShowUsage;
  final List<WorkflowChoice> workflows;
  final ValueChanged<String>? onStartWorkflow;

  @override
  State<_SessionOptionsSheet> createState() => _SessionOptionsSheetState();
}

class _SessionOptionsSheetState extends State<_SessionOptionsSheet> {
  late String mode = widget.mode;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final editable = widget.editable;
    final draft = widget.draft;
    final lockedReason = widget.lockedReason;
    final modeOptions = widget.modeOptions;
    final workflows = widget.workflows;
    final onStartWorkflow = widget.onStartWorkflow;
    ComposerModeOption? current;
    for (final option in modeOptions) {
      if (option.mode == mode) current = option;
    }
    void close() => Navigator.of(context).pop();
    Widget section(String text) => Padding(
      padding: EdgeInsets.only(top: t.s(12), bottom: t.s(6)),
      child: Text(
        text,
        style: ts(context, 10, weight: FontWeight.w700, letterSpacing: 0.8, color: p.textDim),
      ),
    );
    Widget note(String text) => Padding(
      padding: EdgeInsets.only(top: t.s(6)),
      child: Text(text, style: ts(context, 11, lineHeight: 16, color: p.textDim)),
    );
    final toolAccess = current?.toolAccess;

    return SheetFrame(
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: EdgeInsets.only(bottom: t.s(12)),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Session options', style: ts(context, 17, weight: FontWeight.w700)),
                        SizedBox(height: t.s(3)),
                        Text(
                          draft
                              ? 'Applies to this new chat when you send its first message'
                              : editable
                              ? 'Applies from the next turn of this session'
                              : lockedReason ?? 'Cannot change right now',
                          style: ts(context, 10, color: p.textDim),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(width: t.s(10)),
                  SquareIconButton(label: 'Close session options', glyph: '×', onTap: close, size: t.s(34), glyphSize: t.s(21)),
                ],
              ),
            ),
            section('SESSION MODE'),
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: p.surface,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: p.border),
              ),
              child: Row(
                children: [
                  for (final option in modeOptions) ...[
                    if (option != modeOptions.first) const SizedBox(width: 2),
                    Expanded(
                      child: Pressable(
                        label: modeLabels[option.mode],
                        hint: option.available ? modeDescriptions[option.mode] : option.unavailableMessage,
                        selected: mode == option.mode,
                        enabled: editable && option.available,
                        onTap: () {
                          if (option.mode == mode) return;
                          widget.onChangeMode?.call(option.mode);
                          setState(() => mode = option.mode);
                        },
                        excludeChildSemantics: true,
                        builder: (context, _) => Container(
                          padding: EdgeInsets.symmetric(vertical: t.s(8)),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: mode == option.mode ? p.surfaceRaised : null, borderRadius: BorderRadius.circular(t.s(6))),
                          child: Opacity(
                            opacity: option.available ? 1 : 0.45,
                            child: Text(
                              modeLabels[option.mode] ?? option.mode,
                              style: ts(context, 12, weight: FontWeight.w600, color: mode == option.mode ? p.text : p.textDim),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            note(
              '${current != null && !current.available && current.unavailableMessage != null ? current.unavailableMessage! : modeDescriptions[mode]}${editable || lockedReason == null ? '' : ' $lockedReason'}',
            ),
            for (final option in modeOptions.where((option) => !option.available && option.mode != mode))
              note('${modeLabels[option.mode]}: ${option.unavailableMessage ?? 'not available on this desktop.'}'),
            section('CONTEXT'),
            note(
              'Tool access and the working folder are set by the desktop project${toolAccess != null ? ' — ${modeLabels[mode]} runs with ${toolAccess == 'read-only'
                        ? 'read-only tools'
                        : toolAccess == 'project-only'
                        ? 'project tools only'
                        : 'full tools'}' : ''}. They are not changed from the phone.',
            ),
            if (widget.usageHidden)
              _Group(
                children: [
                  _SheetRow(
                    icon: '⌁',
                    label: 'Show usage',
                    onTap: () {
                      widget.onShowUsage();
                      close();
                    },
                  ),
                ],
              ),
            section('WORKFLOWS'),
            _Group(
              children: [
                for (final workflow in workflows)
                  _SheetRow(
                    icon: '▶',
                    label: workflow.name,
                    value: 'Start on desktop',
                    onTap: onStartWorkflow == null
                        ? null
                        : () {
                            onStartWorkflow(workflow.workflowId);
                            close();
                          },
                  ),
                if (workflows.isEmpty) const _SheetRow(icon: '▶', label: 'No workflows available for this project'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Container(
    margin: EdgeInsets.only(top: context.t.s(6)),
    clipBehavior: Clip.antiAlias,
    decoration: BoxDecoration(
      color: context.p.surface,
      borderRadius: BorderRadius.circular(context.t.s(9)),
      border: Border.all(color: context.p.border),
    ),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
  );
}

class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.icon, required this.label, this.value, this.onTap});
  final String icon;
  final String label;
  final String? value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    return Pressable(
      label: value != null ? '$label, $value' : label,
      button: onTap != null,
      onTap: onTap,
      excludeChildSemantics: true,
      builder: (context, pressed) => Container(
        constraints: BoxConstraints(minHeight: t.s(48)),
        padding: EdgeInsets.symmetric(horizontal: t.s(10)),
        decoration: BoxDecoration(
          color: pressed && onTap != null ? p.surfaceRaised : null,
          border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
        ),
        child: Row(
          children: [
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: p.bgSunken, borderRadius: BorderRadius.circular(7)),
              child: Text(
                icon,
                style: ts(context, 12, scaled: false, weight: FontWeight.w700, color: p.textSecondary),
              ),
            ),
            SizedBox(width: t.s(9)),
            Expanded(
              child: Text(
                label,
                style: ts(context, 13, weight: FontWeight.w600, color: p.textSecondary),
              ),
            ),
            if (value != null) ...[
              SizedBox(width: t.s(9)),
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.35),
                child: Text(
                  value!,
                  maxLines: 2,
                  textAlign: TextAlign.right,
                  style: ts(context, 12, color: p.textDim),
                ),
              ),
            ],
            if (onTap != null) ...[SizedBox(width: t.s(9)), Text('›', style: ts(context, 18, color: p.textDim))],
          ],
        ),
      ),
    );
  }
}

List<ComposerModeOption> composerModeOptions(ProviderCatalog? catalog) {
  if (catalog == null) {
    const message = 'Choosing a mode from the phone needs a newer Praxis desktop.';
    return const [
      ComposerModeOption(mode: 'chat', available: true),
      ComposerModeOption(mode: 'analysis', available: false, unavailableMessage: message),
      ComposerModeOption(mode: 'review', available: false, unavailableMessage: message),
    ];
  }
  return catalog.sessionModes
      .map(
        (option) =>
            ComposerModeOption(mode: option.mode, available: option.available, toolAccess: option.toolAccess, unavailableMessage: option.unavailableMessage),
      )
      .toList();
}
