import {
  aggregateMapOutcome,
  formatMapItemBrief,
  plannedMapItems,
  stageSessionKey,
  type MapItem,
  type StageDispatchContext,
  type StageOutcome,
  type WorkflowAgentTaskNode,
  type WorkflowMapItemState,
  type WorkflowMapNode
} from '@praxis/core';
import { abortActiveTask, hasActiveTask } from './aiInstance';
import { runWorkflowAgentStage } from './workflowAgentStage';
import { createItemWorktree, mapItemBranch, mergeItemBranch, releaseItemWorktree, revParseHead } from './mapWorktrees';
import { workflowLogSink } from './workflowLogSink';

/**
 * Runs a map node (FX-BE-165): its agent once per item, side by side.
 *
 * Read-only items share the run's worktree. Items that write each get their own
 * worktree on their own branch, cut from the run's current commit, so no two
 * agents ever edit one tree; when they finish, their commits are merged back into
 * the run's tree one at a time in item order. A conflict fails only that item and
 * says which files both sides changed — a retry runs it again on top of the rest.
 *
 * Concurrency is bounded twice: by the node's own `concurrency`, and by a cap on
 * map items running across every run at once, so a large fan-out cannot exhaust
 * the machine or a provider's rate limit.
 */

const GLOBAL_MAP_ITEM_LIMIT = 6;

let globalRunning = 0;
const globalWaiters: Array<() => void> = [];

async function acquireGlobalSlot(): Promise<void> {
  if (globalRunning < GLOBAL_MAP_ITEM_LIMIT) {
    globalRunning += 1;
    return;
  }
  await new Promise<void>(resolve => globalWaiters.push(resolve));
  globalRunning += 1;
}

function releaseGlobalSlot(): void {
  globalRunning -= 1;
  globalWaiters.shift()?.();
}

/** Session keys of items in flight, per `${runId}:${nodeId}`, so a cancel reaches every one. */
const activeItems = new Map<string, Set<string>>();

export function mapItemSessionKey(runId: string, nodeId: string, index: number): string {
  return stageSessionKey(runId, `${nodeId}~${index + 1}`);
}

/** The synthetic agent stage an item runs as. */
function itemStage(node: WorkflowMapNode, item: MapItem, index: number): WorkflowAgentTaskNode {
  return {
    type: 'agent-task',
    id: `${node.id}~${index + 1}`,
    name: `${node.name} — ${item.label}`,
    x: node.x,
    y: node.y,
    inputs: node.inputs,
    agent: node.agent,
    instructions: node.instructions,
    // A read-only item cannot produce a diff; the merged result is the node's diff.
    outputs: node.outputs.filter(output => output.kind !== 'diff'),
    mutatesWorktree: node.mutatesWorktree,
    ...(node.model ? { model: node.model } : {}),
    ...(node.modelTier ? { modelTier: node.modelTier } : {}),
    ...(node.timeoutMs ? { timeoutMs: node.timeoutMs } : {})
  };
}

