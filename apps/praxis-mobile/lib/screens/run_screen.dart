import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/models.dart';
import '../core/session_options.dart';
import '../core/usage.dart';
import '../core/workflow_runs.dart';
import '../ui/approval_panel.dart';
import '../ui/kit.dart';
import '../ui/motif_backdrop.dart';
import '../ui/transcript.dart';
import 'work_screen.dart';
import 'workflow_steps_sheet.dart';

/// A workflow run the way the desktop's run workspace shows it: the
/// conversation of the stage doing the work, the AI running it above, and the
/// stage bar that opens the run's steps. Port of `screens/RunScreen.tsx`.
class RunDetail extends StatefulWidget {
  const RunDetail({super.key, required this.runId, required this.onOpenSidebar});
  final String runId;
  final VoidCallback onOpenSidebar;

  @override
  State<RunDetail> createState() => _RunDetailState();
}

class _RunDetailState extends State<RunDetail> {
  String? _pinned;
  String? _requested;

  /// The usage line already names the model; the strip shows it once, beside the AI.
  String _usageWithoutModel(String summary, String? model) => model != null && summary.startsWith('$model · ') ? summary.substring(model.length + 3) : summary;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final run = store.workflowRuns.where((candidate) => candidate.runId == widget.runId).firstOrNull;
    final stage = run != null ? viewedStage(run, _pinned) : null;
    if (run == null || stage == null) return const SizedBox.shrink();
    final live = currentStage(run);
    final following = _pinned == null || _pinned == live?.nodeId;
    final sessionId = stage.sessionId;
    final session = sessionId != null ? store.sessionFor(sessionId) : null;
    final messages = sessionId != null ? store.transcriptFor(sessionId) : const <TranscriptMessage>[];

