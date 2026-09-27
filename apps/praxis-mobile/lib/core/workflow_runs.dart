import 'models.dart';

// Workflow runs on the phone: the sidebar list, the run view's stage bar and
// its steps sheet. Port of `renderer/mobileWorkflowRuns.ts`.

/// Keeps the newer of two snapshots of the same run; newest run first.
List<RunSnapshot> mergeRun(List<RunSnapshot> runs, RunSnapshot run) {
  final index = runs.indexWhere((candidate) => candidate.runId == run.runId);
  if (index >= 0 && runs[index].sequence > run.sequence) return [...runs];
  final next = index >= 0 ? [for (var i = 0; i < runs.length; i += 1) i == index ? run : runs[i]] : [...runs, run];
  next.sort((left, right) => right.startedAt.compareTo(left.startedAt));
  return next;
}

List<RunSnapshot> removeRun(List<RunSnapshot> runs, String runId) => runs.where((run) => run.runId != runId).toList();

/// Replaces the list with a fresh read, keeping any run whose live event is newer than the read.
List<RunSnapshot> replaceRuns(List<RunSnapshot> previous, List<RunSnapshot> read) {
  var list = <RunSnapshot>[];
  for (final run in read) {
    RunSnapshot? live;
    for (final candidate in previous) {
      if (candidate.runId == run.runId) live = candidate;
    }
    list = mergeRun(list, live != null && live.sequence > run.sequence ? live : run);
  }
  return list;
}

/// Session keys that belong to a run's stages — reached through their run, not as loose chats.
Set<String> runStageSessionKeys(List<RunSnapshot> runs) => {
  for (final run in runs)
    for (final stage in run.stages)
      if (stage.sessionKey != null) stage.sessionKey!,
};

/// A stage session key looks like `WF-<run8>-<node>` even before the run list arrives.
bool isStageSessionKey(String sessionKey, String? runId) =>
    runId != null && runId.isNotEmpty && sessionKey.toUpperCase().startsWith('WF-${runId.substring(0, runId.length < 8 ? runId.length : 8).toUpperCase()}-');

RunStage? currentStage(RunSnapshot run) {
  final stages = run.stages;
  for (final stage in stages) {
    if (stage.nodeId == run.currentNodeId) return stage;
  }
  return stages.isEmpty ? null : stages.first;
}

RunStage? viewedStage(RunSnapshot run, String? pinnedNodeId) {
  if (pinnedNodeId != null) {
    for (final stage in run.stages) {
      if (stage.nodeId == pinnedNodeId) return stage;
    }
  }
  return currentStage(run);
}

String stepPosition(RunSnapshot run, String? nodeId) {
  final stages = run.stages;
  final index = stages.indexWhere((stage) => stage.nodeId == nodeId);
  return index < 0 ? '${stages.length} steps' : 'Step ${index + 1} of ${stages.length}';
}

enum RunTone { ok, warn, danger, neutral, live }

class RunStatusView {
  const RunStatusView(this.label, this.icon, this.tone);
  final String label;
  final String icon;
  final RunTone tone;
}

const _lanes = {
  'idle': RunStatusView('Waiting', '○', RunTone.neutral),
  'ready': RunStatusView('Ready', '○', RunTone.neutral),
  'running': RunStatusView('Running', '●', RunTone.live),
  'done': RunStatusView('Done', '✓', RunTone.ok),
  'failed': RunStatusView('Failed', '✕', RunTone.danger),
  'skipped': RunStatusView('Skipped', '–', RunTone.neutral),
  'awaiting': RunStatusView('Needs you', '!', RunTone.warn),
  'paused': RunStatusView('Paused', 'Ⅱ', RunTone.warn),
};

RunStatusView stageStatus(RunStage stage) {
  final lane = _lanes[stage.lane] ?? _lanes['idle']!;
  if (stage.lane == 'paused' && stage.pause == 'provider-limit') return RunStatusView('Paused · AI out of budget', lane.icon, lane.tone);
  if (stage.lane == 'paused' && stage.pause == 'environment') return RunStatusView('Paused · tooling could not run', lane.icon, lane.tone);
  return lane;
}

RunStatusView runStatus(RunSnapshot run) {
  if (run.paused) return const RunStatusView('Paused', 'Ⅱ', RunTone.warn);
  return switch (run.status) {
    'running' => const RunStatusView('Running', '●', RunTone.live),
    'awaiting-approval' => const RunStatusView('Needs approval', '!', RunTone.warn),
    'succeeded' => const RunStatusView('Succeeded', '✓', RunTone.ok),
    'failed' => const RunStatusView('Failed', '✕', RunTone.danger),
    'cancelled' => const RunStatusView('Cancelled', '–', RunTone.neutral),
    _ => RunStatusView(run.status, '○', RunTone.neutral),
  };
}

/// The sidebar caption: how the run stands and the stage it is at.
String runCaption(RunSnapshot run) {
  final status = runStatus(run).label;
  final stage = currentStage(run);
  final settled = run.status == 'succeeded' || run.status == 'cancelled';
  return stage != null && !settled ? '$status · ${stage.name}' : status;
}

/// Why a stage has no conversation to show.
String stageWithoutSession(RunStage stage) {
  if (stage.lane == 'idle' || stage.lane == 'ready') return '${stage.name} has not started yet.';
  if (stage.lane == 'skipped') return '${stage.name} was skipped.';
  return switch (stage.type) {
    'check' => '${stage.name} is a check — it runs a command on the desktop, with no AI conversation.',
    'approval' =>
      stage.lane == 'awaiting'
          ? '${stage.name} is waiting for a person to approve the run.'
          : "${stage.name} is an approval gate — a person's decision, with no AI conversation.",
    'join' => '${stage.name} waits for the parallel steps before it to finish.',
    'deployment' => '${stage.name} deploys on the desktop, with no AI conversation.',
    'merge' => '${stage.name} is a merge step — merges changes into the target branch.',
    _ => '${stage.name} has no conversation yet.',
  };
}

class ApprovalContext {
  const ApprovalContext({required this.stageName, this.prompt, this.gate, required this.explanation, required this.steps, required this.findings});
  final String stageName;
  final String? prompt;
  final String? gate;
  final String explanation;
  final List<({String name, String label, RunTone tone, String? detail})> steps;
  final List<({String severity, int count})> findings;
}

/// What a person needs in front of them to approve a run from a phone.
ApprovalContext? approvalContext(RunSnapshot run) {
  final stages = run.stages;
  final index = stages.indexWhere((stage) => stage.lane == 'awaiting');
  if (index < 0) return null;
  final approval = stages[index];
  final before = stages.sublist(0, index).where((stage) => stage.type != 'join').toList();
  final totals = <String, int>{};
  for (final stage in before) {
    stage.findingsSummary.forEach((severity, count) {
      if (count > 0) totals[severity] = (totals[severity] ?? 0) + count;
    });
  }
  final findings = totals.entries.map((entry) => (severity: entry.key, count: entry.value)).toList()..sort((left, right) => right.count.compareTo(left.count));
  return ApprovalContext(
    stageName: approval.name,
    prompt: approval.prompt,
    gate: approval.gate,
    explanation: run.explanation,
    steps: before.map((stage) {
      final status = stageStatus(stage);
      final detail =
          stage.lastError ??
          (stage.exitCode != null && stage.exitCode != 0 ? 'exit ${stage.exitCode}' : null) ??
          (stage.attempts > 1 ? '${stage.attempts} attempts' : null);
      return (name: stage.name, label: status.label, tone: status.tone, detail: detail);
    }).toList(),
    findings: findings,
  );
}
