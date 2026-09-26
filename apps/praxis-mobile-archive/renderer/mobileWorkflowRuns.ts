import type { MobileRunSnapshot, MobileRunStage } from '@praxis/core';

/**
 * Workflow runs on the phone: the list in the sidebar, the run view's stage bar and its
 * steps sheet. Pure so the reducers and wording are tested without a device.
 */

/** Keeps the newer of two snapshots of the same run; newest run first. */
export function mergeRun(runs: readonly MobileRunSnapshot[], run: MobileRunSnapshot): MobileRunSnapshot[] {
  const index = runs.findIndex(candidate => candidate.runId === run.runId);
  if (index >= 0 && runs[index]!.sequence > run.sequence) return [...runs];
  const next = index >= 0 ? runs.map((candidate, position) => (position === index ? run : candidate)) : [...runs, run];
  return next.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function removeRun(runs: readonly MobileRunSnapshot[], runId: string): MobileRunSnapshot[] {
  return runs.filter(run => run.runId !== runId);
}

/**
 * Replaces the list with a fresh read, keeping any run whose live event is newer than the
 * read (it arrived while the read was in flight).
 */
export function replaceRuns(previous: readonly MobileRunSnapshot[], read: readonly MobileRunSnapshot[]): MobileRunSnapshot[] {
  return read.reduce<MobileRunSnapshot[]>((list, run) => {
    const live = previous.find(candidate => candidate.runId === run.runId);
    return mergeRun(list, live && live.sequence > run.sequence ? live : run);
  }, []);
}

/**
 * Session keys that belong to a run's stages. The chat list leaves them out — each is
 * reached through its run, as on the desktop, instead of as a loose "chat".
 */
export function runStageSessionKeys(runs: readonly MobileRunSnapshot[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const run of runs) for (const stage of run.stages) if (stage.sessionKey) keys.add(stage.sessionKey);
  return keys;
}

/** A stage session key looks like `WF-<run8>-<node>` even before the run list arrives. */
export function isStageSessionKey(sessionKey: string, runId: string | undefined): boolean {
  return Boolean(runId) && sessionKey.toUpperCase().startsWith(`WF-${runId!.slice(0, 8).toUpperCase()}-`);
}

export function currentStage(run: MobileRunSnapshot): MobileRunStage | undefined {
  return run.stages.find(stage => stage.nodeId === run.currentNodeId) ?? run.stages[0];
}

/**
 * The stage the run view shows: the one a person picked in the steps sheet, else the
 * run's current stage — so the view follows the run as it moves on.
 */
export function viewedStage(run: MobileRunSnapshot, pinnedNodeId: string | undefined): MobileRunStage | undefined {
  return (pinnedNodeId ? run.stages.find(stage => stage.nodeId === pinnedNodeId) : undefined) ?? currentStage(run);
}

/** "Step 2 of 10" — the stage's place in the workflow. */
export function stepPosition(run: MobileRunSnapshot, nodeId: string | undefined): string {
  const index = run.stages.findIndex(stage => stage.nodeId === nodeId);
  return index < 0 ? `${run.stages.length} steps` : `Step ${index + 1} of ${run.stages.length}`;
}

export type RunTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'live';

const LANE: Record<MobileRunStage['lane'], { label: string; icon: string; tone: RunTone }> = {
  idle: { label: 'Waiting', icon: '○', tone: 'neutral' },
  ready: { label: 'Ready', icon: '○', tone: 'neutral' },
  running: { label: 'Running', icon: '●', tone: 'live' },
  done: { label: 'Done', icon: '✓', tone: 'ok' },
  failed: { label: 'Failed', icon: '✕', tone: 'danger' },
  skipped: { label: 'Skipped', icon: '–', tone: 'neutral' },
  awaiting: { label: 'Needs you', icon: '!', tone: 'warn' },
  paused: { label: 'Paused', icon: 'Ⅱ', tone: 'warn' },
};

export function stageStatus(stage: MobileRunStage): { label: string; icon: string; tone: RunTone } {
  const lane = LANE[stage.lane] ?? LANE.idle;
  if (stage.lane === 'paused' && stage.pause === 'provider-limit') return { ...lane, label: 'Paused · AI out of budget' };
  if (stage.lane === 'paused' && stage.pause === 'environment') return { ...lane, label: 'Paused · tooling could not run' };
  return lane;
}

export function runStatus(run: MobileRunSnapshot): { label: string; icon: string; tone: RunTone } {
  if (run.paused) return { label: 'Paused', icon: 'Ⅱ', tone: 'warn' };
  switch (run.status) {
    case 'running': return { label: 'Running', icon: '●', tone: 'live' };
    case 'awaiting-approval': return { label: 'Needs approval', icon: '!', tone: 'warn' };
    case 'succeeded': return { label: 'Succeeded', icon: '✓', tone: 'ok' };
    case 'failed': return { label: 'Failed', icon: '✕', tone: 'danger' };
    case 'cancelled': return { label: 'Cancelled', icon: '–', tone: 'neutral' };
    default: return { label: run.status, icon: '○', tone: 'neutral' };
  }
}

/** The sidebar caption: how the run stands and the stage it is at. */
export function runCaption(run: MobileRunSnapshot): string {
  const status = runStatus(run).label;
  const stage = currentStage(run);
  const settled = run.status === 'succeeded' || run.status === 'cancelled';
  return stage && !settled ? `${status} · ${stage.name}` : status;
}

/** Why a stage has no conversation to show — checks, approvals and joins do not run an AI. */
export function stageWithoutSession(stage: MobileRunStage): string {
  if (stage.lane === 'idle' || stage.lane === 'ready') return `${stage.name} has not started yet.`;
  if (stage.lane === 'skipped') return `${stage.name} was skipped.`;
  switch (stage.type) {
    case 'check': return `${stage.name} is a check — it runs a command on the desktop, with no AI conversation.`;
    case 'approval': return stage.lane === 'awaiting'
      ? `${stage.name} is waiting for a person to approve the run.`
      : `${stage.name} is an approval gate — a person's decision, with no AI conversation.`;
    case 'join': return `${stage.name} waits for the parallel steps before it to finish.`;
    case 'deployment': return `${stage.name} deploys on the desktop, with no AI conversation.`;
    case 'merge': return `${stage.name} is a merge step — merges changes into the target branch.`;
    default: return `${stage.name} has no conversation yet.`;
  }
}

export interface ApprovalContext {
  /** The approval step waiting on a person. */
  stageName: string;
  /** What the workflow asks the approver to check, when it says. */
  prompt?: string;
  gate?: string;
  /** One sentence from the desktop: why the run is where it is. */
  explanation: string;
  /** Every step before the approval, with how it ended — the evidence the decision rests on. */
  steps: Array<{ name: string; label: string; tone: RunTone; detail?: string }>;
  /** Findings across those steps, by severity, highest counts first. */
  findings: Array<{ severity: string; count: number }>;
}

/**
 * What a person needs in front of them to approve a run from a phone: the
 * steps that ran and how they ended, what they found, and what the gate asks —
 * so an approval is a decision, not a tap.
 */
export function approvalContext(run: MobileRunSnapshot): ApprovalContext | undefined {
  const index = run.stages.findIndex(stage => stage.lane === 'awaiting');
  const approval = index >= 0 ? run.stages[index]! : undefined;
  if (!approval) return undefined;
  const before = run.stages.slice(0, index).filter(stage => stage.type !== 'join');
  const totals = new Map<string, number>();
  for (const stage of before) {
    for (const [severity, count] of Object.entries(stage.findingsSummary ?? {})) {
      if (count > 0) totals.set(severity, (totals.get(severity) ?? 0) + count);
    }
  }
  return {
    stageName: approval.name,
    ...(approval.prompt ? { prompt: approval.prompt } : {}),
    ...(approval.gate ? { gate: approval.gate } : {}),
    explanation: run.explanation,
    steps: before.map(stage => {
      const status = stageStatus(stage);
      const detail = stage.lastError
        ?? (stage.exitCode !== undefined && stage.exitCode !== 0 ? `exit ${stage.exitCode}` : undefined)
        ?? (stage.attempts > 1 ? `${stage.attempts} attempts` : undefined);
      return { name: stage.name, label: status.label, tone: status.tone, ...(detail ? { detail } : {}) };
    }),
    findings: [...totals.entries()].map(([severity, count]) => ({ severity, count })).sort((left, right) => right.count - left.count),
  };
}
