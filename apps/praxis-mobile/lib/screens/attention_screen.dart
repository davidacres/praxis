import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/diagnostics.dart';
import '../app/store.dart';
import '../app/theme.dart';
import '../core/attention.dart';
import '../ui/approval_panel.dart';
import '../ui/kit.dart';
import '../ui/permission_card.dart';

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
                    if (item.kind == 'permission') {
                      return PermissionCard(key: ValueKey(item.id), item: item, subject: attentionSubject(item, work, runNames));
                    }
                    final run = item.runId != null ? store.workflowRuns.where((candidate) => candidate.runId == item.runId).firstOrNull : null;
                    final stage = run != null && item.kind == 'failure'
                        ? run.stages.where((candidate) => item.id.endsWith(':${candidate.nodeId}')).firstOrNull
                        : null;
                    return PraxisCard(
                      borderColor: item.kind == 'failure' ? t.palette.danger : t.palette.warn,
                      children: [
                        Text(
                          attentionTypeTitle(item.kind),
                          style: ts(context, 14, weight: FontWeight.w700, color: item.kind == 'failure' ? t.palette.danger : t.palette.warn),
                        ),
                        Container(height: 1, color: t.palette.border),
                        Row(
                          children: [
                            Expanded(
                              child: Body(attentionSubject(item, work, runNames), dim: true),
                            ),
                            if (store.runsSupported && item.runId != null) ...[
                              SizedBox(width: t.s(8)),
                              Pressable(
                                label: 'Open run',
                                onTap: () => store.openRun(item.runId),
                                builder: (context, pressed) => Opacity(
                                  opacity: pressed ? 0.6 : 1,
                                  child: Container(
                                    padding: EdgeInsets.symmetric(horizontal: t.s(8), vertical: t.s(4)),
                                    decoration: BoxDecoration(
                                      color: t.palette.surfaceRaised,
                                      border: Border.all(color: t.palette.border),
                                      borderRadius: BorderRadius.circular(t.s(6)),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(
                                          'Open run',
                                          style: ts(context, 12, weight: FontWeight.w600, color: t.palette.textSecondary),
                                        ),
                                        SizedBox(width: t.s(3)),
                                        Text(
                                          '›',
                                          style: ts(context, 13, weight: FontWeight.w700, color: t.palette.textDim),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                        Body(
                          item.kind == 'approval'
                              ? run?.explanation ?? 'A run is waiting for your approval.'
                              : stage?.lastError ?? 'A stage failed and can be retried.',
                        ),
                        if (item.kind == 'approval' && item.runId != null)
                          ApprovalPanel(runId: item.runId!, run: run),
                        if (item.kind == 'failure' && item.runId != null)
                          Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              if (stage != null && store.canCommand('workflowRuns.retryStage'))
                                PraxisButton(label: 'Retry step', expand: false, onPressed: () => _act(store.retryStage(item.runId!, stage.nodeId))),
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
