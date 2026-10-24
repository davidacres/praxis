import {
  WorkflowRunStore,
  exhaustedProviders,
  providerHeadroom,
  resolveApprovalTarget,
  summarizeWorkflowRun,
  scheduledWorkflowBlocker,
  type EntryProgress,
  type ProviderUsageReading,
  type ScheduledEntrySpend,
  type ScheduledRun,
  type ScheduledRunLive,
  type WorkflowObservation,
  type WorkflowRun
} from '@praxis/core';
import { getAiUsageLog } from './aiUsageLogInstance';
import { providerSnapshot } from './aiUsageIpc';
import { getSettingsBackend } from './settingsBackendInstance';
import { usableProviders } from './providerFallback';
import { getWorkflowBackingStore, getWorkflowPolicyStore } from './workflowStoreInstance';

/**
 * What a scheduled run needs to know about the workflow runs and providers it
 * drives (FX-BF-047): progress, spend, and provider allowance. Kept apart from
 * the runner wiring so the schedule view can read it without importing the
 * runner (which imports the schedule store).
 */
const USAGE_CACHE_MS = 60_000;

function runStore(): WorkflowRunStore {
  return new WorkflowRunStore(getWorkflowBackingStore());
}

function summarize(run: WorkflowRun) {
  return summarizeWorkflowRun(run, getWorkflowPolicyStore().effectiveForProject(run.projectId)?.profile);
}

/** Cost and tokens the ledger has recorded against this workflow run. */
export function spendFor(workflowRunId: string): ScheduledEntrySpend | undefined {
  let tokens = 0;
  let cost = 0;
  let currency: string | undefined;
  let any = false;
  for (const event of getAiUsageLog().list()) {
    if (event.workflowRunId !== workflowRunId) continue;
    any = true;
    tokens += event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    if (event.cost) {
      cost += event.cost.amount;
      currency ??= event.cost.currency;
    }
  }
  if (!any) return undefined;
  return { tokens, ...(currency ? { cost, currency } : {}) };
}

/** What the workflow engine says about a run, reduced to what the schedule acts on. */
export function observeWorkflowRun(workflowRunId: string): WorkflowObservation | undefined {
  const run = runStore().get(workflowRunId);
  if (!run) return undefined;
  const summary = summarize(run);
  const spend = spendFor(workflowRunId);
  const spendField = spend ? { spend } : {};
  const blocker = scheduledWorkflowBlocker(summary);
  const failing = summary.stages.find(stage => stage.outcome === 'failed');
  // Providers that hit their limit during this run: the schedule must never start a retry on one of them.
  const ranOut = exhaustedProviders(run);
  const exhaustedField = ranOut.length > 0 ? { exhausted: ranOut } : {};
  let progress: EntryProgress;
  if (summary.status === 'succeeded') progress = { kind: 'succeeded', ...spendField, ...exhaustedField };
  else if (summary.status === 'failed') progress = { kind: 'failed', reason: failing?.lastError || summary.explanation, ...spendField, ...exhaustedField };
  else if (summary.status === 'cancelled') progress = { kind: 'cancelled', reason: summary.explanation, ...spendField, ...exhaustedField };
  else if (summary.paused) {
    progress = { kind: 'stalled', reason: summary.explanation, pauseReason: summary.pauseReason === 'provider-limit' ? 'budget' : 'policy', ...spendField, ...exhaustedField };
  } else if (summary.status === 'awaiting-approval') {
    let nodeId = '';
    try {
      nodeId = resolveApprovalTarget(run).id;
    } catch {
      /* more than one approval is open; the run view decides which */
    }
    const stage = summary.stages.find(row => row.nodeId === nodeId);
    progress = { kind: 'gate', nodeId, label: stage?.name ?? 'Approval', ...spendField, ...exhaustedField };
  } else if (blocker) {
    const stage = blocker;
    progress = { kind: 'stalled', pauseReason: 'failure', reason: `${stage.name} failed: ${stage.lastError ?? 'No error was reported.'} Retry the stage or open the workflow to review it.`, ...spendField, ...exhaustedField };
  } else if (summary.needsDecision) {
    progress = { kind: 'stalled', pauseReason: 'policy', reason: summary.needsDecision.message, ...spendField, ...exhaustedField };
  } else {
    const live = summary.stages.find(stage => stage.lane === 'running') ?? [...summary.stages].reverse().find(stage => stage.provider);
    progress = {
      kind: 'running',
      provider: live?.provider ?? summary.aiProvider,
      ...(live?.sessionId ? { sessionId: live.sessionId } : {}),
      ...spendField,
      ...exhaustedField
    };
  }
  return { progress };
}

