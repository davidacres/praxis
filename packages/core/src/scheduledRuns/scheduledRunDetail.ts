/**
 * What the scheduled-run screens show about each ticket's workflow (FX-BF-047 /
 * FX-BE-193): the agent tasks in the order they run, with their state, attempts,
 * time and tokens (TASK-504), and a one-line "now" for the task that is running
 * (TASK-505). Everything here is read from what the workflow engine, the usage
 * log and the agent session recorded. Nothing is estimated or invented, so a
 * stage that reported nothing shows nothing.
 *
 * Pure: the caller passes the run, its summary, the usage events and the session
 * events it has; this module does no I/O.
 */

import type { AgentEventSummary } from '../ai/agentTypes';
import type { AiUsageEvent } from '../ai/aiUsageLog';
import { dagEdges } from '../workflows/workflowEdges';
import type { WorkflowRun, WorkflowRunEvent } from '../workflows/workflowRun';
import type { StageRow, WorkflowRunSummary } from '../workflows/workflowRunSummary';
import type { WorkflowDefinition, WorkflowNode } from '../workflows/workflowTypes';

/** One agent task (workflow stage) of one ticket, as the run monitor and report show it. */
export interface ScheduledStageDetail {
  nodeId: string;
  name: string;
  type: WorkflowNode['type'];
  lane: StageRow['lane'];
  /** Every attempt across loop revisions. */
  attempts: number;
  /** Attempts in the current loop revision; what `maxAttempts` bounds. */
  attemptsThisRevision?: number;
  maxAttempts?: number;
  provider?: string;
  /** The latest attempt's duration, once it ended. */
  durationMs?: number;
  /** When the latest attempt started; with no `durationMs`, the running attempt's start. */
  startedAt?: string;
  /** Every ended attempt's time added up, loops and retries included — what the stage cost the run. */
  totalMs?: number;
  /** Tokens the usage log recorded against this stage across all its attempts. Absent = none recorded. */
  tokens?: number;
  cost?: number;
  currency?: string;
  lastError?: string;
  command?: string;
  /** The agent session behind the latest attempt, to open it. */
  sessionKey?: string;
  /** A loop has taken this stage round again: the pass it is on. */
  loopIteration?: number;
  /** The recorded "now" line, only for a running or paused stage. */
  activity?: StageActivity;
}

export interface StageActivity {
  text: string;
  at?: string;
  source: 'command' | 'progress' | 'tool' | 'pause';
}

/** One time a loop sent work back, for the report's "worth knowing". */
export interface ScheduledLoopNote {
  fromName: string;
  toName: string;
  iteration: number;
  at: string;
  findings: string[];
}

/** Everything recorded about one queue entry's workflow run. */
export interface ScheduledEntryDetail {
  entryId: string;
  workflowRunId: string;
  stages: ScheduledStageDetail[];
  loops: ScheduledLoopNote[];
}

const ACTIVITY_MAX = 120;

function trim(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ACTIVITY_MAX ? `${flat.slice(0, ACTIVITY_MAX - 1)}…` : flat;
}

/**
 * The stages a person would recognise as the ticket's agent tasks, in the order
 * they run: a topological order over the workflow's forward edges, ties broken by
 * the designer's layout (top to bottom, then left to right). A join is plumbing
 * and is left out. A stage reached only through a failure edge (a repair step)
 * appears only once it has actually run.
 */
