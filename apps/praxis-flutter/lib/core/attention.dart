import 'models.dart';

// The phone's attention list. Port of `renderer/mobileAttention.ts`.

List<AttentionItem> openMobileAttention(List<AttentionItem> items, {required String hostId, required String projectId}) =>
    items.where((item) => !item.resolved && item.hostId == hostId && item.projectId == projectId).toList();

/// What an attention item is about, by name — a run's workflow or a session's title — never a raw id.
String attentionSubject(AttentionItem item, List<({String sessionId, String? runId, String title})> work, Map<String, String> runNames) {
  if (item.runId != null) {
    final named = item.kind == 'permission' ? null : item.summary;
    final fromRun = runNames[item.runId];
    if (fromRun != null && fromRun.isNotEmpty) return fromRun;
    if (named != null && named.isNotEmpty) return named;
    for (final entry in work) {
      if (entry.runId == item.runId && entry.title.isNotEmpty) return entry.title;
    }
    return 'A workflow run';
  }
  if (item.sessionId != null) {
    for (final entry in work) {
      if (entry.sessionId == item.sessionId && entry.title.isNotEmpty) return entry.title;
    }
    return 'A session';
  }
  return item.kind == 'approval' ? 'A workflow run' : 'A session';
}

/// Approval and failure items straight from the runs the phone follows live.
List<AttentionItem> runAttentionItems(String hostId, String projectId, List<RunSnapshot> runs) {
  final items = <AttentionItem>[];
  for (final run in runs) {
    if (run.projectId != projectId) continue;
    if (run.status == 'awaiting-approval') {
      items.add(
        AttentionItem(
          id: 'approval:${run.runId}',
          kind: 'approval',
          hostId: hostId,
          projectId: projectId,
          runId: run.runId,
          summary: run.workflowName,
          createdAt: run.startedAt,
        ),
      );
    }
    for (final stage in run.stages) {
      if (stage.lane == 'failed') {
        items.add(
          AttentionItem(
            id: 'failure:${run.runId}:${stage.nodeId}',
            kind: 'failure',
            hostId: hostId,
            projectId: projectId,
            runId: run.runId,
            summary: '${run.workflowName} — ${stage.name}',
            createdAt: run.startedAt,
          ),
        );
      }
    }
  }
  return items;
}

/// Live permissions and run items, plus what only the polled list knows. Acted-on items stay hidden.
List<AttentionItem> combineAttention({
  required List<AttentionItem> polled,
  required List<AttentionItem> permissions,
  required List<AttentionItem>? fromRuns,
  required Set<String> resolvedIds,
}) {
  final live = [...permissions, ...?fromRuns];
  final covered = {
    'permission',
    if (fromRuns != null) ...['approval', 'failure'],
  };
  final liveIds = live.map((item) => item.id).toSet();
  final extra = polled.where((item) => !covered.contains(item.kind) && !liveIds.contains(item.id));
  return [...live, ...extra].map((item) => resolvedIds.contains(item.id) ? item.resolve() : item).toList();
}
