import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../app/diagnostics.dart';
import '../app/theme.dart';
import '../core/gadgets.dart';
import '../core/models.dart';
import 'kit.dart';
import 'markdown_view.dart';

/// Sends an answer; completes when the desktop has recorded it, throws a message a person can read.
typedef GadgetAnswer = Future<void> Function(GadgetEnvelope gadget, GadgetActionDescriptor action, Map<String, Object?> value);

/// The desktop's convention: an informational button declines, anything else confirms.
Map<String, Object?> _confirmationValue(GadgetActionDescriptor action) => {'kind': 'confirmation', 'confirmed': action.effect != 'informational'};
Map<String, Object?> _noValue(GadgetActionDescriptor _) => const {'kind': 'none'};

String _string(Object? value) => value is String
    ? value
    : value == null
    ? ''
    : '$value';
List<Json> _maps(Object? value) => value is List ? value.whereType<Json>().toList() : const [];

/// One gadget in a conversation. An unknown kind or version, or a body that
/// cannot read its payload, falls back to the gadget's own text.
class GadgetViewWidget extends StatelessWidget {
  const GadgetViewWidget({super.key, required this.view, required this.connected, required this.onAnswer});
  final GadgetView view;
  final bool connected;
  final GadgetAnswer onAnswer;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final gadget = view.gadget;
    final reason = inertGadgetReason(view) ?? (connected ? null : 'Reconnect to the desktop to answer.');
    final answerable = isGadgetAnswerable(view) && connected;
    final hasActions = gadget.actions.isNotEmpty;
    Widget body;
    if (canDrawGadget(gadget)) {
      try {
        body = _body(gadget, answerable);
      } catch (error) {
        Diagnostics.instance.record('Showing a ${gadget.kind} from the agent', error);
        body = MarkdownView(gadget.fallbackText);
      }
    } else {
      body = MarkdownView(gadget.fallbackText);
    }
    return Semantics(
      label: '${gadget.kind} from the agent',
      container: true,
      explicitChildNodes: true,
      child: Opacity(
        opacity: !answerable && hasActions ? 0.85 : 1,
        child: Container(
          padding: EdgeInsets.all(t.s(12)),
          decoration: BoxDecoration(
            color: t.palette.surfaceRaised,
            borderRadius: BorderRadius.circular(t.s(10)),
            border: Border.all(color: t.palette.borderStrong),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              body,
              if (reason != null && hasActions) ...[
                SizedBox(height: t.s(10)),
                Text(
                  reason,
                  style: ts(context, 12.5, color: t.palette.textDim, style: FontStyle.italic),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(GadgetEnvelope gadget, bool answerable) {
    final payload = gadget.payload;
    return switch (gadget.kind) {
      'choice' => _Choice(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'confirmation' => _Confirmation(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'approval' => _Approval(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'form' => _Form(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'table' => _Table(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'chart' => _Chart(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'progress' => _Progress(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'diff' => _Diff(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'artifact' => _Artifact(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'handoff' => _Handoff(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      'conflict' => _Conflict(gadget: gadget, payload: payload, answerable: answerable, onAnswer: onAnswer),
      _ => MarkdownView(gadget.fallbackText),
    };
  }
}

/// Children with the gadget card's 10-point gap.
Widget _stack(BuildContext context, List<Widget> children) {
  final gap = context.t.s(10);
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 0; i < children.length; i += 1) ...[if (i > 0) SizedBox(height: gap), children[i]],
    ],
  );
}

class _Heading extends StatelessWidget {
  const _Heading(this.title, [this.detail]);
  final String title;
  final String? detail;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Semantics(
        header: true,
        child: Text(title, style: ts(context, 15, weight: FontWeight.w700)),
      ),
      if (detail != null && detail!.isNotEmpty) ...[SizedBox(height: context.t.s(4)), MarkdownView(detail!)],
    ],
  );
}

TextStyle _dim(BuildContext context) => ts(context, 12.5, lineHeight: 18, color: context.p.textDim);
TextStyle _bodyText(BuildContext context) => ts(context, 14, lineHeight: 20);
TextStyle _mono(BuildContext context, [Color? color]) => ts(context, 12, family: monospace, color: color);

class _ActionBar extends StatefulWidget {
  const _ActionBar({required this.gadget, required this.answerable, required this.valueFor, required this.onAnswer, this.blockedReason});
  final GadgetEnvelope gadget;
  final bool answerable;
  final Map<String, Object?>? Function(GadgetActionDescriptor action) valueFor;
  final String? blockedReason;
  final GadgetAnswer onAnswer;

  @override
  State<_ActionBar> createState() => _ActionBarState();
}

class _ActionBarState extends State<_ActionBar> {
  String? _busy;
  String? _error;

  Future<void> _send(GadgetActionDescriptor action) async {
    final value = widget.valueFor(action);
    if (value == null) return;
    Future<void> go() async {
      setState(() {
        _busy = action.actionId;
        _error = null;
      });
      try {
        await widget.onAnswer(widget.gadget, action, value);
      } catch (cause) {
        if (mounted) setState(() => _error = Diagnostics.messageOf(cause));
      } finally {
        if (mounted) setState(() => _busy = null);
      }
    }

    if (action.danger) {
      final confirmed = await showCupertinoDialog<bool>(
        context: context,
        builder: (context) => CupertinoAlertDialog(
          title: Text(action.label),
          content: Text(action.description ?? 'This cannot be undone from the phone.'),
          actions: [
            CupertinoDialogAction(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
            CupertinoDialogAction(isDestructiveAction: true, onPressed: () => Navigator.of(context).pop(true), child: Text(action.label)),
          ],
        ),
      );
      if (confirmed == true) await go();
      return;
    }
    await go();
  }

  @override
  Widget build(BuildContext context) {
    final actions = widget.gadget.actions;
    if (actions.isEmpty) return const SizedBox.shrink();
    final t = context.t;
    final p = t.palette;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (widget.blockedReason != null && widget.answerable) ...[
          Text(widget.blockedReason!, style: ts(context, 12.5, color: p.warn)),
          SizedBox(height: t.s(6)),
        ],
        Wrap(
          spacing: t.s(8),
          runSpacing: t.s(8),
          children: [
            for (final action in actions)
              Builder(
                builder: (context) {
                  final disabled = !widget.answerable || _busy != null || widget.valueFor(action) == null;
                  final primary = action.effect != 'informational' && !action.danger;
                  return Pressable(
                    label: action.description != null ? '${action.label}. ${action.description}' : action.label,
                    enabled: !disabled,
                    onTap: () => _send(action),
                    excludeChildSemantics: true,
                    builder: (context, pressed) => Opacity(
                      opacity: disabled
                          ? 0.45
                          : pressed
                          ? 0.7
                          : 1,
                      child: Container(
                        constraints: BoxConstraints(minHeight: t.s(42), minWidth: t.s(96)),
                        padding: EdgeInsets.symmetric(horizontal: t.s(14)),
                        decoration: BoxDecoration(
                          color: primary ? p.accent : null,
                          borderRadius: BorderRadius.circular(t.s(9)),
                          border: primary ? null : Border.all(color: action.danger ? p.danger : p.border),
                        ),
                        child: Align(
                          widthFactor: 1,
                          child: _busy == action.actionId
                              ? Spinner(color: primary ? p.onAccent : p.text)
                              : Text(
                                  action.label,
                                  style: ts(
                                    context,
                                    14,
                                    weight: FontWeight.w700,
                                    color: primary
                                        ? p.onAccent
                                        : action.danger
                                        ? p.danger
                                        : p.text,
                                  ),
                                ),
                        ),
                      ),
                    ),
                  );
                },
              ),
          ],
        ),
        if (_error != null) ...[
          SizedBox(height: t.s(6)),
          Semantics(
            liveRegion: true,
            child: Text(_error!, style: ts(context, 13, color: p.danger)),
          ),
        ],
      ],
    );
  }
}

abstract class _GadgetBody extends StatefulWidget {
  const _GadgetBody({required this.gadget, required this.payload, required this.answerable, required this.onAnswer});
  final GadgetEnvelope gadget;
  final Json payload;
  final bool answerable;
  final GadgetAnswer onAnswer;
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.mark,
    required this.checked,
    required this.enabled,
    required this.onTap,
    required this.children,
    required this.label,
    this.radio = true,
  });
  final String mark;
  final bool checked;
  final bool enabled;
  final VoidCallback onTap;
  final List<Widget> children;
  final String label;
  final bool radio;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    return Semantics(
      checked: checked,
      inMutuallyExclusiveGroup: radio,
      child: Pressable(
        label: label,
        button: false,
        enabled: enabled,
        onTap: onTap,
        builder: (context, _) => Container(
          padding: EdgeInsets.all(t.s(10)),
          decoration: BoxDecoration(
            color: checked ? p.accentSoft : p.surface,
            borderRadius: BorderRadius.circular(t.s(8)),
            border: Border.all(color: checked ? p.accent : p.border),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(mark, style: ts(context, 16, lineHeight: 20, color: p.accent)),
              SizedBox(width: t.s(10)),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Choice extends _GadgetBody {
  const _Choice({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Choice> createState() => _ChoiceState();
}

class _ChoiceState extends State<_Choice> {
  late List<String> _selected = [if (widget.payload['defaultValue'] is String) widget.payload['defaultValue'] as String];

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final multiple = widget.payload['multiple'] == true;
    final options = _maps(widget.payload['options']);
    return _stack(context, [
      _Heading(_string(widget.payload['question']), widget.payload['detail'] as String?),
      Column(
        children: [
          for (final option in options) ...[
            if (option != options.first) SizedBox(height: t.s(6)),
            Builder(
              builder: (context) {
                final value = _string(option['value']);
                final checked = _selected.contains(value);
                final unavailable = option['disabledReason'] is String;
                return Opacity(
                  opacity: unavailable ? 0.45 : 1,
                  child: _OptionRow(
                    label: _string(option['label']),
                    radio: !multiple,
                    mark: multiple
                        ? (checked ? '☑' : '☐')
                        : checked
                        ? '◉'
                        : '○',
                    checked: checked,
                    enabled: widget.answerable && !unavailable,
                    onTap: () => setState(() {
                      if (!multiple) {
                        _selected = [value];
                      } else {
                        _selected = checked ? _selected.where((entry) => entry != value).toList() : [..._selected, value];
                      }
                    }),
                    children: [
                      Text(_string(option['label']), style: ts(context, 14, weight: FontWeight.w600)),
                      if (option['description'] is String) Text(option['description'] as String, style: _dim(context)),
                      if (unavailable) Text('Unavailable: ${option['disabledReason']}', style: ts(context, 12.5, color: t.palette.warn)),
                    ],
                  ),
                );
              },
            ),
          ],
        ],
      ),
      _ActionBar(
        gadget: widget.gadget,
        answerable: widget.answerable,
        onAnswer: widget.onAnswer,
        blockedReason: _selected.isEmpty ? 'Choose an option first.' : null,
        valueFor: (_) => _selected.isEmpty
            ? null
            : multiple
            ? {'kind': 'selection', 'selected': _selected}
            : {'kind': 'choice', 'selected': _selected.first},
      ),
    ]);
  }
}

class _Confirmation extends _GadgetBody {
  const _Confirmation({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Confirmation> createState() => _PlainState<_Confirmation>();
}

class _PlainState<T extends _GadgetBody> extends State<T> {
  @override
  Widget build(BuildContext context) {
    final payload = widget.payload;
    final t = context.t;
    switch (widget.gadget.kind) {
      case 'confirmation':
        final consequences = payload['consequences'] is List ? (payload['consequences'] as List).map(_string).toList() : const <String>[];
        return _stack(context, [
          _Heading(_string(payload['question']), payload['detail'] as String?),
          if (consequences.isNotEmpty)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final line in consequences)
                  Padding(
                    padding: EdgeInsets.only(bottom: t.s(4)),
                    child: Text('• $line', style: _bodyText(context)),
                  ),
              ],
            ),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _confirmationValue),
        ]);
      case 'approval':
        final evidence = _maps(payload['evidence']);
        return _stack(context, [
          _Heading(_string(payload['title'])),
          MarkdownView(_string(payload['summary'])),
          if (payload['effect'] is String)
            Text(
              'Approving: ${payload['effect']}',
              style: ts(context, 13.5, weight: FontWeight.w600, color: t.palette.warn),
            ),
          if (evidence.isNotEmpty)
            Container(
              decoration: BoxDecoration(
                border: Border.all(color: t.palette.border),
                borderRadius: BorderRadius.circular(t.s(8)),
              ),
              child: Column(
                children: [
                  for (final row in evidence)
                    Container(
                      padding: EdgeInsets.symmetric(horizontal: t.s(10), vertical: t.s(7)),
                      decoration: BoxDecoration(
                        border: Border(bottom: BorderSide(color: t.palette.border)),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            flex: 38,
                            child: Text(_string(row['label']), style: ts(context, 12.5, color: t.palette.textDim)),
                          ),
                          SizedBox(width: t.s(10)),
                          Expanded(flex: 62, child: SelectableText(_string(row['value']), style: ts(context, 12.5))),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          if (payload['requestedBy'] is String) Text('Requested by ${payload['requestedBy']} · gate ${payload['gate']}', style: _dim(context)),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _confirmationValue),
        ]);
      case 'table':
        final columns = _maps(payload['columns']);
        final rows = _maps(payload['rows']);
        final width = t.s(128);
        Widget cell(String text, Json column, {bool header = false}) => SizedBox(
          width: width,
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: t.s(6)),
            child: Text(
              text,
              textAlign: column['align'] == 'end' ? TextAlign.right : TextAlign.left,
              style: column['mono'] == true && !header ? _mono(context) : ts(context, 12.5, weight: header ? FontWeight.w700 : FontWeight.w400),
            ),
          ),
        );
        return _stack(context, [
          if (payload['title'] is String) _Heading(payload['title'] as String),
          if (rows.isEmpty)
            Text(_string(payload['emptyText'] ?? 'No rows.'), style: _dim(context))
          else
            Align(
              alignment: Alignment.centerLeft,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Container(
                  decoration: BoxDecoration(
                    border: Border.all(color: t.palette.border),
                    borderRadius: BorderRadius.circular(t.s(6)),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        decoration: BoxDecoration(
                          color: t.palette.bgSunken,
                          border: Border(bottom: BorderSide(color: t.palette.border)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [for (final column in columns) cell(_string(column['label']), column, header: true)],
                        ),
                      ),
                      for (final row in rows)
                        Container(
                          decoration: BoxDecoration(
                            border: Border(bottom: BorderSide(color: t.palette.border)),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [for (final column in columns) cell(row[column['key']] == null ? '—' : _string(row[column['key']]), column)],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          if (payload['caption'] is String) Text(payload['caption'] as String, style: _dim(context)),
          if (payload['truncated'] == true) Text('Some rows were left off on the phone. The desktop shows them all.', style: _dim(context)),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _noValue),
        ]);
      case 'chart':
        final bars = chartBars(payload);
        final series = (payload['series'] as List?)?.length ?? 0;
        return _stack(context, [
          if (payload['title'] is String) _Heading(payload['title'] as String),
          if (bars.series.isNotEmpty) Text('${bars.series}${series > 1 ? ' (1 of $series series)' : ''}', style: _dim(context)),
          Semantics(
            label: bars.bars.map((bar) => '${bar.label}: ${bar.value}').join(', '),
            child: Column(
              children: [
                for (final bar in bars.bars)
                  Padding(
                    padding: EdgeInsets.only(bottom: t.s(6)),
                    child: LayoutBuilder(
                      builder: (context, box) => Row(
                        children: [
                          SizedBox(
                            width: box.maxWidth * 0.26,
                            child: Text(
                              bar.label,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ts(context, 12, color: t.palette.textSecondary),
                            ),
                          ),
                          SizedBox(width: t.s(8)),
                          Expanded(
                            child: _Track(fraction: bar.fraction < 0.02 ? 0.02 : bar.fraction, color: t.palette.accent),
                          ),
                          SizedBox(width: t.s(8)),
                          ConstrainedBox(
                            constraints: BoxConstraints(minWidth: t.s(36)),
                            child: Text('${bar.value}', textAlign: TextAlign.right, style: ts(context, 12)),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (bars.more > 0) Text('${bars.more} more not shown.', style: _dim(context)),
          if (payload['summary'] is String) Text(payload['summary'] as String, style: _bodyText(context)),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _noValue),
        ]);
      case 'progress':
        final status = _string(payload['status']);
        final percent = payload['percent'] is num ? (payload['percent'] as num).toDouble() : null;
        final tone = status == 'succeeded'
            ? t.palette.ok
            : status == 'failed'
            ? t.palette.danger
            : status == 'blocked'
            ? t.palette.warn
            : t.palette.accent;
        final steps = _maps(payload['steps']);
        return _stack(context, [
          _Heading(_string(payload['title'])),
          _Track(fraction: percent == null ? 0.35 : (percent.clamp(2, 100)) / 100, color: tone),
          Text('$status${percent != null ? ' · ${percent.round()}%' : ''}', style: _dim(context).copyWith(color: tone)),
          if (payload['detail'] is String) Text(payload['detail'] as String, style: _bodyText(context)),
          for (final step in steps)
            Text(
              '${switch (step['state']) {
                'done' => '✓',
                'failed' => '✕',
                'running' => '▸',
                _ => '·',
              }} ${_string(step['label'])}',
              style: _bodyText(context),
            ),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _noValue),
        ]);
      case 'artifact':
        final artifacts = _maps(payload['artifacts']);
        return _stack(context, [
          _Heading(_string(payload['title'])),
          for (final artifact in artifacts)
            _FileRow(
              children: [
                Text(_string(artifact['name']), style: ts(context, 14, weight: FontWeight.w600)),
                Text(
                  '${_string(artifact['path'])}${artifact['sizeBytes'] is num ? ' · ${_formatBytes((artifact['sizeBytes'] as num).toInt())}' : ''}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: _mono(context, t.palette.textDim),
                ),
                if (artifact['description'] is String) Text(artifact['description'] as String, style: _dim(context)),
              ],
            ),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _noValue),
        ]);
      case 'handoff':
        final included = _maps(payload['includedItems']);
        final excluded = _maps(payload['excludedItems']);
        return _stack(context, [
          _Heading(_string(payload['title'])),
          Text('${_string(payload['fromProvider'])} → ${_string(payload['toProvider'])}', style: _dim(context)),
          MarkdownView(_string(payload['contextSummary'])),
          if (included.isNotEmpty) Text('Included: ${included.map((item) => _string(item['label'])).join(', ')}', style: _bodyText(context)),
          if (excluded.isNotEmpty)
            Text(
              'Left out: ${excluded.map((item) => item['reason'] is String ? '${_string(item['label'])} (${item['reason']})' : _string(item['label'])).join(', ')}',
              style: _bodyText(context),
            ),
          if (payload['warning'] is String)
            Text(
              payload['warning'] as String,
              style: ts(context, 13.5, weight: FontWeight.w600, color: t.palette.warn),
            ),
          _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _confirmationValue),
        ]);
    }
    return MarkdownView(widget.gadget.fallbackText);
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

class _Track extends StatelessWidget {
  const _Track({required this.fraction, required this.color});
  final double fraction;
  final Color color;
  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(4),
    child: Container(
      height: context.t.s(8),
      color: context.p.bgSunken,
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: fraction.clamp(0, 1),
        heightFactor: 1,
        child: DecoratedBox(
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
        ),
      ),
    ),
  );
}

class _FileRow extends StatelessWidget {
  const _FileRow({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.only(top: context.t.s(8)),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: context.p.border)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < children.length; i += 1) ...[if (i > 0) SizedBox(height: context.t.s(4)), children[i]],
      ],
    ),
  );
}

class _Approval extends _GadgetBody {
  const _Approval({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Approval> createState() => _PlainState<_Approval>();
}

class _Table extends _GadgetBody {
  const _Table({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Table> createState() => _PlainState<_Table>();
}

class _Chart extends _GadgetBody {
  const _Chart({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Chart> createState() => _PlainState<_Chart>();
}

class _Progress extends _GadgetBody {
  const _Progress({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Progress> createState() => _PlainState<_Progress>();
}

class _Artifact extends _GadgetBody {
  const _Artifact({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Artifact> createState() => _PlainState<_Artifact>();
}

class _Handoff extends _GadgetBody {
  const _Handoff({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Handoff> createState() => _PlainState<_Handoff>();
}

class _Diff extends _GadgetBody {
  const _Diff({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Diff> createState() => _DiffState();
}

class _DiffState extends State<_Diff> {
  String? _open;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final payload = widget.payload;
    final files = _maps(payload['files']);
    return _stack(context, [
      if (payload['title'] is String) _Heading(payload['title'] as String),
      if (payload['summary'] is String) Text(payload['summary'] as String, style: _bodyText(context)),
      for (final file in files)
        _FileRow(
          children: [
            Pressable(
              label: _string(file['path']),
              enabled: file['preview'] is String,
              onTap: () => setState(() => _open = _open == file['path'] ? null : file['path'] as String),
              builder: (context, _) => Row(
                children: [
                  Expanded(
                    child: Text(
                      file['status'] == 'renamed' && file['previousPath'] is String ? '${file['previousPath']} → ${file['path']}' : _string(file['path']),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _mono(context),
                    ),
                  ),
                  SizedBox(width: t.s(8)),
                  Text('+${_string(file['additions'])}', style: _mono(context, p.ok)),
                  SizedBox(width: t.s(8)),
                  Text('−${_string(file['deletions'])}', style: _mono(context, p.danger)),
                ],
              ),
            ),
            if (_open == file['path'] && file['preview'] is String)
              Container(
                constraints: BoxConstraints(maxHeight: t.s(240)),
                decoration: BoxDecoration(color: p.bgSunken, borderRadius: BorderRadius.circular(t.s(6))),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Padding(
                    padding: EdgeInsets.all(t.s(8)),
                    child: SelectableText(file['preview'] as String, style: _mono(context).copyWith(height: 17 / 12)),
                  ),
                ),
              ),
          ],
        ),
      if (payload['truncated'] == true) Text('More files changed than the phone shows.', style: _dim(context)),
      _ActionBar(gadget: widget.gadget, answerable: widget.answerable, onAnswer: widget.onAnswer, valueFor: _confirmationValue),
    ]);
  }
}

class _Form extends _GadgetBody {
  const _Form({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Form> createState() => _FormState();
}

class _FormState extends State<_Form> {
  late FormValues _values = initialFormValues(widget.payload);
  final Map<String, TextEditingController> _controllers = {};
  bool _touched = false;

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  TextEditingController _controller(String name) =>
      _controllers.putIfAbsent(name, () => TextEditingController(text: _values[name] is String ? _values[name] as String : ''));

  void _set(String name, Object value) => setState(() {
    _touched = true;
    _values = {..._values, name: value};
  });

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    final fields = formFields(widget.payload);
    final errors = validateFormValues(widget.payload, _values);
    final invalid = errors.isNotEmpty;
    return _stack(context, [
      _Heading(_string(widget.payload['title']), widget.payload['description'] as String?),
      for (final field in fields)
        Builder(
          builder: (context) {
            final name = _string(field['name']);
            final label = _string(field['label']);
            final type = field['type'];
            final error = _touched ? errors[name] : null;
            Widget control;
            if (type == 'boolean') {
              control = Align(
                alignment: Alignment.centerLeft,
                child: Semantics(
                  label: label,
                  child: CupertinoSwitch(
                    value: _values[name] == true,
                    onChanged: widget.answerable ? (value) => _set(name, value) : null,
                    activeTrackColor: p.accent,
                  ),
                ),
              );
            } else if (type == 'select') {
              final options = _maps(field['options']);
              control = Wrap(
                spacing: t.s(6),
                runSpacing: t.s(6),
                children: [
                  for (final option in options)
                    Semantics(
                      checked: _values[name] == option['value'],
                      inMutuallyExclusiveGroup: true,
                      child: Pressable(
                        label: _string(option['label']),
                        button: false,
                        enabled: widget.answerable && option['disabledReason'] == null,
                        onTap: () => _set(name, _string(option['value'])),
                        builder: (context, _) => Container(
                          padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(6)),
                          decoration: BoxDecoration(
                            color: _values[name] == option['value'] ? p.accentSoft : null,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: _values[name] == option['value'] ? p.accent : p.border),
                          ),
                          child: Text(_string(option['label']), style: _bodyText(context)),
                        ),
                      ),
                    ),
                ],
              );
            } else {
              control = _Input(
                label: label,
                controller: _controller(name),
                enabled: widget.answerable,
                placeholder: field['placeholder'] as String?,
                number: type == 'number',
                multiline: type == 'textarea',
                maxLength: field['maxLength'] is num ? (field['maxLength'] as num).toInt() : null,
                onChanged: (value) => _set(name, value),
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '$label${field['required'] == true ? ' *' : ''}',
                  style: ts(context, 12.5, weight: FontWeight.w600, color: p.textSecondary),
                ),
                SizedBox(height: t.s(4)),
                control,
                if (field['help'] is String) ...[SizedBox(height: t.s(4)), Text(field['help'] as String, style: _dim(context))],
                if (error != null) ...[SizedBox(height: t.s(4)), Text(error, style: ts(context, 13, color: p.danger))],
              ],
            );
          },
        ),
      _ActionBar(
        gadget: widget.gadget,
        answerable: widget.answerable,
        onAnswer: widget.onAnswer,
        blockedReason: invalid
            ? 'Still needed: ${fields.where((field) => errors.containsKey(field['name'])).map((field) => field['label']).join(', ')}.'
            : null,
        valueFor: (_) => invalid ? null : formActionValue(widget.payload, _values),
      ),
    ]);
  }
}

class _Input extends StatelessWidget {
  const _Input({
    required this.label,
    required this.controller,
    required this.enabled,
    this.placeholder,
    this.number = false,
    this.multiline = false,
    this.maxLength,
    required this.onChanged,
  });
  final String label;
  final TextEditingController controller;
  final bool enabled;
  final String? placeholder;
  final bool number;
  final bool multiline;
  final int? maxLength;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final p = t.palette;
    return Semantics(
      label: label,
      textField: true,
      child: Container(
        constraints: BoxConstraints(minHeight: multiline ? t.s(88) : 0),
        padding: EdgeInsets.symmetric(horizontal: t.s(10), vertical: t.s(8)),
        decoration: BoxDecoration(
          color: p.input,
          borderRadius: BorderRadius.circular(t.s(8)),
          border: Border.all(color: p.border),
        ),
        child: CupertinoTextField.borderless(
          textAlignVertical: TextAlignVertical.top,
          controller: controller,
          enabled: enabled,
          placeholder: placeholder,
          placeholderStyle: ts(context, 14, color: p.textDim),
          style: ts(context, 14),
          padding: EdgeInsets.zero,
          keyboardType: number
              ? const TextInputType.numberWithOptions(decimal: true)
              : multiline
              ? TextInputType.multiline
              : TextInputType.text,
          maxLines: multiline ? null : 1,
          maxLength: maxLength,
          cursorColor: p.accent,
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _Conflict extends _GadgetBody {
  const _Conflict({required super.gadget, required super.payload, required super.answerable, required super.onAnswer});
  @override
  State<_Conflict> createState() => _ConflictState();
}

class _ConflictState extends State<_Conflict> {
  final Map<String, String> _choices = {};

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final conflicts = _maps(widget.payload['conflicts']);
    final unresolved = conflicts.where((conflict) => !_choices.containsKey(conflict['id'])).length;
    return _stack(context, [
      _Heading(_string(widget.payload['title']), widget.payload['description'] as String?),
      for (final conflict in conflicts)
        _FileRow(
          children: [
            Text(
              '${_string(conflict['label'])}${conflict['path'] is String ? '  ·  ${conflict['path']}' : ''}',
              style: ts(context, 14, weight: FontWeight.w600),
            ),
            for (final side in const ['ours', 'theirs'])
              Padding(
                padding: EdgeInsets.only(top: t.s(2)),
                child: _OptionRow(
                  label: side == 'ours' ? 'Ours' : 'Theirs',
                  mark: _choices[conflict['id']] == side ? '◉' : '○',
                  checked: _choices[conflict['id']] == side,
                  enabled: widget.answerable,
                  onTap: () => setState(() => _choices[_string(conflict['id'])] = side),
                  children: [
                    Text(side == 'ours' ? 'Ours' : 'Theirs', style: _dim(context)),
                    SelectableText(_string(conflict[side]), style: _mono(context).copyWith(height: 17 / 12)),
                  ],
                ),
              ),
          ],
        ),
      _ActionBar(
        gadget: widget.gadget,
        answerable: widget.answerable,
        onAnswer: widget.onAnswer,
        blockedReason: unresolved > 0 ? '$unresolved still to choose — Praxis never picks a side for you.' : null,
        valueFor: (_) => unresolved > 0
            ? null
            : {
                'kind': 'form',
                'fields': {..._choices},
              },
      ),
    ]);
  }
}