export function orderedWorkflowStages(definition: Pick<WorkflowDefinition, 'nodes' | 'edges' | 'entryNodeId'>, ran: (nodeId: string) => boolean = () => false): WorkflowNode[] {
  const edges = dagEdges(definition);
  const incoming = new Map<string, number>();
  for (const node of definition.nodes) incoming.set(node.id, 0);
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const byId = new Map(definition.nodes.map(node => [node.id, node] as const));
  const position = (node: WorkflowNode) => [node.y ?? 0, node.x ?? 0];
  const compare = (a: WorkflowNode, b: WorkflowNode) => {
    if (a.id === definition.entryNodeId) return -1;
    if (b.id === definition.entryNodeId) return 1;
    const [ay, ax] = position(a);
    const [by, bx] = position(b);
    return ay - by || ax - bx;
  };
  const ready = definition.nodes.filter(node => (incoming.get(node.id) ?? 0) === 0).sort(compare);
  const order: WorkflowNode[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    const node = ready.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    order.push(node);
    for (const edge of edges.filter(candidate => candidate.from === node.id)) {
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      if (left === 0 && byId.has(edge.to)) {
        ready.push(byId.get(edge.to)!);
        ready.sort(compare);
      }
    }
  }
  // A cycle the DAG filter missed would leave nodes out; keep them, at the end.
  for (const node of definition.nodes) if (!seen.has(node.id)) order.push(node);

  const onlyOnFailure = (nodeId: string) => {
    const into = edges.filter(edge => edge.to === nodeId);
    return into.length > 0 && into.every(edge => edge.on === 'failure');
  };
  return order.filter(node => node.type !== 'join' && (!onlyOnFailure(node.id) || ran(node.id)));
}

/** Formats a tool call the agent session recorded as "Editing <path>", "Running <command>" and so on. */
export function describeToolEvent(event: AgentEventSummary): string | undefined {
  if (event.type !== 'tool_start') return undefined;
  const data = event.data;
  const args = data?.args ?? {};
  const pathArg = data?.fileChanges?.[0]?.path ?? (typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined);
  const digest = data?.argsSummary?.trim();
  switch (data?.kind) {
    case 'write':
      return pathArg ? `Editing ${pathArg}` : digest ? `Editing ${digest}` : 'Editing files';
    case 'read':
      return pathArg ? `Reading ${pathArg}` : digest ? `Reading ${digest}` : 'Reading files';
    case 'shell':
      return digest ? `Running ${digest}` : typeof args.command === 'string' ? `Running ${args.command}` : 'Running a command';
    case 'search':
      return digest ? `Searching ${digest}` : 'Searching the code';
    case 'list':
      return digest ? `Listing ${digest}` : 'Listing files';
    default:
      if (data?.toolName) return digest ? `${data.toolName}: ${digest}` : `Using ${data.toolName}`;
      return event.summary?.trim() || undefined;
  }
}

/**
 * The "now" line for a stage (TASK-505), from what was recorded, in this order: a
 * check's own command; the stage's latest progress message for this attempt; the
 * agent session's latest tool call; a paused stage's reason. Nothing recorded
 * means no line — never a placeholder.
 */
export function stageActivityLine(
  stage: Pick<StageRow, 'nodeId' | 'type' | 'lane' | 'command' | 'startedAt' | 'lastError'>,
  runEvents: readonly WorkflowRunEvent[],
  sessionEvents: readonly AgentEventSummary[] = []
): StageActivity | undefined {
  if (stage.lane === 'paused' && stage.lastError) return { text: trim(stage.lastError), source: 'pause' };
  if (stage.lane !== 'running') return undefined;
  const since = stage.startedAt ? Date.parse(stage.startedAt) : 0;
  const progress = [...runEvents].reverse().find(event => event.kind === 'node-progress' && event.nodeId === stage.nodeId && Date.parse(event.at) >= since);
  if (stage.type === 'check' && stage.command) {
    // A progress message from the check itself is more specific than its command line.
    return progress ? { text: trim(progress.message), at: progress.at, source: 'progress' } : { text: trim(stage.command), at: stage.startedAt, source: 'command' };
  }
  const tool = [...sessionEvents].reverse().find(event => event.type === 'tool_start' && Date.parse(event.timestamp) >= since);
  const toolText = tool ? describeToolEvent(tool) : undefined;
  if (progress && (!tool || Date.parse(progress.at) >= Date.parse(tool.timestamp))) return { text: trim(progress.message), at: progress.at, source: 'progress' };
  if (toolText) return { text: trim(toolText), at: tool!.timestamp, source: 'tool' };
  if (progress) return { text: trim(progress.message), at: progress.at, source: 'progress' };
  return undefined;
}

