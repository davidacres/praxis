import type {
  MobileCommandLedger,
  MobileRunEvent,
  MobileRunSnapshot,
  MobileRunStage,
  WorkflowRunSummary,
} from '@praxis/core';

/**
 * A workflow run as the phone shows it — pure, so the listing, the live event and the
 * tests all produce the same shape from the desktop monitor's own summary.
 */

/**
 * The stage the phone puts in place of its composer: where the run *is*.
 *
 * Running work first (an agent stage over a check running beside it, since that is the
 * conversation to watch), then a stage waiting on a person, then one paused on its AI or
 * tooling, then a failure. A run with none of those is between stages or finished: the
 * last stage that did anything, else the first.
 */
export function currentRunStage(stages: readonly Pick<MobileRunStage, 'nodeId' | 'type' | 'lane' | 'attempts'>[]): string | undefined {
  const inLane = (lane: MobileRunStage['lane']) => stages.filter(stage => stage.lane === lane);
  const running = inLane('running');
  const current =
    running.find(stage => stage.type === 'agent-task') ??
    running[0] ??
    inLane('awaiting')[0] ??
    inLane('paused')[0] ??
    inLane('failed')[0] ??
    [...stages].reverse().find(stage => stage.lane === 'done' && stage.attempts > 0) ??
    [...stages].reverse().find(stage => stage.lane === 'done') ??
    stages[0];
  return current?.nodeId;
}

export function mobileRunSnapshot(summary: WorkflowRunSummary, sequence: number): MobileRunSnapshot {
  const stages: MobileRunStage[] = summary.stages.map(stage => {
    const provider = stage.provider ?? stage.chosenProvider;
    return {
      nodeId: stage.nodeId,
      name: stage.name,
      type: stage.type,
      lane: stage.lane,
      attempts: stage.attempts,
      ...(stage.sessionId ? { sessionId: stage.sessionId } : {}),
      ...(stage.sessionKey ? { sessionKey: stage.sessionKey } : {}),
      ...(stage.provider || stage.chosenProvider ? { provider } : {}),
      ...(stage.lastError ? { lastError: stage.lastError } : {}),
      ...(stage.pause ? { pause: stage.pause } : {}),
      ...(stage.command ? { command: stage.command } : {}),
      ...(stage.exitCode !== undefined ? { exitCode: stage.exitCode } : {}),
      ...(stage.gate ? { gate: stage.gate } : {}),
      ...(stage.findings?.metrics && Object.keys(stage.findings.metrics).length > 0
        ? { metrics: stage.findings.metrics }
        : {}),
      ...(stage.findings?.findings && stage.findings.findings.length > 0
        ? {
            findingsSummary: stage.findings.findings.reduce<Record<string, number>>((acc, f) => {
              acc[f.severity] = (acc[f.severity] ?? 0) + 1;
              return acc;
            }, {})
          }
        : {}),
      ...(stage.prompt ? { prompt: stage.prompt } : {}),
    };
  });
  const currentNodeId = currentRunStage(stages);
  return {
    runId: summary.runId,
    projectId: summary.projectId,
    workflowName: summary.workflowName,
    status: summary.status,
    paused: summary.paused === true,
    explanation: summary.explanation,
    startedAt: summary.startedAt,
    ...(summary.endedAt ? { endedAt: summary.endedAt } : {}),
    ...(summary.issueKey ? { issueKey: summary.issueKey } : {}),
    ...(summary.aiProvider ? { aiProvider: summary.aiProvider } : {}),
    ...(summary.aiModel ? { aiModel: summary.aiModel } : {}),
    ...(currentNodeId ? { currentNodeId } : {}),
    stages,
    canApprove: summary.status === 'awaiting-approval',
    sequence,
  };
}

/** Appends a run change to the mobile event log, scoped to the run's project like a session's. */
export function appendMobileRunEvent(
  ledger: Pick<MobileCommandLedger, 'appendEvent' | 'latestSequence'>,
  hostId: string,
  change: { summary: WorkflowRunSummary } | { removed: { runId: string; projectId: string } },
): number {
  const sequence = ledger.latestSequence() + 1;
  const runId = 'summary' in change ? change.summary.runId : change.removed.runId;
  const projectId = 'summary' in change ? change.summary.projectId : change.removed.projectId;
  ledger.appendEvent<MobileRunEvent>({
    protocolVersion: 1,
    eventId: `run:${runId}:${sequence}`,
    sequence,
    emittedAt: new Date().toISOString(),
    target: { hostId, projectId, runId },
    event: 'summary' in change
      ? { type: 'run.snapshot', run: mobileRunSnapshot(change.summary, sequence) }
      : { type: 'run.removed', runId },
  });
  return sequence;
}