/** A run's progress through its stages, for the live view. */
export function stageProgressFor(workflowRunId: string): Pick<ScheduledRunLive, 'stageLabel' | 'stageIndex' | 'stageCount' | 'provider' | 'recovery'> | undefined {
  const run = runStore().get(workflowRunId);
  if (!run) return undefined;
  const summary = summarize(run);
  const stages = summary.stages;
  const blocker = scheduledWorkflowBlocker(summary);
  const current = stages.find(stage => stage.lane === 'running' || stage.lane === 'awaiting' || stage.lane === 'paused') ?? blocker ?? stages.find(stage => stage.lane === 'failed');
  const done = stages.filter(stage => stage.lane === 'done' || stage.lane === 'skipped').length;
  return {
    stageLabel: current ? `${current.name}${current.outcome === 'failed' ? ' — needs attention' : ''}` : summary.status === 'succeeded' ? 'Finished' : summary.explanation,
    stageIndex: current ? stages.indexOf(current) + 1 : done,
    stageCount: stages.length,
    ...(blocker ? { recovery: { nodeId: blocker.nodeId, error: blocker.lastError, attempts: blocker.attemptsThisRevision ?? blocker.attempts, maxAttempts: blocker.maxAttempts } } : {}),
    ...(current?.provider ? { provider: current.provider } : {})
  };
}

let usageCache: { at: number; reading: ProviderUsageReading } | undefined;

/** The user's hand-over point (`ai.providerHandoverPercent`) as a share of an allowance, 0–1. */
export function handoverThreshold(): number {
  return getSettingsBackend().read().ai.providerHandoverPercent / 100;
}

/** An e2e stand-in for provider quotas: `{"claude-code-cli":0.97}` — fractions of allowance used. */
function usageOverride(): Record<string, number> | undefined {
  const raw = process.env.PRAXIS_E2E_PROVIDER_USAGE?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return undefined;
  }
}

function usedFraction(snapshot: Awaited<ReturnType<typeof providerSnapshot>>): number | undefined {
  return providerHeadroom(
    snapshot.windows.map(window => {
      if (typeof window.usedPercent === 'number') return window.usedPercent / 100;
      if (window.tokenLimit && window.usedTokens !== undefined) return window.usedTokens / window.tokenLimit;
      if (window.costLimit && window.usedCost !== undefined) return window.usedCost / window.costLimit;
      return undefined;
    })
  );
}

export async function readProviderUsage(): Promise<ProviderUsageReading> {
  const override = usageOverride();
  if (!override && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.reading;
  const usable = await usableProviders();
  const used: Record<string, number | undefined> = {};
  await Promise.all(
    usable.map(async provider => {
      if (override) {
        used[provider] = typeof override[provider] === 'number' ? override[provider] : undefined;
        return;
      }
      try {
        used[provider] = usedFraction(await providerSnapshot(provider));
      } catch {
        used[provider] = undefined;
      }
    })
  );
  const reading = { usable, active: getSettingsBackend().read().ai.activeProvider, used };
  if (!override) usageCache = { at: Date.now(), reading };
  return reading;
}


/** Used by the IPC layer so it can describe the live entry without importing the engine. */
export function describeLiveEntry(run: ScheduledRun) {
  const entry = run.entries.find(candidate => candidate.outcome?.status === 'running' || candidate.outcome?.status === 'paused');
  const workflowRunId = entry?.outcome?.workflowRunId;
  if (!entry || !workflowRunId) return undefined;
  return { entryId: entry.id, workflowRunId, ...(stageProgressFor(workflowRunId) ?? { stageLabel: 'Starting', stageIndex: 0, stageCount: 0 }) };
}