    // A stage session the phone has not seen yet (it started while the list was loading).
    if (sessionId != null && session == null && store.connection == ShellConnection.ready && _requested != sessionId) {
      _requested = sessionId;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => store.loadSession(sessionId).catchError((Object error) => Diagnostics.instance.record('Loading a stage conversation', error)),
      );
    }

    final t = context.t;
    final p = t.palette;
    final status = stageStatus(stage);
    final providerId = stage.provider ?? session?.provider ?? run.aiProvider;
    final providerLabel = providerId != null ? providerOption(store.providers.value, providerId)?.label ?? providerId : null;
    final model = session?.model ?? (providerId != null && providerId == run.aiProvider ? run.aiModel : null);
    final workItem = sessionId != null ? store.work.where((item) => item.sessionId == sessionId).firstOrNull : null;
    final usage = workItem != null ? store.usageFor(workItem) : null;
    final aiStage = stage.type == 'agent-task';
    final meta = [
      if (stage.attempts > 1) 'Attempt ${stage.attempts}',
      if (usage?.state == UsageState.ready) _usageWithoutModel(usage!.summary, model),
    ].join(' · ');

    final details = Semantics(
      label: '${stage.name}, ${status.label}${providerLabel != null ? ', on $providerLabel' : ''}${model != null ? ', $model' : ''}',
      container: true,
      excludeSemantics: true,
      child: Container(
        padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(7)),
        decoration: BoxDecoration(
          color: p.chrome,
          border: Border(bottom: BorderSide(color: p.border, width: 0.5)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        child: Text(
                          aiStage
                              ? providerLabel ?? 'Run’s AI'
                              : stage.type == 'check'
                              ? 'Desktop check'
                              : stage.type == 'approval'
                              ? 'Approval'
                              : stage.type == 'merge'
                              ? 'Merge'
                              : 'Desktop',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, 12, weight: FontWeight.w700),
                        ),
                      ),
                      if (aiStage) ...[
                        SizedBox(width: t.s(8)),
                        Expanded(
                          child: Text(
                            model ?? 'default model',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ts(context, 11, color: p.textDim),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                SizedBox(width: t.s(8)),
                StatusPill(label: status.label, tone: status.tone),
              ],
            ),
            if (meta.isNotEmpty) ...[
              SizedBox(height: t.s(3)),
              Text(
                meta,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ts(context, 10, color: p.textDim, features: tabular),
              ),
            ],
          ],
        ),
      ),
    );

    Widget content;
    if (sessionId != null && messages.isNotEmpty) {
      content = Transcript<TranscriptMessage>(
        data: messages,
        keyOf: (message) => message.id,
        resetKey: '${widget.runId}:${stage.nodeId}',
        itemBuilder: (context, message) => ChatMessage(
          message: message.withMeta(
            model: message.author == 'assistant' ? model : null,
            tokens: message.author == 'assistant' ? session?.tokenUsage : null,
            cost: message.author == 'assistant' ? session?.cost : null,
          ),
          connected: store.connection == ShellConnection.ready,
          onAnswer: (gadget, action, value) => store.answerGadget(sessionId, gadget, action, value),
        ),
      );
    } else {
      content = ListView(padding: EdgeInsets.fromLTRB(t.s(12), t.s(14), t.s(12), t.s(16)), children: _summary(context, store, run, stage, status));
    }

    return Stack(
      children: [
        const MotifBackdrop(),
        Column(
          children: [
            SessionHeader(title: run.workflowName, onOpenSidebar: widget.onOpenSidebar),
            details,
            Expanded(child: content),
            Container(
              padding: EdgeInsets.fromLTRB(t.s(10), t.s(7), t.s(10), t.s(9)),
              decoration: BoxDecoration(
                color: p.chrome,
                border: Border(top: BorderSide(color: p.border, width: 0.5)),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (!following) ...[
                    Center(
                      child: Pressable(
                        label: 'Viewing an earlier step · Follow live${live != null ? ' (${live.name})' : ''}',
                        onTap: () => setState(() => _pinned = null),
                        excludeChildSemantics: true,
                        builder: (context, pressed) => Container(
                          padding: EdgeInsets.symmetric(horizontal: t.s(12), vertical: t.s(5)),
                          decoration: BoxDecoration(
                            color: pressed ? p.surfaceRaised : p.accentSoft,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: p.accentMuted),
                          ),
                          child: Text(
                            'Viewing an earlier step · Follow live${live != null ? ' (${live.name})' : ''}',
                            style: ts(context, 11, weight: FontWeight.w700, color: p.accent),
                          ),
                        ),
                      ),
                    ),
                    SizedBox(height: t.s(6)),
                  ],
                  Pressable(
                    label: '${stepPosition(run, stage.nodeId)}: ${stage.name}, ${status.label}. Show the workflow steps.',
                    onTap: () => WorkflowStepsSheet.show(
                      context,
                      runId: run.runId,
                      viewedNodeId: stage.nodeId,
                      onSelectStage: (nodeId) {
                        setState(() => _pinned = nodeId == live?.nodeId ? null : nodeId);
                      },
                    ),
                    excludeChildSemantics: true,
                    builder: (context, pressed) => Container(
                      constraints: BoxConstraints(minHeight: t.s(52)),
                      padding: EdgeInsets.symmetric(horizontal: t.s(10)),
                      decoration: BoxDecoration(
                        color: pressed ? p.surfaceRaised : p.surface,
                        borderRadius: BorderRadius.circular(t.s(10)),
                        border: Border.all(color: p.border),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: t.s(30),
                            height: t.s(30),
                            alignment: Alignment.center,
                            decoration: BoxDecoration(color: runToneBackground(context, status.tone), shape: BoxShape.circle),
                            child: stage.lane == 'running'
                                ? Spinner(color: p.onAccent)
                                : Text(
                                    status.icon,
                                    style: ts(context, 13, weight: FontWeight.w800, color: p.onAccent),
                                  ),
                          ),
                          SizedBox(width: t.s(10)),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  stage.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ts(context, 14, weight: FontWeight.w700),
                                ),
                                SizedBox(height: t.s(2)),
                                Text(
                                  '${stepPosition(run, stage.nodeId)} · Run ${runStatus(run).label.toLowerCase()}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ts(context, 11, color: p.textDim),
                                ),
                              ],
                            ),
                          ),
                          SizedBox(width: t.s(10)),
                          _Progress(run: run),
                          SizedBox(width: t.s(10)),
                          Text(
                            '⌃',
                            style: ts(context, 15, weight: FontWeight.w700, color: p.textDim),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  List<Widget> _summary(BuildContext context, AppStore store, RunSnapshot run, RunStage stage, RunStatusView status) {
    final t = context.t;
    final p = t.palette;
    Widget card(List<Widget> children, {Color? border}) => Container(
      padding: EdgeInsets.all(t.s(14)),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(t.s(10)),
        border: Border.all(color: border ?? p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < children.length; i += 1) ...[if (i > 0) SizedBox(height: t.s(8)), children[i]],
        ],
      ),
    );
    final cards = <Widget>[
      card([
        Row(
          children: [
            Expanded(
              child: Text(stage.name, style: ts(context, 15, weight: FontWeight.w700)),
            ),
            SizedBox(width: t.s(8)),
            StatusPill(label: status.label, tone: status.tone),
          ],
        ),
        Text(
          '${stage.type.toUpperCase()}${stage.gate != null ? ' · ${stage.gate} gate' : ''}',
          style: ts(context, 11, weight: FontWeight.w600, letterSpacing: 0.5, color: p.textDim),
        ),
        if (stage.attempts > 1) Text('Attempt ${stage.attempts}', style: ts(context, 11, color: p.textDim)),
        if (stage.sessionId != null && stage.lane == 'running')
          Padding(
            padding: EdgeInsets.only(top: t.s(4)),
            child: Row(
              children: [
                const Spinner(),
                SizedBox(width: t.s(8)),
                Text('Starting conversation…', style: ts(context, 13, lineHeight: 19, color: p.textDim)),
              ],
            ),
          ),
      ]),
      if (stage.command != null)
        card([
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Command', style: ts(context, 12, weight: FontWeight.w700)),
              if (stage.exitCode != null)
                Container(
                  padding: EdgeInsets.symmetric(horizontal: t.s(6), vertical: t.s(2)),
                  decoration: BoxDecoration(color: p.surfaceRaised, borderRadius: BorderRadius.circular(t.s(4))),
                  child: Text(
                    'exit ${stage.exitCode}',
                    style: ts(context, 10, weight: FontWeight.w700, color: stage.exitCode == 0 ? p.ok : p.danger),
                  ),
                ),
            ],
          ),
          Container(
            padding: EdgeInsets.all(t.s(8)),
            decoration: BoxDecoration(color: p.surfaceRaised, borderRadius: BorderRadius.circular(t.s(6))),
            child: Text('\$ ${stage.command}', style: ts(context, 11, family: monospace)),
          ),
        ]),
      if (stage.metrics != null && stage.metrics!.isNotEmpty)
        card([
          Text('Test Results & Findings Metrics', style: ts(context, 12, weight: FontWeight.w700)),
          Wrap(
            spacing: t.s(8),
            runSpacing: t.s(8),
            children: [
              for (final entry in stage.metrics!.entries)
                Container(
                  padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: t.s(6)),
                  decoration: BoxDecoration(color: p.surfaceRaised, borderRadius: BorderRadius.circular(t.s(6))),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(entry.key.toUpperCase(), style: ts(context, 9, color: p.textDim)),
                      SizedBox(height: t.s(2)),
                      Text('${entry.value}', style: ts(context, 13, weight: FontWeight.w700)),
                    ],
                  ),
                ),
            ],
          ),
        ]),
      if (stage.lastError != null)
        card([
          Text(
            'Error',
            style: ts(context, 12, weight: FontWeight.w700, color: p.danger),
          ),
          Text(
            stage.lastError!,
            textAlign: TextAlign.center,
            style: ts(context, 11, lineHeight: 16, color: p.warn),
          ),
        ], border: p.danger),
      if (stage.type == 'approval' || stage.type == 'merge')
        card([
          if (run.canApprove && stage.lane == 'awaiting' && store.canCommand('workflowGates.approve'))
            ApprovalPanel(runId: run.runId, run: run)
          else
            Text(
              stage.prompt ?? (stage.type == 'merge' ? 'Merge the changes into the base branch?' : 'Sign off on delivery?'),
              style: ts(context, 13, lineHeight: 18),
            ),
        ]),
      if (stage.command == null && stage.metrics == null && stage.lastError == null && stage.type != 'approval' && stage.type != 'merge')
        Text(
          stageWithoutSession(stage),
          textAlign: TextAlign.center,
          style: ts(context, 13, lineHeight: 19, color: p.textDim),
        ),
    ];
    return [
      for (var i = 0; i < cards.length; i += 1) ...[if (i > 0) SizedBox(height: t.s(10)), cards[i]],
    ];
  }
}

/// Done steps out of all of them, as a thin bar.
class _Progress extends StatelessWidget {
  const _Progress({required this.run});
  final RunSnapshot run;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final stages = run.stages;
    final done = stages.where((stage) => stage.lane == 'done' || stage.lane == 'skipped').length;
    final total = stages.isEmpty ? 1 : stages.length;
    return ExcludeSemantics(
      child: SizedBox(
        width: t.s(52),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '$done/${stages.length}',
              style: ts(context, 10, color: t.palette.textDim, features: tabular),
            ),
            SizedBox(height: t.s(3)),
            ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: Container(
                height: t.s(4),
                color: t.palette.border,
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: done / total,
                  heightFactor: 1,
                  child: ColoredBox(color: t.palette.accent),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
