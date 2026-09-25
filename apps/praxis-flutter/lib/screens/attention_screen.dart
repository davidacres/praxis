import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/attention.dart';
import '../ui/approval_panel.dart';
import '../ui/kit.dart';

/// What needs the person: approvals, failed steps and agent permissions.
/// Port of `screens/AttentionScreen.tsx`.
class AttentionScreen extends StatefulWidget {
  const AttentionScreen({super.key, required this.onOpenSidebar});
  final VoidCallback onOpenSidebar;

  @override
  State<AttentionScreen> createState() => _AttentionScreenState();
}

class _AttentionScreenState extends State<AttentionScreen> {
  String? _failure;

  void _act(Future<Object?> action) {
    setState(() => _failure = null);
    action.catchError((Object error) {
      if (mounted) setState(() => _failure = Diagnostics.messageOf(error));
      return null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    final t = context.t;
    final items = store.openAttention;
    final runNames = <String, String>{
      for (final entry in store.runs.entries) entry.key: entry.value.workflowName,
      for (final run in store.workflowRuns) run.runId: run.workflowName,
    };
    final work = store.work.map((item) => (sessionId: item.sessionId, runId: item.runId, title: item.title)).toList();

    return Column(
      children: [
        AppHeader(title: 'Attention', onOpenSidebar: widget.onOpenSidebar),
        Expanded(
          child: ScreenScroll(
            children: [
              if (_failure != null) PraxisCard(children: [Body(_failure!)]),
              if (items.isEmpty) const PraxisCard(children: [Body('Nothing needs you right now.', dim: true)]),
              for (final item in items)
                Builder(
                  builder: (context) {
                    final run = item.runId != null ? store.workflowRuns.where((candidate) => candidate.runId == item.runId).firstOrNull : null;
                    final stage = run != null && item.kind == 'failure'
                        ? run.stages.where((candidate) => item.id.endsWith(':${candidate.nodeId}')).firstOrNull
                        : null;
                    return PraxisCard(
                      children: [
                        Row(
                          children: [
                            Pill(item.kind, tone: item.kind == 'failure' ? Tone.danger : Tone.warn),
                            SizedBox(width: t.s(8)),
                            Expanded(child: Body(attentionSubject(item, work, runNames), dim: true)),
                          ],
                        ),
                        Body(
                          item.kind == 'approval'
                              ? run?.explanation ?? 'A run is waiting for your approval.'
                              : item.kind == 'permission'
                              ? item.summary ?? 'The agent is asking permission to act.'
                              : stage?.lastError ?? 'A stage failed and can be retried.',
                        ),
                        if (item.kind == 'permission' && item.detail != null) Body(item.detail!, dim: true),
                        if (item.kind == 'approval' && item.runId != null) ...[
                          ApprovalPanel(runId: item.runId!, run: run),
                          if (store.runsSupported && run != null) PraxisButton(label: 'Open run', ghost: true, onPressed: () => store.openRun(item.runId)),
                        ],
                        if (item.kind == 'failure' && item.runId != null)
                          Wrap(
                            spacing: t.s(8),
                            runSpacing: t.s(8),
                            children: [
                              if (store.runsSupported && run != null)
                                PraxisButton(label: 'Open run', ghost: true, expand: false, onPressed: () => store.openRun(item.runId)),
                              if (stage != null && store.canCommand('workflowRuns.retryStage'))
                                PraxisButton(label: 'Retry step', expand: false, onPressed: () => _act(store.retryStage(item.runId!, stage.nodeId))),
                            ],
                          ),
                        if (item.kind == 'permission' && item.requestId != null)
                          Wrap(
                            spacing: t.s(8),
                            runSpacing: t.s(8),
                            children: [
                              PraxisButton(
                                label: 'Deny',
                                ghost: true,
                                expand: false,
                                onPressed: () => _act(store.respondToPermission(item.requestId!, 'deny')),
                              ),
                              PraxisButton(label: 'Allow once', expand: false, onPressed: () => _act(store.respondToPermission(item.requestId!, 'allow'))),
                            ],
                          ),
                      ],
                    );
                  },
                ),
            ],
          ),
        ),
      ],
    );
  }
}
