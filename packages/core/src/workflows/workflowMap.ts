/**
 * Map nodes: one agent stage per item of a list known only at run time (FX-BE-165).
 *
 * The engine's graph is static, so "fix each of these twelve findings" or "review
 * each module" could not be said before: there was no node for "for each". A map
 * node reads its list from an upstream output — each countable finding of a
 * `findings` artifact, or each item of a plan published to the board — and runs
 * its agent once per item, in parallel up to its concurrency.
 *
 * This module is the pure half: which items there are, which still need running,
 * what each item's brief says, and how item results fold into one stage outcome.
 * Running sessions, worktrees and merges is the desktop's.
 */

import { countableFindings, definitionWaivers, SEVERITY_RANK } from './workflowEdges';
import { filterUnwaivedFindings } from './waiverRegister';
import type { StageOutcome } from './workflowOrchestrator';
import type { WorkflowRun } from './workflowRun';
import {
  nodeOutputs,
  type CheckFinding,
  type CheckFindings,
  type WorkflowArtifactKind,
  type WorkflowMapNode
} from './workflowTypes';

/** One item a map node fans out over. */
export interface MapItem {
  /** Stable across retries: a finding's fingerprint, or a board item's key. */
  key: string;
  /** Short label for the run view and the session title. */
  label: string;
  /** What the item's stage is handed. */
  finding?: CheckFinding;
  issueKey?: string;
}

/** How one item of a map node went, recorded on the node's state. */
export interface WorkflowMapItemState {
  key: string;
  label: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'deferred';
  /** The session store key of the item's stage session. */
  sessionKey?: string;
  error?: string;
  /** For a mutating item: its commit, before it was merged back. */
  snapshotRef?: string;
  findings?: CheckFindings;
  /** The item's branch, for a mutating item, kept after its worktree is released. */
  branch?: string;
}

/** The items a map node fans out over, in a stable order (most severe finding first). */
export function mapItemsFor(run: WorkflowRun, node: WorkflowMapNode): MapItem[] {
  const producer = Object.values(run.nodes).find(state => state.artifacts.some(artifact => artifact.contractId === node.over));
  if (!producer) return [];
  if (node.itemSource === 'plan-items') {
    const artifact = producer.artifacts.find(candidate => candidate.contractId === node.over);
    return (artifact?.reference?.itemKeys ?? []).map(key => ({ key, label: key, issueKey: key }));
  }
  const findings = filterUnwaivedFindings(countableFindings(producer.findings?.findings ?? []), definitionWaivers(run.definition)).activeFindings;
  const unique = new Map<string, CheckFinding>();
  for (const finding of findings) if (!unique.has(finding.fingerprint)) unique.set(finding.fingerprint, finding);
  return [...unique.values()]
    .sort((left, right) => (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0))
    .map(finding => ({
      key: finding.fingerprint,
      label: `${finding.severity}: ${finding.message.length > 80 ? `${finding.message.slice(0, 80)}…` : finding.message}`,
      finding
    }));
}

/**
 * What a map node's next attempt runs: every item that has not yet succeeded in
 * this revision, up to `maxItems`. The rest are deferred — recorded, never dropped —
 * and the node fails saying so, so a person can retry to run them.
 */
export function plannedMapItems(run: WorkflowRun, node: WorkflowMapNode): { toRun: MapItem[]; deferred: MapItem[]; done: WorkflowMapItemState[] } {
  const previous = new Map((run.nodes[node.id]?.mapItems ?? []).map(item => [item.key, item]));
  const done: WorkflowMapItemState[] = [];
  const remaining: MapItem[] = [];
  for (const item of mapItemsFor(run, node)) {
    const before = previous.get(item.key);
    if (before?.outcome === 'succeeded') done.push(before);
    else remaining.push(item);
  }
  return { toRun: remaining.slice(0, node.maxItems), deferred: remaining.slice(node.maxItems), done };
}

/** The brief section an item's stage is handed: the one thing it is for. */
export function formatMapItemBrief(node: WorkflowMapNode, item: MapItem, index: number, total: number): string {
  const lines = [`### Your item (${index + 1} of ${total}) — work on this one only`];
  if (item.finding) {
    const finding = item.finding;
    lines.push(
      `[${finding.severity}] ${finding.category}: ${finding.message}`,
      ...(finding.file ? [`Where: ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`] : []),
      ...(finding.suggestion ? [`Suggested fix: ${finding.suggestion}`] : [])
    );
  } else if (item.issueKey) {
    lines.push(`Board item ${item.issueKey}. Read it from the board before starting.`);
  }
  lines.push(
    node.mutatesWorktree
      ? 'You have your own checkout for this item; other items run beside you in theirs. Change only what this item needs, so the results merge cleanly, and commit.'
      : 'Other items are being handled by other sessions; do not report on them.'
  );
  return lines.join('\n');
}

/** Item results folded into the map node's one outcome. */
export function aggregateMapOutcome(
  node: WorkflowMapNode,
  items: readonly WorkflowMapItemState[],
  options: { mergedSnapshotRef?: string; deferred: number }
): StageOutcome {
  const failed = items.filter(item => item.outcome === 'failed' || item.outcome === 'cancelled');
  const succeeded = items.filter(item => item.outcome === 'succeeded');

  // Findings concatenated across items, one per fingerprint.
  const byFingerprint = new Map<string, CheckFinding>();
  const metrics: Record<string, number> = {};
  for (const item of succeeded) {
    for (const finding of item.findings?.findings ?? []) if (!byFingerprint.has(finding.fingerprint)) byFingerprint.set(finding.fingerprint, finding);
    for (const [name, value] of Object.entries(item.findings?.metrics ?? {})) metrics[name] = (metrics[name] ?? 0) + value;
  }
  metrics.itemsSucceeded = succeeded.length;
  metrics.itemsFailed = failed.length;
  metrics.itemsDeferred = options.deferred;
  const findings: CheckFindings = { findings: [...byFingerprint.values()], metrics };

  const artifacts = nodeOutputs(node).flatMap((contract): Array<{ contractId: string; kind: WorkflowArtifactKind; path?: string }> => {
    if (contract.kind === 'diff') return options.mergedSnapshotRef ? [{ contractId: contract.id, kind: contract.kind, path: options.mergedSnapshotRef }] : [];
    return succeeded.length > 0 || items.length === 0 ? [{ contractId: contract.id, kind: contract.kind }] : [];
  });

  const problems: string[] = [];
  if (failed.length > 0) {
    problems.push(`${failed.length} of ${items.length} item${items.length === 1 ? '' : 's'} failed: ${failed.map(item => `${item.label} (${item.error ?? item.outcome})`).join('; ')}`);
  }
  if (options.deferred > 0) {
    problems.push(`${options.deferred} more item${options.deferred === 1 ? ' was' : 's were'} deferred by the ${node.maxItems}-item cap — retry to run ${options.deferred === 1 ? 'it' : 'them'}`);
  }
  if (problems.length > 0) {
    return { status: 'failed', error: `${problems.join('. ')}.`, findings, mapItems: [...items] };
  }
  return {
    status: 'succeeded',
    artifacts,
    findings,
    mapItems: [...items],
    ...(options.mergedSnapshotRef ? { snapshotRef: options.mergedSnapshotRef } : {})
  };
}