/** Tokens and cost the usage log recorded for each stage of one workflow run. */
export function usageByStage(workflowRunId: string, usage: readonly AiUsageEvent[]): Map<string, { tokens: number; cost?: number; currency?: string }> {
  const byNode = new Map<string, { tokens: number; cost?: number; currency?: string }>();
  for (const event of usage) {
    if (event.workflowRunId !== workflowRunId || !event.workflowNodeId) continue;
    const row = byNode.get(event.workflowNodeId) ?? { tokens: 0 };
    row.tokens += event.totalTokens ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    if (event.cost) {
      row.cost = (row.cost ?? 0) + event.cost.amount;
      row.currency ??= event.cost.currency;
    }
    byNode.set(event.workflowNodeId, row);
  }
  return byNode;
}

/**
 * One entry's agent tasks (TASK-504), in run order, from the workflow run and its
 * summary. `sessionEvents` is asked only for a running stage that has a session.
 */
export function scheduledEntryDetail(input: {
  entryId: string;
  run: WorkflowRun;
  summary: Pick<WorkflowRunSummary, 'stages' | 'loops'>;
  usage: readonly AiUsageEvent[];
  sessionEvents?: (sessionKey: string) => readonly AgentEventSummary[] | undefined;
}): ScheduledEntryDetail {
  const { run, summary } = input;
  const rows = new Map(summary.stages.map(row => [row.nodeId, row] as const));
  const spent = usageByStage(run.runId, input.usage);
  const ordered = orderedWorkflowStages(run.definition, nodeId => (run.nodes[nodeId]?.attempts.length ?? 0) > 0);
  const stages: ScheduledStageDetail[] = [];
  for (const node of ordered) {
    const row = rows.get(node.id);
    if (!row) continue;
    const usage = spent.get(node.id);
    const live = row.lane === 'running' || row.lane === 'paused';
    const sessionEvents = live && row.sessionKey ? input.sessionEvents?.(row.sessionKey) ?? [] : [];
    const activity = live ? stageActivityLine(row, run.events ?? [], sessionEvents) : undefined;
    const totalMs = (run.nodes[node.id]?.attempts ?? []).reduce((sum, attempt) => sum + (attempt.endedAt ? Math.max(0, Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)) : 0), 0);
    stages.push({
      nodeId: row.nodeId,
      name: row.name,
      type: row.type,
      lane: row.lane,
      attempts: row.attempts,
      ...(row.attemptsThisRevision !== undefined ? { attemptsThisRevision: row.attemptsThisRevision } : {}),
      ...(row.maxAttempts !== undefined ? { maxAttempts: row.maxAttempts } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(totalMs > 0 ? { totalMs } : {}),
      ...(usage && usage.tokens > 0 ? { tokens: usage.tokens } : {}),
      ...(usage?.cost !== undefined ? { cost: usage.cost, currency: usage.currency } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.command ? { command: row.command } : {}),
      ...(row.sessionKey ? { sessionKey: row.sessionKey } : {}),
      ...(row.loopIteration && row.loopIteration.iteration > 1 ? { loopIteration: row.loopIteration.iteration } : {}),
      ...(activity ? { activity } : {})
    });
  }
  const loops: ScheduledLoopNote[] = [];
  for (const loop of summary.loops ?? []) {
    for (const pass of loop.history) {
      loops.push({
        fromName: loop.fromName,
        toName: loop.toName,
        iteration: pass.iteration,
        at: pass.at,
        findings: pass.topFindings.map(finding => `${finding.severity}${finding.file ? ` · ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}` : ''} — ${finding.message}`)
      });
    }
  }
  return { entryId: input.entryId, workflowRunId: run.runId, stages, loops };
}
