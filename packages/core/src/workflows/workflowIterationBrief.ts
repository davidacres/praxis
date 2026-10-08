/**
 * What a stage is told when it runs again (FX-BE-163).
 *
 * A retry used to differ from the first attempt only by a stronger model: it was
 * not told why the last attempt failed, and a stage reopened by a loop was not
 * told what the reviewer found. So it tended to repeat itself. This builds the
 * section that closes that gap — the findings that sent the run round, what this
 * stage's last attempt did, and a line per earlier iteration — derived entirely
 * from the run record, so it survives restarts and cannot drift from what the
 * run actually did.
 *
 * The handoff rule from `workflowStageSession` still holds: structured findings
 * and outcomes, never an upstream transcript.
 */

import { countableFindings, definitionWaivers, loopStatuses, SEVERITY_RANK } from './workflowEdges';
import { filterUnwaivedFindings } from './waiverRegister';
import { downstreamNodeIds, type WorkflowLoopIteration, type WorkflowRun } from './workflowRun';
import { nodeMutatesWorktree, type CheckFinding } from './workflowTypes';

/** Enough for a full set of findings with suggestions; small enough not to become the prompt. */
export const ITERATION_BRIEF_MAX_CHARS = 8000;
/** Findings listed in full; the rest are counted. */
const FINDINGS_LISTED = 25;

/** Every loop whose body contains `nodeId`: from the loop's target to its source, inclusive. */
function loopsContaining(run: WorkflowRun, nodeId: string) {
  return loopStatuses(run).filter(status => {
    const { edge } = status;
    const fromTarget = downstreamNodeIds(run, edge.to);
    if (!fromTarget.has(nodeId) || !fromTarget.has(edge.from)) return false;
    return nodeId === edge.from || downstreamNodeIds(run, nodeId).has(edge.from);
  });
}

