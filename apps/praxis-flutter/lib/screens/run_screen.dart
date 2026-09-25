import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app/store/store_provider.dart';
import '../app/store/types.dart';

class RunScreen extends StatefulWidget {
  final String runId;
  final VoidCallback onOpenSidebar;

  const RunScreen({
    Key? key,
    required this.runId,
    required this.onOpenSidebar,
  }) : super(key: key);

  @override
  State<RunScreen> createState() => _RunScreenState();
}

class _RunScreenState extends State<RunScreen> {
  @override
  Widget build(BuildContext context) {
    return Consumer<AppStore>(
      builder: (context, store, _) {
        MobileRunSummary? run;
        try {
          run = store.workflowRuns.firstWhere(
            (r) => r.runId == widget.runId,
          );
        } catch (e) {
          run = null;
        }

        if (run == null) {
          return Scaffold(
            appBar: AppBar(
              title: const Text('Workflow Run'),
              leading: IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => store.openRun(null),
              ),
            ),
            body: const Center(
              child: Text('Run not found'),
            ),
          );
        }

        return Column(
          children: [
            // Header
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                border: Border(
                  bottom: BorderSide(
                    color: Theme.of(context).dividerColor,
                  ),
                ),
              ),
              child: Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.arrow_back),
                    onPressed: () => store.openRun(null),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          run.workflowName,
                          style: Theme.of(context).textTheme.titleLarge,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            _StatusBadge(status: run.status),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                run.explanation,
                                style: Theme.of(context).textTheme.bodySmall,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.menu),
                    onPressed: widget.onOpenSidebar,
                  ),
                ],
              ),
            ),
            // Stages
            Expanded(
              child: run == null
                  ? Center(
                      child: Text(
                        'No workflow run data',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    )
                  : run!.stages.isEmpty
                      ? Center(
                          child: Text(
                            'No stages yet',
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        )
                      : ListView.builder(
                          itemCount: run!.stages.length,
                          itemBuilder: (context, index) {
                            final stage = run!.stages[index];
                        return _StageCard(stage: stage);
                      },
                    ),
            ),
          ],
        );
      },
    );
  }
}

class _StatusBadge extends StatelessWidget {
  final String status;

  const _StatusBadge({
    Key? key,
    required this.status,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    Color backgroundColor;
    Color textColor;

    switch (status.toLowerCase()) {
      case 'success':
      case 'complete':
      case 'done':
        backgroundColor = Colors.green.withAlpha(30);
        textColor = Colors.green;
        break;
      case 'error':
      case 'failed':
      case 'failed':
        backgroundColor = Colors.red.withAlpha(30);
        textColor = Colors.red;
        break;
      case 'running':
      case 'in progress':
        backgroundColor = Colors.blue.withAlpha(30);
        textColor = Colors.blue;
        break;
      default:
        backgroundColor = Colors.grey.withAlpha(30);
        textColor = Colors.grey;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        status,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: textColor,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}

class _StageCard extends StatelessWidget {
  final WorkflowStage stage;

  const _StageCard({
    Key? key,
    required this.stage,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        stage.name,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Lane: ${stage.lane}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.blue.withAlpha(30),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    stage.outcome,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Colors.blue,
                        ),
                  ),
                ),
              ],
            ),
            if (stage.artifacts.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(
                'Artifacts',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const SizedBox(height: 8),
              ...stage.artifacts.map((artifact) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text(
                      '${artifact.kind}${artifact.path != null ? ': ${artifact.path}' : ''}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  )),
            ],
          ],
        ),
      ),
    );
  }
}
