import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/session_options.dart';
import '../core/workflow_runs.dart';
import '../ui/approval_panel.dart';
import '../ui/kit.dart';

/// A run's steps and how each stands; picking one shows its conversation.
/// Port of `screens/WorkflowStepsSheet.tsx`.
class WorkflowStepsSheet extends StatefulWidget {
  const WorkflowStepsSheet({super.key, required this.runId, required this.viewedNodeId, required this.onSelectStage});
  final String runId;
  final String? viewedNodeId;
  final ValueChanged<String> onSelectStage;

  static Future<void> show(BuildContext context, {required String runId, required String? viewedNodeId, required ValueChanged<String> onSelectStage}) =>
      showPraxisSheet<void>(
        context,
        builder: (_) => WorkflowStepsSheet(runId: runId, viewedNodeId: viewedNodeId, onSelectStage: onSelectStage),
      );

  @override
  State<WorkflowStepsSheet> createState() => _WorkflowStepsSheetState();
}

class _WorkflowStepsSheetState extends State<WorkflowStepsSheet> {
  String? _busy;
  String? _error;

  void _act(String key, Future<void> Function() action) {
    setState(() {
      _busy = key;
      _error = null;
    });
    action()
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
    final run = store.workflowRuns.where((candidate) => candidate.runId == widget.runId).firstOrNull;
    if (run == null) return const SizedBox.shrink();
    final t = context.t;
    final p = t.palette;
    final status = runStatus(run);
    bool canCommand(String operation) => store.connection == ShellConnection.ready && (store.hostInfo?.commandOperations.contains(operation) ?? false);
    final stages = run.stages;

    return SheetFrame(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      run.workflowName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, 16, weight: FontWeight.w700),
                    ),
                    SizedBox(height: t.s(6)),
                    Row(
                      children: [
                        StatusPill(label: status.label, tone: status.tone),
                        if (run.issueKey != null) ...[SizedBox(width: t.s(8)), Text(run.issueKey!, style: ts(context, 11, color: p.textDim))],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              SquareIconButton(label: 'Close workflow steps', glyph: '×', onTap: () => Navigator.of(context).pop()),
            ],
          ),
          Padding(
            padding: EdgeInsets.only(top: t.s(10), bottom: t.s(8)),
            child: Text(run.explanation, style: ts(context, 12, lineHeight: 17, color: p.textSecondary)),
          ),
          if (_error != null)
            Padding(
              padding: EdgeInsets.only(bottom: t.s(8)),
              child: Text(_error!, style: ts(context, 12, lineHeight: 17, color: p.danger)),
            ),
          if (run.canApprove && canCommand('workflowGates.approve'))
            Padding(
              padding: EdgeInsets.only(bottom: t.s(8)),
              child: ApprovalPanel(runId: run.runId, run: run),
            ),
          Flexible(
            child: ListView.builder(
              shrinkWrap: true,
              padding: const EdgeInsets.only(bottom: 8),
              itemCount: stages.length,
              itemBuilder: (context, index) {
                final stage = stages[index];
                final stageState = stageStatus(stage);
                final viewed = stage.nodeId == widget.viewedNodeId;
                // A finished run has no "now"; a failed or waiting one points at where it stopped.
                final current = stage.nodeId == run.currentNodeId && run.status != 'succeeded' && run.status != 'cancelled';
                final provider = stage.type == 'agent-task' && stage.provider != null
                    ? providerOption(store.providers.value, stage.provider)?.label ?? stage.provider
                    : null;
                final caption = [stageState.label, ?provider, if (stage.attempts > 1) '${stage.attempts} attempts'].join(' · ');
                final retryable = (stage.lane == 'failed' || stage.lane == 'paused') && canCommand('workflowRuns.retryStage');
                final tone = runToneColor(context, stageState.tone);
                return Container(
                  decoration: BoxDecoration(color: viewed ? p.accentSoft : null, borderRadius: BorderRadius.circular(t.s(9))),
                  child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        ExcludeSemantics(
                          child: SizedBox(
                            width: t.s(30),
                            child: Padding(
                              padding: EdgeInsets.only(top: t.s(10)),
                              child: Column(
                                children: [
                                  Container(
                                    width: t.s(22),
                                    height: t.s(22),
                                    alignment: Alignment.center,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: stage.lane == 'done' ? p.ok : p.bgSunken,
                                      border: Border.all(color: tone, width: 1.5),
                                    ),
                                    child: Text(
                                      stageState.icon,
                                      style: ts(context, 10, weight: FontWeight.w800, color: stage.lane == 'done' ? p.onAccent : tone),
                                    ),
                                  ),
                                  if (index < stages.length - 1)
                                    Expanded(
                                      child: Container(width: 1.5, margin: const EdgeInsets.only(top: 2), color: p.border),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        SizedBox(width: t.s(8)),
                        Expanded(
                          child: Pressable(
                            label: 'Step ${index + 1}: ${stage.name}, $caption${current ? ', current step' : ''}',
                            hint: "Shows this step's conversation",
                            selected: viewed,
                            onTap: () {
                              widget.onSelectStage(stage.nodeId);
                              Navigator.of(context).pop();
                            },
                            excludeChildSemantics: true,
                            builder: (context, pressed) => Container(
                              constraints: BoxConstraints(minHeight: t.s(52)),
                              padding: EdgeInsets.only(top: t.s(9), bottom: t.s(9), right: t.s(6)),
                              decoration: BoxDecoration(color: pressed ? p.surfaceRaised : null, borderRadius: BorderRadius.circular(t.s(8))),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Row(
                                    children: [
                                      Flexible(
                                        child: Text(
                                          stage.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: ts(context, 13, weight: FontWeight.w600, color: stage.lane == 'idle' ? p.textSecondary : p.text),
                                        ),
                                      ),
                                      if (current) ...[
                                        SizedBox(width: t.s(6)),
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                          decoration: BoxDecoration(color: p.accent, borderRadius: BorderRadius.circular(4)),
                                          child: Text(
                                            'NOW',
                                            style: ts(context, 9, weight: FontWeight.w800, letterSpacing: 0.6, color: p.onAccent),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                  SizedBox(height: t.s(3)),
                                  Text(
                                    caption,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: ts(context, 11, color: stageState.tone == RunTone.neutral ? p.textDim : tone),
                                  ),
                                  if (stage.metrics != null && stage.metrics!.isNotEmpty) ...[
                                    SizedBox(height: t.s(3)),
                                    Wrap(
                                      spacing: t.s(4),
                                      runSpacing: t.s(4),
                                      children: [
                                        for (final entry in stage.metrics!.entries.take(3))
                                          Container(
                                            padding: EdgeInsets.symmetric(horizontal: t.s(4), vertical: t.s(1)),
                                            decoration: BoxDecoration(color: p.surfaceRaised, borderRadius: BorderRadius.circular(t.s(3))),
                                            child: Text(
                                              '${entry.key}: ${entry.value}',
                                              style: ts(context, 9, color: p.textDim, features: tabular),
                                            ),
                                          ),
                                      ],
                                    ),
                                  ],
                                  if (stage.lastError != null && (stage.lane == 'failed' || stage.lane == 'paused')) ...[
                                    SizedBox(height: t.s(4)),
                                    Text(
                                      stage.lastError!,
                                      maxLines: 3,
                                      overflow: TextOverflow.ellipsis,
                                      style: ts(context, 10, lineHeight: 14, color: p.textDim),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ),
                        if (retryable)
                          Center(
                            child: Pressable(
                              label: 'Retry ${stage.name}',
                              enabled: _busy == null,
                              onTap: () => _act('retry:${stage.nodeId}', () => store.retryStage(run.runId, stage.nodeId)),
                              excludeChildSemantics: true,
                              builder: (context, pressed) => Container(
                                constraints: BoxConstraints(minHeight: t.s(32)),
                                padding: EdgeInsets.symmetric(horizontal: t.s(12)),
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  color: pressed ? p.surfaceRaised : p.surface,
                                  borderRadius: BorderRadius.circular(t.s(8)),
                                  border: Border.all(color: p.accentMuted),
                                ),
                                child: _busy == 'retry:${stage.nodeId}'
                                    ? Spinner(color: p.accent)
                                    : Text(
                                        'Retry',
                                        style: ts(context, 12, weight: FontWeight.w700, color: p.accent),
                                      ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