function findingLine(finding: CheckFinding, repeatOf?: number): string {
  const where = finding.file ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''})` : '';
  const again = repeatOf !== undefined ? ` — raised again (first seen in iteration ${repeatOf})` : '';
  const fix = finding.suggestion ? `\n  Suggested fix: ${finding.suggestion}` : '';
  return `- [${finding.severity}] ${finding.category}: ${finding.message}${where}${again}${fix}`;
}

function bySeverity(left: CheckFinding, right: CheckFinding): number {
  return (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0);
}

function stageName(run: WorkflowRun, nodeId: string): string {
  return run.definition.nodes.find(node => node.id === nodeId)?.name ?? nodeId;
}

function historyLine(run: WorkflowRun, entry: WorkflowLoopIteration): string {
  const counts = new Map<string, number>();
  for (const finding of entry.findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((left, right) => (SEVERITY_RANK[right[0] as CheckFinding['severity']] ?? 0) - (SEVERITY_RANK[left[0] as CheckFinding['severity']] ?? 0))
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');
  const findings = entry.findingCount > 0 ? `${entry.findingCount} finding${entry.findingCount === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}` : 'no findings';
  const parts = [
    `Iteration ${entry.iteration}: ${stageName(run, entry.sourceNodeId)} ${entry.outcome === 'failed' ? 'failed' : 'reported'} ${findings}`,
    entry.error ? `error: ${firstLine(entry.error)}` : undefined,
    entry.score !== undefined ? `score ${entry.score}` : undefined,
    entry.restoredTo ? `scored worse than the best, so its code was undone (restored ${entry.restoredTo.slice(0, 7)})` : undefined
  ];
  return `- ${parts.filter(Boolean).join('; ')}.`;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The section a stage is handed when it runs again: on a later loop iteration,
 * or after a failed attempt in this revision. Undefined on a first, clean run —
 * a first-iteration brief is exactly what it was before loops existed.
 */
export function formatIterationContext(run: WorkflowRun, nodeId: string, maxChars = ITERATION_BRIEF_MAX_CHARS): string | undefined {
  const sections: string[] = [];
  const state = run.nodes[nodeId];
  const stageNode = run.definition.nodes.find(candidate => candidate.id === nodeId);
  // A stage that changes code is asked to fix; one that only reads is asked to check the fix.
  const fixes = !!stageNode && nodeMutatesWorktree(stageNode);
  const waivers = definitionWaivers(run.definition);

  for (const status of loopsContaining(run, nodeId)) {
    const history = (run.loopHistory ?? []).filter(entry => entry.edgeId === status.edge.id);
    const latest = history[history.length - 1];
    if (!latest) continue;
    const pass = history.length + 1;
    const total = status.budget + 1;
    const lines = [`### Iteration ${pass} of ${total}: ${stageName(run, latest.sourceNodeId)} sent this work back to ${stageName(run, latest.targetNodeId)}`];

    if (latest.error) lines.push(`It failed: ${latest.error.trim().slice(0, 1200)}`);

    // Fingerprint → the iteration a finding was first raised in, so a recurring one is called out.
    const firstSeen = new Map<string, number>();
    for (const entry of history.slice(0, -1)) {
      for (const finding of entry.findings) if (!firstSeen.has(finding.fingerprint)) firstSeen.set(finding.fingerprint, entry.iteration);
    }
    const unique = new Map<string, CheckFinding>();
    for (const finding of countableFindings(latest.findings)) if (!unique.has(finding.fingerprint)) unique.set(finding.fingerprint, finding);
    const { activeFindings, waivedFindings } = filterUnwaivedFindings([...unique.values()].sort(bySeverity), waivers);
    if (activeFindings.length > 0) {
      lines.push(
        `${fixes ? 'Fix these first — they are why this pass exists' : 'The last pass reported these; check whether each is now fixed'}${latest.findingCount > latest.findings.length ? ` (${latest.findingCount} in all; the most severe are listed)` : ''}:`,
        ...activeFindings.slice(0, FINDINGS_LISTED).map(finding => findingLine(finding, firstSeen.get(finding.fingerprint))),
        ...(activeFindings.length > FINDINGS_LISTED ? [`- …and ${activeFindings.length - FINDINGS_LISTED} more of lower severity.`] : [])
      );
    }
    if (waivedFindings.length > 0) {
      lines.push(
        'Already waived by a person — do not change code for these:',
        ...waivedFindings.slice(0, 10).map(finding => `- ${finding.message}${finding.file ? ` (${finding.file})` : ''}`)
      );
    }
    if (latest.metrics && Object.keys(latest.metrics).length > 0) {
      lines.push(`Its measurements: ${Object.entries(latest.metrics).map(([name, value]) => `${name} ${value}`).join(', ')}.`);
    }
    if (history.length > 1 || latest.restoredTo) {
      lines.push('What happened so far:', ...history.map(entry => historyLine(run, entry)));
    }
    if (latest.restoredTo) {
      lines.push(`The last pass scored worse than the best, so the code was put back to the best iteration (${latest.restoredTo.slice(0, 7)}). Take a different approach from the one that was undone.`);
    }
    lines.push(fixes ? 'Say in your reply how each finding above was addressed, or why it was not.' : 'Say for each finding above whether it is fixed, and report it again if it is not.');
    sections.push(lines.join('\n'));
  }

  // An ordinary retry in this revision: tell the stage why its last attempt failed.
  if (state) {
    const thisRevision = state.attempts.slice(state.revisionBase ?? 0);
    const failed = thisRevision.filter(attempt => attempt.outcome === 'failed' && !attempt.pause && attempt.error);
    if (failed.length > 0) {
      const last = failed[failed.length - 1];
      sections.push([
        `### Previous attempt${failed.length === 1 ? '' : 's'} at this stage failed (${failed.length})`,
        `The most recent failed with: ${last.error!.trim().slice(0, 1500)}`,
        'Work out why before repeating the same approach.'
      ].join('\n'));
    }
  }

  // A repair stage also needs to know what other stages still object to, so its fix
  // does not trade one gate's failure for another's.
  const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
  const isRepair = run.definition.nodes.some(candidate => candidate.type === 'check' && candidate.failureRecovery?.repairNodeId === nodeId);
  if (node && isRepair) {
    const mine = downstreamNodeIds(run, nodeId);
    const open = Object.values(run.nodes)
      .filter(other => other.nodeId !== nodeId && !mine.has(other.nodeId) && other.findings)
      .flatMap(other =>
        filterUnwaivedFindings(countableFindings(other.findings!.findings), waivers).activeFindings
          .filter(finding => (SEVERITY_RANK[finding.severity] ?? 0) >= SEVERITY_RANK.medium)
          .map(finding => ({ stage: stageName(run, other.nodeId), finding }))
      )
      .sort((left, right) => bySeverity(left.finding, right.finding));
    if (open.length > 0) {
      sections.push([
        '### Findings other stages still report on this change',
        ...open.slice(0, FINDINGS_LISTED).map(({ stage, finding }) => `${findingLine(finding)} — from ${stage}`)
      ].join('\n'));
    }
  }

  if (sections.length === 0) return undefined;
  const text = sections.join('\n\n');
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half).trimEnd()}\n\n[… ${text.length - maxChars} characters omitted …]\n\n${text.slice(text.length - half).trimStart()}`;
}

/**
 * The run's parameters as plain prose for a stage brief (FX-BE-166). Values are
 * quoted text, never interpolated into a command, a path, or a tool call.
 */
export function formatRunParameters(run: Pick<WorkflowRun, 'definition' | 'parameters'>): string | undefined {
  const values = run.parameters ?? {};
  const declared = run.definition.parameters ?? [];
  const lines = declared
    .filter(parameter => values[parameter.id] !== undefined && !parameter.bindsLoopEdge)
    .map(parameter => `- ${parameter.label}: ${String(values[parameter.id])}`);
  if (lines.length === 0) return undefined;
  return ['What the person who started this run asked for:', ...lines].join('\n');
}