export async function runWorkflowMap(node: WorkflowMapNode, dispatch: StageDispatchContext): Promise<StageOutcome> {
  const runWorktree = dispatch.worktreePath;
  if (!runWorktree) return { status: 'failed', error: 'This stage needs a run worktree; attach a git folder to the project.' };
  const workflowRun = dispatch.run;
  const { toRun, deferred, done } = plannedMapItems(workflowRun, node);
  const total = toRun.length + done.length + deferred.length;
  dispatch.reportProgress?.(`${node.name}: ${toRun.length} item${toRun.length === 1 ? '' : 's'} to run${done.length ? `, ${done.length} already done` : ''}${deferred.length ? `, ${deferred.length} deferred by the cap` : ''}.`);

  const key = `${workflowRun.runId}:${node.id}`;
  const active = new Set<string>();
  activeItems.set(key, active);
  const results: WorkflowMapItemState[] = new Array(toRun.length);
  let stopRequested = false;

  const runItem = async (item: MapItem, index: number): Promise<void> => {
    const ordinal = done.length + index;
    const sessionKey = mapItemSessionKey(workflowRun.runId, node.id, ordinal);
    const branch = node.mutatesWorktree ? mapItemBranch(workflowRun.runId, node.id, ordinal) : undefined;
    if (stopRequested || dispatch.signal?.aborted) {
      results[index] = { key: item.key, label: item.label, outcome: 'cancelled', error: 'Not started: the stage stopped first.' };
      return;
    }
    await acquireGlobalSlot();
    let itemPath: string | undefined;
    try {
      if (stopRequested || dispatch.signal?.aborted) {
        results[index] = { key: item.key, label: item.label, outcome: 'cancelled', error: 'Not started: the stage stopped first.' };
        return;
      }
      itemPath = branch ? await createItemWorktree(runWorktree, branch) : runWorktree;
      active.add(sessionKey);
      const outcome = await runWorkflowAgentStage(itemStage(node, item, ordinal), dispatch, () => undefined, {
        contextNodeId: node.id,
        sessionKey,
        worktreePath: itemPath,
        brief: formatMapItemBrief(node, item, ordinal, total)
      });
      results[index] = {
        key: item.key,
        label: item.label,
        outcome: outcome.status === 'succeeded' ? 'succeeded' : dispatch.signal?.aborted ? 'cancelled' : 'failed',
        sessionKey,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.pause ? { pause: outcome.pause } : {}),
        ...(outcome.findings ? { findings: outcome.findings } : {}),
        ...(outcome.snapshotRef && branch ? { snapshotRef: outcome.snapshotRef } : {}),
        ...(branch ? { branch } : {})
      };
      if (outcome.status !== 'succeeded' && !outcome.pause && node.onItemFailure === 'failFast') {
        stopRequested = true;
        for (const other of active) if (other !== sessionKey && hasActiveTask(other)) await abortActiveTask(other);
      }
    } catch (error) {
      results[index] = { key: item.key, label: item.label, outcome: 'failed', sessionKey, error: error instanceof Error ? error.message : String(error), ...(branch ? { branch } : {}) };
    } finally {
      active.delete(sessionKey);
      if (branch && itemPath && itemPath !== runWorktree) await releaseItemWorktree(runWorktree, itemPath, line => workflowLogSink.appendLine(line));
      releaseGlobalSlot();
    }
  };

  try {
    // Up to `concurrency` items at once; each worker takes the next item in order.
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(node.concurrency, toRun.length)) }, async () => {
      while (next < toRun.length) {
        const index = next;
        next += 1;
        await runItem(toRun[index], index);
      }
    });
    await Promise.all(workers);
  } finally {
    activeItems.delete(key);
  }

  // Merge writing items back in item order, so the result does not depend on who finished first.
  let mergedSnapshotRef: string | undefined;
  if (node.mutatesWorktree && !dispatch.signal?.aborted) {
    for (const result of results) {
      if (result.outcome !== 'succeeded' || !result.branch) continue;
      const merged = await mergeItemBranch(runWorktree, result.branch, result.label);
      if (!merged.ok) {
        result.outcome = 'failed';
        result.error = merged.conflicts.length
          ? `Merge conflict: this item and the items merged before it both changed ${merged.conflicts.join(', ')}. Retry to run it again on top of them.`
          : `Could not merge: ${merged.detail}`;
      }
    }
    mergedSnapshotRef = await revParseHead(runWorktree);
  }

  const items: WorkflowMapItemState[] = [
    ...done,
    ...results,
    ...deferred.map(item => ({ key: item.key, label: item.label, outcome: 'deferred' as const }))
  ];
  return aggregateMapOutcome(node, items, { deferred: deferred.length, ...(mergedSnapshotRef ? { mergedSnapshotRef } : {}) });
}

/** Stops every item of a map node still running. */
export async function cancelWorkflowMap(runId: string, nodeId: string): Promise<void> {
  for (const sessionKey of activeItems.get(`${runId}:${nodeId}`) ?? []) {
    if (hasActiveTask(sessionKey)) await abortActiveTask(sessionKey);
  }
}
