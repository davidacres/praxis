import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app/store.dart';
import '../core/workflow_runs.dart';
import '../ui/kit.dart';

class RunsScreen extends StatelessWidget {
  const RunsScreen({super.key, required this.onOpenSidebar});
  final VoidCallback onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AppStore>();
    return Column(
      children: [
        AppHeader(title: 'Runs', onOpenSidebar: onOpenSidebar),
        Expanded(
          child: ScreenScroll(
            children: [
              if (!store.runsSupported)
                const PraxisCard(
                  children: [
                    Body(
                      'Runs are not available from this desktop.',
                      dim: true,
                    ),
                  ],
                )
              else if (store.workflowRuns.isEmpty)
                const PraxisCard(
                  children: [
                    Body('No workflow runs in this project yet.', dim: true),
                  ],
                )
              else
                for (final run in store.workflowRuns)
                  Pressable(
                    label: '${run.workflowName}, ${runStatus(run).label}',
                    hint: 'Opens run details',
                    onTap: () => store.openRun(run.runId),
                    excludeChildSemantics: true,
                    builder: (context, _) => PraxisCard(
                      children: [
                        Text(
                          run.workflowName,
                          style: ts(context, 15, weight: FontWeight.w700),
                        ),
                        Body(runStatus(run).label, dim: true),
                        if (run.explanation.isNotEmpty)
                          Body(run.explanation, dim: true),
                      ],
                    ),
                  ),
            ],
          ),
        ),
      ],
    );
  }
}
