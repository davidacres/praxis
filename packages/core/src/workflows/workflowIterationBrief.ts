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
import type { AgentEventSummary, AgentSessionRecord, AgentTaskListItem, HandoverBrief } from '../ai/agentTypes';
import type { SessionChangeSummary } from '../ai/sessionChangeSummary';
import { buildDeterministicHandoverBrief, collectTouchedFiles, summariseForBrief } from '../ai/sessionHandover';

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

/** When a person last started a new revision that reran `nodeId`, if one did. */
function lastReworkAt(run: WorkflowRun, nodeId: string): string | undefined {
  const reworks = (run.events ?? []).filter(
    event => event.kind === 'revision-started' && !!event.nodeId && downstreamNodeIds(run, event.nodeId).has(nodeId)
  );
  return reworks[reworks.length - 1]?.at;
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

  // A new revision starts over. What earlier loops reported was about the revision that was set
  // aside, so it is history, not this pass's instructions: handed on as "fix these first", it
  // told an implementer to repair evidence it could not find, and it gave up instead of building.
  const revisionStartedAt = lastReworkAt(run, nodeId);

  for (const status of loopsContaining(run, nodeId)) {
    const history = (run.loopHistory ?? []).filter(
      entry => entry.edgeId === status.edge.id && (!revisionStartedAt || entry.at > revisionStartedAt)
    );
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

  // What a person started this revision to fix — the findings failing a gate when they did.
  const carried = run.revisionFindings;
  if (carried && carried.at === revisionStartedAt && downstreamNodeIds(run, carried.nodeId).has(nodeId)) {
    const { activeFindings } = filterUnwaivedFindings(countableFindings(carried.items.map(item => item.finding)), waivers);
    const active = new Set(activeFindings);
    const items = carried.items.filter(item => active.has(item.finding)).sort((left, right) => bySeverity(left.finding, right.finding));
    if (items.length > 0) {
      sections.push([
        `### This revision was started to fix what ${[...new Set(items.map(item => item.stage))].join(', ')} reported`,
        fixes ? 'Fix these — they are why this revision exists:' : 'The previous revision was held back for these; check whether each is now fixed:',
        ...items.slice(0, FINDINGS_LISTED).map(item => findingLine(item.finding)),
        ...(items.length > FINDINGS_LISTED ? [`- …and ${items.length - FINDINGS_LISTED} more of lower severity.`] : []),
        fixes ? 'Say in your reply how each finding above was addressed, or why it was not.' : 'Say for each finding above whether it is fixed, and report it again if it is not.'
      ].join('\n'));
    }
  }

  // An ordinary retry in this revision: tell the stage why its last attempt failed, or that it was interrupted.
  if (state) {
    const thisRevision = state.attempts.slice(state.revisionBase ?? 0);
    const lastAttempt = thisRevision[thisRevision.length - 1];
    const isInterrupted =
      lastAttempt &&
      lastAttempt.outcome === 'failed' &&
      lastAttempt.pause === 'environment' &&
      (lastAttempt.error?.toLowerCase().includes('interrupted') ?? false);

    if (isInterrupted) {
      sections.push([
        '### Previous attempt was interrupted mid-flight by an app restart or crash',
        'The previous attempt at this stage was running when Praxis stopped or crashed.',
        'The git worktree and working files retain the in-progress changes from that session.',
        'Do NOT start from scratch or guess why changes are present. Inspect the working tree (git status / diff), verify what was already done against the goal and plan, and continue the implementation from that point.'
      ].join('\n'));
    } else {
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

export interface GitStatusSummaryInput {
  files?: Array<{ path: string; staged?: boolean; worktreeStatus?: string }>;
}

export interface InterruptedSessionSummaryInput {
  handoverBrief?: HandoverBrief;
  taskList?: AgentTaskListItem[];
  responseText?: string;
  events?: AgentEventSummary[];
  changeSummary?: SessionChangeSummary;
}

/**
 * Details of in-progress work from a session that was interrupted by a crash or restart.
 * Formats tasks completed vs remaining, files modified, and instructions to prevent the
 * resumed agent from guessing what the in-progress changes are.
 */
export function formatInterruptedSessionDetails(
  previous?: InterruptedSessionSummaryInput,
  gitStatus?: GitStatusSummaryInput
): string | undefined {
  if (!previous && (!gitStatus?.files || gitStatus.files.length === 0)) {
    return undefined;
  }

  const lines: string[] = [
    '### In-Progress Details from Interrupted Session',
    'Praxis crashed or stopped while the previous session was actively executing this stage.',
    'The working directory and git worktree retain in-progress changes from that attempt. Do NOT discard these changes, start over, or guess what they are for — continue the implementation from where the previous session left off.'
  ];

  let progress: string | undefined;
  if (previous?.handoverBrief?.progress && previous.handoverBrief.progress !== 'Session has not produced work yet.') {
    progress = previous.handoverBrief.progress;
  } else if (previous?.responseText?.trim()) {
    progress = summariseForBrief(previous.responseText, 600);
  } else if (previous?.events?.length) {
    const brief = buildDeterministicHandoverBrief(previous as AgentSessionRecord);
    if (brief.progress && brief.progress !== 'Session has not produced work yet.') {
      progress = brief.progress;
    }
  }

  if (progress) {
    lines.push(`**Previous Progress / Activity:**\n${progress}`);
  }

  const completedTasks = (previous?.taskList ?? [])
    .filter(t => t.status === 'completed')
    .map(t => t.content);

  if (completedTasks.length > 0) {
    lines.push('**Tasks Completed Before Interruption:**\n' + completedTasks.map(t => `- [x] ${t}`).join('\n'));
  } else if (previous?.handoverBrief?.decisions) {
    lines.push(`**Completed Work / Decisions:**\n${previous.handoverBrief.decisions}`);
  }

  const pendingTasks = (previous?.taskList ?? [])
    .filter(t => t.status !== 'completed')
    .map(t => t.content);

  if (pendingTasks.length > 0) {
    lines.push('**Remaining / In-Flight Tasks:**\n' + pendingTasks.map(t => `- [ ] ${t}`).join('\n'));
  } else if (previous?.handoverBrief?.nextSteps && previous.handoverBrief.nextSteps !== 'Continue the current task.') {
    lines.push(`**Planned Next Steps:**\n${previous.handoverBrief.nextSteps}`);
  }

  const touched = previous?.handoverBrief?.touchedFiles?.length
    ? previous.handoverBrief.touchedFiles
    : previous?.events?.length
      ? collectTouchedFiles(previous.events)
      : [];

  if (touched.length > 0) {
    lines.push(`**Files Touched Before Interruption:**\n${touched.slice(0, 20).join(', ')}${touched.length > 20 ? '…' : ''}`);
  }

  const staged = (gitStatus?.files ?? []).filter(f => f.staged).map(f => f.path);
  const unstaged = (gitStatus?.files ?? []).filter(f => !f.staged).map(f => `${f.path}${f.worktreeStatus ? ` (${f.worktreeStatus})` : ''}`);

  if (staged.length > 0 || unstaged.length > 0) {
    const gitParts: string[] = [];
    if (staged.length > 0) gitParts.push(`Staged: ${staged.slice(0, 15).join(', ')}${staged.length > 15 ? '…' : ''}`);
    if (unstaged.length > 0) gitParts.push(`Unstaged/untracked: ${unstaged.slice(0, 15).join(', ')}${unstaged.length > 15 ? '…' : ''}`);
    lines.push(`**Current Worktree Git Status:**\n${gitParts.join('\n')}`);
  }

  lines.push(
    '**Continuation Instructions:**\n' +
    '1. Inspect the existing changes with `git status` and `git diff` to understand what was already written.\n' +
    '2. Complete the remaining requirements from the plan and ticket.\n' +
    '3. Run focused tests to verify all changes.\n' +
    '4. Create a git commit with the completed work before finishing.'
  );

  return lines.join('\n\n');
}
