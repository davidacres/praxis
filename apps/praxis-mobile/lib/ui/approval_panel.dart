import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import '../core/workflow_runs.dart';
import 'kit.dart';

/// A run's approval as a decision rather than a tap: the steps it rests on,
/// what they found, what the gate asks — then Approve, or Reject with a
/// recorded reason. Both ask for Face ID first. Port of `app/ApprovalPanel.tsx`.
class ApprovalPanel extends StatefulWidget {
  const ApprovalPanel({super.key, required this.runId, required this.run, this.onDone});
  final String runId;
  final RunSnapshot? run;
  final VoidCallback? onDone;

  @override
  State<ApprovalPanel> createState() => _ApprovalPanelState();
}

class _ApprovalPanelState extends State<ApprovalPanel> {
  String? _busy;
  String? _error;
  bool _rejecting = false;
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  void _act(String key, Future<bool> Function() action) {
    setState(() {
      _busy = key;
      _error = null;
    });
    action()
        .then((done) {
          if (done) widget.onDone?.call();
        })
        .catchError((Object failure) {
          if (mounted) setState(() => _error = Diagnostics.messageOf(failure));
        })
        .whenComplete(() {
          if (mounted) setState(() => _busy = null);
        });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final p = t.palette;
    final run = widget.run;
    final approval = run != null ? approvalContext(run) : null;
    final canApprove = store.canCommand('workflowGates.approve') && (run?.canApprove ?? true);
    final canReject = store.canCommand('workflowGates.reject');
    final gap = SizedBox(height: t.s(8));
    final reasonEmpty = _reason.text.trim().isEmpty;

    Widget button(
      String label, {
      required bool primary,
      bool danger = false,
      required bool disabled,
      required VoidCallback onTap,
      String? busyKey,
      String? hint,
    }) {
      final isThisBusy = busyKey != null && _busy == busyKey;
      return Pressable(
        label: label,
        hint: hint,
        enabled: !disabled && _busy == null,
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
              : Border.all(color: danger ? p.danger : p.border, width: 0.5);

          return Opacity(
            opacity: disabled || (_busy != null && !isThisBusy) ? 0.45 : 1,
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (approval != null) ...[
          Text('${approval.stageName}${approval.gate != null ? ' · ${approval.gate} gate' : ''}', style: ts(context, 13.5, weight: FontWeight.w700)),
          if (approval.prompt != null) ...[gap, Text(approval.prompt!, style: ts(context, 13, lineHeight: 19, color: p.textSecondary))],
          if (approval.steps.isNotEmpty) ...[
            gap,
            Semantics(
              label: 'Steps before this approval: ${approval.steps.map((step) => '${step.name} ${step.label}').join(', ')}',
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(color: p.border),
                  borderRadius: BorderRadius.circular(t.s(8)),
                ),
                child: Column(
                  children: [
                    for (final step in approval.steps)
                      Container(
                        padding: EdgeInsets.symmetric(horizontal: t.s(10), vertical: t.s(6)),
                        decoration: BoxDecoration(
                          border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(step.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ts(context, 12.5)),
                                ),
                                SizedBox(width: t.s(8)),
                                Text(
                                  step.label,
                                  style: ts(context, 12, weight: FontWeight.w700, color: runToneColor(context, step.tone)),
                                ),
                              ],
                            ),
                            if (step.detail != null) SizedBox(height: t.s(8)),
                            if (step.detail != null)
                              Text(
                                step.detail!,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: ts(context, 11.5, color: p.textDim),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
          if (approval.findings.isNotEmpty) ...[
            gap,
            Text(
              'Findings: ${approval.findings.map((entry) => '${entry.count} ${entry.severity}').join(' · ')}',
              style: ts(context, 12.5, weight: FontWeight.w600, color: p.warn),
            ),
          ],
        ] else
          Text('Open the run to see what this approval rests on before you decide.', style: ts(context, 13, lineHeight: 19, color: p.textSecondary)),
        gap,
        if (_rejecting) ...[
          Semantics(
            label: 'Why are you rejecting this run?',
            textField: true,
            child: Container(
              constraints: BoxConstraints(minHeight: t.s(72)),
              padding: EdgeInsets.all(t.s(10)),
              decoration: BoxDecoration(
                color: p.input,
                borderRadius: BorderRadius.circular(t.s(8)),
                border: Border.all(color: p.border),
              ),
              child: CupertinoTextField.borderless(
                textAlignVertical: TextAlignVertical.top,
                controller: _reason,
                autofocus: true,
                maxLines: null,
                maxLength: 2000,
                padding: EdgeInsets.zero,
                placeholder: 'Why? This is recorded on the run.',
                placeholderStyle: ts(context, 14, color: p.textDim),
                style: ts(context, 14),
                cursorColor: p.accent,
                onChanged: (_) => setState(() {}),
              ),
            ),
          ),
          gap,
          Row(
            children: [
              Expanded(
                child: button(
                  'Back',
                  primary: false,
                  disabled: false,
                  onTap: () => setState(() {
                    _rejecting = false;
                    _reason.clear();
                  }),
                ),
              ),
              SizedBox(width: t.s(8)),
              Expanded(
                child: button(
                  'Deny run',
                  primary: false,
                  danger: true,
                  busyKey: 'reject',
                  disabled: reasonEmpty || _busy != null,
                  onTap: () => _act('reject', () => store.reject(widget.runId, _reason.text)),
                ),
              ),
            ],
          ),
        ] else
          Row(
            children: [
              if (canReject) ...[
                Expanded(
                  child: button(
                    'Deny',
                    primary: false,
                    danger: true,
                    disabled: _busy != null,
                    onTap: () => setState(() => _rejecting = true),
                  ),
                ),
                SizedBox(width: t.s(8)),
              ],
              Expanded(
                child: button(
                  'Approve all',
                  primary: false,
                  busyKey: 'approveAll',
                  hint: 'Asks for Face ID or your passcode',
                  disabled: !canApprove || _busy != null,
                  onTap: () => _act('approveAll', () => store.approveAll(widget.runId)),
                ),
              ),
              SizedBox(width: t.s(8)),
              Expanded(
                child: button(
                  'Approve',
                  primary: true,
                  busyKey: 'approve',
                  hint: 'Asks for Face ID or your passcode',
                  disabled: !canApprove || _busy != null,
                  onTap: () => _act('approve', () => store.approve(widget.runId)),
                ),
              ),
            ],
          ),
        if (_error != null) ...[
          gap,
          Semantics(
            liveRegion: true,
            child: Text(_error!, style: ts(context, 13, color: p.danger)),
          ),
        ],
      ],
    );
  }
}
