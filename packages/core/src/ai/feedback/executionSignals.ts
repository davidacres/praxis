import type { AgentEventSummary, AgentSessionRecord } from '../agentTypes';
import type {
  FeedbackDimensionScore,
  FeedbackFinding,
  FeedbackStepRef,
  FeedbackWorkspaceHints,
  UserFeedbackInput
} from './feedbackTypes';
import { pickTestCommand } from './workspaceGrounding';

export interface ToolExecutionAnalysis {
  toolDimension: FeedbackDimensionScore;
  mcpDimension: FeedbackDimensionScore;
  outcomeDimension: FeedbackDimensionScore;
  findings: FeedbackFinding[];
  toolsUsed: string[];
  mcpToolsUsed: string[];
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  retryLoopCount: number;
  shellSearchFallbackCount: number;
  touchedPaths: string[];
  hasPostEditVerification: boolean;
  blindEditCount: number;
  failedEditCount: number;
  verificationRunCount: number;
  lastWriteStep?: number;
  /** First successful write step per touched path, for findings that cite a file. */
  pathWriteSteps: Record<string, FeedbackStepRef>;
}

const SHELL_SEARCH_COMMAND = /\b(grep|rg|ripgrep|find|ack|ag)\b/i;
const SHELL_TRACKER_COMMAND = /\b(gh\s+issue|glab\s+issue|jira\s+issue|curl\b.*\/issues)\b/i;
const VERIFICATION_SHELL_COMMAND = /\b(test|tsc|check-types|compile|build|playwright|vitest|jest|mocha|pytest|cargo\s+test|dotnet\s+test|go\s+test|npm\s+run\s+(?:test|build|check))\b/i;
const WRITE_TOOL_NAME = /\b(write_file|edit_file|edit|create_file|patch|str_replace|apply_patch|multiedit)\b/i;
const READ_SEARCH_TOOL_NAME = /\b(read_file|read|view|list_dir|search|grep|glob|find_symbol|search_code|get_source)\b/i;
const EDIT_IN_PLACE_TOOL_NAME = /\b(edit_file|edit|str_replace|str_replace_editor|multiedit|apply_patch|patch|replace)\b/i;
const SUBAGENT_TOOL_NAME = /^(task|agent|subagent|delegate|spawn_agent)$/i;
const SHELL_READ_COMMAND = /\b(cat|sed|head|tail|less|grep|rg|nl|awk)\b/;
const PATH_LIKE = /[\w@./-]+\.[A-Za-z0-9]{1,6}\b/;

function isMcpOrStructuredTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.startsWith('mcp__') ||
    lower.startsWith('mcp_') ||
    lower.startsWith('code_intelligence') ||
    lower.startsWith('tracker_') ||
    lower.startsWith('browser_') ||
    lower === 'find_symbol' ||
    lower === 'search_code' ||
    lower === 'get_callers' ||
    lower === 'get_callees' ||
    lower === 'trace_flow' ||
    lower === 'search_knowledge'
  );
}

function extractShellCommandText(event: AgentEventSummary): string {
  const data = event.data ?? {};
  const fromArgs =
    typeof data.args?.command === 'string'
      ? data.args.command
      : typeof data.args?.cmd === 'string'
        ? data.args.cmd
        : typeof data.args?.CommandLine === 'string'
          ? data.args.CommandLine
          : '';
  return [fromArgs, data.argsSummary ?? '', event.summary ?? '', event.detail ?? '']
    .filter(Boolean)
    .join(' ');
}

function isShellEvent(event: AgentEventSummary): boolean {
  const toolName = (event.data?.toolName ?? '').toLowerCase();
  return (
    event.data?.kind === 'shell' ||
    toolName === 'run_shell' ||
    toolName === 'run_command' ||
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'execute'
  );
}

function isWriteEvent(event: AgentEventSummary): boolean {
  const toolName = (event.data?.toolName ?? '').toLowerCase();
  return (
    event.data?.kind === 'write' ||
    WRITE_TOOL_NAME.test(toolName) ||
    Boolean(event.data?.fileChanges && event.data.fileChanges.length > 0)
  );
}

interface ToolCall {
  step: number;
  toolName: string;
  ok?: boolean;
  callId?: string;
  timestamp?: string;
  detail?: string;
  error?: string;
  path?: string;
  changedPaths: string[];
  /** Basenames a read/search call looked at. */
  readNames: string[];
  command: string;
  /** The command exactly as the agent issued it, for titles. */
  commandArg?: string;
  isWrite: boolean;
  isEditInPlace: boolean;
  isRead: boolean;
  isSearch: boolean;
  isShell: boolean;
}

interface FailedEditGroup {
  calls: ToolCall[];
  blind: boolean;
  resolvedBy?: ToolCall;
  readBeforeResolve: boolean;
}

function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function argPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'file_path', 'filePath', 'Path', 'target_file', 'file', 'notebook_path']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function oneLine(text: string | undefined, max = 160): string | undefined {
  const clean = text?.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function toStepRef(call: ToolCall): FeedbackStepRef {
  return {
    step: call.step,
    toolName: call.toolName,
    ...(call.detail ? { detail: call.detail } : {}),
    ...(call.ok !== undefined ? { ok: call.ok } : {}),
    ...(call.callId ? { callId: call.callId } : {}),
    ...(call.timestamp ? { timestamp: call.timestamp } : {}),
    ...(call.error ? { error: call.error } : {})
  };
}

/** `#4–#7` for a contiguous run, otherwise `#4, #6, #9`. */
function formatStepRange(calls: readonly ToolCall[]): string {
  const steps = calls.map(call => call.step);
  if (steps.length > 1 && steps.every((step, index) => index === 0 || step > steps[index - 1]) && steps.length >= 3) {
    return `#${steps[0]}–#${steps[steps.length - 1]}`;
  }
  return steps.map(step => `#${step}`).join(', ');
}

/**
 * Pairs `tool_start` / `tool_complete` events into one call each. Arguments
 * live on the start event and the outcome on the completion; a call counts at
 * its completion step (or its start when it never completed).
 */
function collectToolCalls(events: readonly AgentEventSummary[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const open: Array<{ call: ToolCall; event: AgentEventSummary }> = [];

  const build = (event: AgentEventSummary, index: number, start?: AgentEventSummary): ToolCall => {
    const data = { ...(start?.data ?? {}), ...(event.data ?? {}) };
    const args = (start?.data?.args ?? event.data?.args) as Record<string, unknown> | undefined;
    const toolName = (data.toolName ?? '').trim() || (data.kind ?? 'tool');
    const merged: AgentEventSummary = { ...event, data: { ...data, ...(args ? { args } : {}) } };
    const command = isShellEvent(merged) ? extractShellCommandText(merged) : '';
    const commandArg = ['command', 'cmd', 'CommandLine']
      .map(key => args?.[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim();
    const changedPaths = (data.fileChanges ?? []).map(change => change.path).filter(Boolean);
    const summary = oneLine(data.argsSummary ?? start?.data?.argsSummary, 120);
    const path = argPath(args) ?? changedPaths[0] ?? (summary?.match(PATH_LIKE)?.[0]);
    // What the step acted on, for transcript references: the host's summary, else the path or command
    const detail = summary ?? path ?? (commandArg ? oneLine(commandArg, 120) : undefined);
    const isWrite = isWriteEvent(merged);
    const isRead = !isWrite && (data.kind === 'read' || data.kind === 'list' || READ_SEARCH_TOOL_NAME.test(toolName));
    const isSearch = !isWrite && data.kind === 'search';
    const failed = data.ok === false || /failed|error/i.test(event.type);
    const readNames: string[] = [];
    if ((isRead || isSearch) && path) readNames.push(fileName(path));
    if (command && SHELL_READ_COMMAND.test(command)) {
      for (const match of command.match(new RegExp(PATH_LIKE.source, 'g')) ?? []) readNames.push(fileName(match));
    }
    return {
      step: index + 1,
      toolName,
      ...(failed ? { ok: false } : data.ok === true ? { ok: true } : {}),
      ...(data.callId ? { callId: data.callId } : {}),
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      ...(detail ? { detail } : {}),
      ...(failed ? { error: oneLine(data.output ?? event.detail) } : {}),
      ...(path ? { path } : {}),
      changedPaths,
      readNames,
      command,
      ...(commandArg ? { commandArg } : {}),
      isWrite,
      isEditInPlace: isWrite && (data.kind === 'write' ? EDIT_IN_PLACE_TOOL_NAME.test(toolName) || toolName === 'write' : EDIT_IN_PLACE_TOOL_NAME.test(toolName)),
      isRead: isRead || (command !== '' && SHELL_READ_COMMAND.test(command) && !SHELL_SEARCH_COMMAND.test(command)),
      isSearch,
      isShell: isShellEvent(merged)
    };
  };

  events.forEach((event, index) => {
    if (event.type === 'tool_start') {
      open.push({ call: build(event, index), event });
      return;
    }
    if (event.type !== 'tool_complete') return;
    const callId = event.data?.callId;
    const matchIndex = open.findIndex(entry =>
      callId ? entry.event.data?.callId === callId : entry.event.data?.toolName === event.data?.toolName
    );
    const start = matchIndex >= 0 ? open.splice(matchIndex, 1)[0].event : undefined;
    calls.push(build(event, index, start));
  });
  // Calls that never reported completion still count, at their start step
  for (const entry of open) calls.push(entry.call);
  return calls.sort((a, b) => a.step - b.step);
}

/**
 * Slices events to a single turn when `turnIndex` is specified, or returns all events.
 */
export function selectTurnEvents(
  events: readonly AgentEventSummary[],
  turnIndex?: number
): AgentEventSummary[] {
  if (turnIndex === undefined || turnIndex < 0) {
    return [...events];
  }
  const turns: AgentEventSummary[][] = [];
  let current: AgentEventSummary[] = [];
  for (const event of events) {
    if (event.type === 'user_input_completed' && current.length > 0) {
      turns.push(current);
      current = [event];
    } else {
      current.push(event);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns[turnIndex] ?? [...events];
}

/**
 * Evaluates:
 * - Dimension 2: Tool & Execution Efficiency (25 pts)
 * - Dimension 4: MCP & Structured Capability Leverage (15 pts)
 * - Dimension 5: Outcome & Verification Integrity (20 pts)
 */
export function analyzeExecutionSignals(input: {
  kind: 'prompt-readiness' | 'session-execution';
  promptText: string;
  session?: AgentSessionRecord;
  turnIndex?: number;
  configuredMcpServers?: readonly string[];
  codeIntelligenceAvailable?: boolean;
  trackerToolsAvailable?: boolean;
  browserToolsAvailable?: boolean;
  userFeedback?: UserFeedbackInput;
  workspaceHints?: FeedbackWorkspaceHints;
}): ToolExecutionAnalysis {
  const findings: FeedbackFinding[] = [];
  const configuredMcps = [...new Set((input.configuredMcpServers ?? []).map(s => s.trim()).filter(Boolean))];
  const hasCodeIntel = input.codeIntelligenceAvailable !== false;
  const hasTracker = Boolean(input.trackerToolsAvailable || input.session?.connectionId);

  // Pre-send prompt readiness mode has no execution events yet
  if (input.kind === 'prompt-readiness' || !input.session) {
    const mcpMax = 15;
    let mcpEarned = 15;
    const text = input.promptText.trim();
    const mentionsRawShellSearch = /\b(use grep|run grep|run find|use curl)\b/i.test(text);
    if (mentionsRawShellSearch && hasCodeIntel) {
      const deduction = 5;
      mcpEarned -= deduction;
      findings.push({
        id: 'prompt-shell-search-instead-of-mcp',
        dimension: 'mcp-leverage',
        severity: 'info',
        deltaPoints: -deduction,
        title: 'Prompt asks for raw shell search instead of Code Intelligence MCP',
        evidence: 'Prompt explicitly instructs running `grep`/`find`/`curl` while structured `code_intelligence` tools are available.',
        remediation: {
          kind: 'enable-mcp',
          label: 'Prefer code_intelligence Tools',
          description: 'Use `find_symbol`, `search_code`, or `search_knowledge` instead of raw shell `grep`.',
          targetId: 'code_intelligence',
          suggestedPromptSnippet: 'Use `code_intelligence` (`find_symbol`, `search_code`) for symbol and codebase lookups.'
        }
      });
    }

    return {
      toolDimension: {
        dimension: 'tool-efficiency',
        label: 'Tool & Execution Efficiency',
        earnedPoints: 25,
        maxPoints: 25,
        normalizedScore: 100,
        summary: 'Pre-send check (evaluated after session execution).'
      },
      mcpDimension: {
        dimension: 'mcp-leverage',
        label: 'MCP & Capability Readiness',
        earnedPoints: mcpEarned,
        maxPoints: mcpMax,
        normalizedScore: Math.round((mcpEarned / mcpMax) * 100),
        summary:
          mcpEarned === mcpMax
            ? `Ready (${[hasCodeIntel ? 'code_intelligence' : '', ...configuredMcps].filter(Boolean).join(', ') || 'standard tools'}).`
            : findings.map(f => f.title).join('; ')
      },
      outcomeDimension: {
        dimension: 'outcome-verification',
        label: 'Outcome & Verification',
        earnedPoints: 20,
        maxPoints: 20,
        normalizedScore: 100,
        summary: 'Pre-send check (evaluated after session execution).'
      },
      findings,
      toolsUsed: [],
      mcpToolsUsed: [],
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      retryLoopCount: 0,
      shellSearchFallbackCount: 0,
      touchedPaths: [],
      hasPostEditVerification: false,
      blindEditCount: 0,
      failedEditCount: 0,
      verificationRunCount: 0,
      pathWriteSteps: {}
    };
  }

  const events = selectTurnEvents(input.session.events ?? [], input.turnIndex);
  const calls = collectToolCalls(events);
  const toolsUsedSet = new Set<string>();
  const mcpToolsUsedSet = new Set<string>();
  const touchedPathsSet = new Set<string>();
  const pathWriteSteps: Record<string, FeedbackStepRef> = {};

  let permissionRequestCount = 0;
  let undoEditCount = 0;
  for (const event of events) {
    if (event.type === 'permission_requested') permissionRequestCount += 1;
    if (event.type === 'info' && /You undid the edit to/i.test(event.summary ?? '')) undoEditCount += 1;
  }

  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let mcpFailedCalls = 0;
  let readOrSearchCount = 0;
  let writeCount = 0;
  let lastWriteCall: ToolCall | undefined;
  let lastSuccessfulVerification: ToolCall | undefined;
  let lastVerificationAttempt: ToolCall | undefined;
  let verificationRunCount = 0;
  const shellSearchCalls: ToolCall[] = [];
  let shellTrackerFallbackCount = 0;
  let usedSubagent = false;

  // Root-cause bookkeeping, keyed by file basename (hosts mix absolute and relative paths)
  const readNames = new Set<string>();
  const openFailedRuns = new Map<string, { calls: ToolCall[]; blind: boolean }>();
  const failedEditGroups: FailedEditGroup[] = [];
  const isolatedBlindEdits: ToolCall[] = [];
  const successfulWritesByName = new Map<string, ToolCall[]>();

  const closeRun = (name: string, resolvedBy?: ToolCall, readFirst = false) => {
    const run = openFailedRuns.get(name);
    openFailedRuns.delete(name);
    if (run && run.calls.length >= 2) {
      failedEditGroups.push({ ...run, ...(resolvedBy ? { resolvedBy } : {}), readBeforeResolve: readFirst });
    }
  };

  for (const call of calls) {
    toolsUsedSet.add(call.toolName);
    if (isMcpOrStructuredTool(call.toolName)) mcpToolsUsedSet.add(call.toolName);
    if (SUBAGENT_TOOL_NAME.test(call.toolName)) usedSubagent = true;
    if (call.ok === false) {
      failedToolCalls += 1;
      if (isMcpOrStructuredTool(call.toolName)) mcpFailedCalls += 1;
    } else {
      successfulToolCalls += 1;
    }

    const name = call.path ? fileName(call.path) : undefined;

    if (call.isWrite) {
      for (const changed of call.changedPaths) touchedPathsSet.add(changed);
      if (call.path) touchedPathsSet.add(call.path);
      if (name) {
        const blind = call.isEditInPlace && !readNames.has(name);
        if (call.ok === false) {
          const run = openFailedRuns.get(name) ?? { calls: [], blind };
          run.calls.push(call);
          openFailedRuns.set(name, run);
        } else {
          if (openFailedRuns.has(name)) {
            closeRun(name, call, readNames.has(name));
          } else if (blind) {
            isolatedBlindEdits.push(call);
          }
          const writes = successfulWritesByName.get(name) ?? [];
          writes.push(call);
          successfulWritesByName.set(name, writes);
          if (call.path && !pathWriteSteps[call.path]) pathWriteSteps[call.path] = toStepRef(call);
        }
      }
      if (call.ok !== false) {
        writeCount += 1;
        lastWriteCall = call;
      }
      continue;
    }

    if (call.isRead || call.isSearch) {
      readOrSearchCount += 1;
      for (const readName of call.readNames) readNames.add(readName);
      // A read between failed edits ends a blind run; the next success is "after reading"
      for (const readName of call.readNames) {
        const run = openFailedRuns.get(readName);
        if (run && run.calls.length < 2) openFailedRuns.delete(readName);
      }
    }

    if (call.isShell) {
      const cmd = call.command;
      if (SHELL_SEARCH_COMMAND.test(cmd) && !VERIFICATION_SHELL_COMMAND.test(cmd)) shellSearchCalls.push(call);
      if (SHELL_TRACKER_COMMAND.test(cmd)) shellTrackerFallbackCount += 1;
      if (VERIFICATION_SHELL_COMMAND.test(cmd)) {
        verificationRunCount += 1;
        lastVerificationAttempt = call;
        if (call.ok !== false) lastSuccessfulVerification = call;
      }
    }
  }
  for (const name of [...openFailedRuns.keys()]) closeRun(name);

  const attributedSteps = new Set<number>();
  for (const group of failedEditGroups) for (const call of group.calls) attributedSteps.add(call.step);

  // ── Dimension 2: Tool & Execution Efficiency (max 25) ───────────────────
  const toolMax = 25;
  let toolEarned = toolMax;
  const totalToolCalls = calls.length;

  // Root cause: the same file edit failing repeatedly (worst two groups)
  const rankedGroups = [...failedEditGroups].sort(
    (a, b) => b.calls.length - a.calls.length || a.calls[0].step - b.calls[0].step
  );
  for (const group of rankedGroups.slice(0, 2)) {
    const first = group.calls[0];
    const name = fileName(first.path ?? '');
    const count = group.calls.length;
    const deduction = Math.min(8, 2 + count * 2);
    toolEarned -= deduction;
    const recovery = group.resolvedBy
      ? group.readBeforeResolve
        ? ` and only succeeded after reading it on step #${group.resolvedBy.step}.`
        : `; step #${group.resolvedBy.step} finally applied it.`
      : ' and never recovered.';
    const errorNote = first.error ? ` Error: ${first.error}` : '';
    findings.push({
      id: `${group.blind ? 'tool-blind-edit-loop' : 'tool-edit-retry-loop'}:${name}`,
      dimension: 'tool-efficiency',
      severity: 'critical',
      deltaPoints: -deduction,
      title: group.blind
        ? `Blind edit failed ${count}× on \`${name}\``
        : `\`${first.toolName}\` failed ${count}× in a row on \`${name}\``,
      evidence: group.blind
        ? `Called \`${first.toolName}\` ${count} times before reading the file${recovery}${errorNote}`
        : `Retried the same edit without re-reading the current file contents${recovery}${errorNote}`,
      stepIndices: group.calls.map(call => call.step),
      steps: group.calls.map(toStepRef),
      remediation: {
        kind: 'pin-file',
        label: `Pin @${name}`,
        description: `Have the next turn read \`${first.path}\` before editing it.`,
        targetId: first.path,
        suggestedPromptSnippet: `Read @${first.path} before editing it.`
      }
    });
  }

  // Root cause: edits applied to files the agent never read (succeeded, but by luck)
  if (isolatedBlindEdits.length > 0) {
    const deduction = Math.min(4, isolatedBlindEdits.length * 2);
    toolEarned -= deduction;
    const names = [...new Set(isolatedBlindEdits.map(call => fileName(call.path ?? '')))];
    findings.push({
      id: 'tool-blind-edits',
      dimension: 'tool-efficiency',
      severity: 'info',
      deltaPoints: -deduction,
      title: `${isolatedBlindEdits.length} ${isolatedBlindEdits.length === 1 ? 'edit' : 'edits'} made without reading the file first`,
      evidence: `Edited ${names.slice(0, 3).map(n => `\`${n}\``).join(', ')} without a prior read, so the change was applied to contents the agent had not seen.`,
      stepIndices: isolatedBlindEdits.map(call => call.step),
      steps: isolatedBlindEdits.map(toStepRef),
      remediation: {
        kind: 'avoid-tool-pattern',
        label: 'Read before editing',
        description: 'Read the target section of a file before editing it in place.',
        suggestedPromptSnippet: 'Read each file before editing it.'
      }
    });
  }

  // Root cause: thrashing on one file
  const thrashed = [...successfulWritesByName.entries()]
    .filter(([, writes]) => writes.length >= 5)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (thrashed) {
    const [name, writes] = thrashed;
    const deduction = 3;
    toolEarned -= deduction;
    const targetPath = writes[0].path ?? name;
    findings.push({
      id: `tool-file-thrash:${name}`,
      dimension: 'tool-efficiency',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Edited \`${name}\` ${writes.length}× in one ${input.turnIndex !== undefined ? 'turn' : 'session'}`,
      evidence: `Repeated small edits to the same file suggest the change was not planned before editing.`,
      stepIndices: writes.map(call => call.step),
      steps: writes.map(toStepRef),
      remediation: {
        kind: 'refine-prompt',
        label: 'Plan, then edit once',
        description: `Plan all changes to \`${targetPath}\` first, then apply them in one pass and typecheck once.`,
        suggestedPromptSnippet: `Plan all changes to @${targetPath} before editing, then apply them in one pass.`
      }
    });
  }

  // Remaining failures not explained by a root cause above
  const unattributedFailures = calls.filter(call => call.ok === false && !attributedSteps.has(call.step));
  if (unattributedFailures.length > 0 && totalToolCalls > 0) {
    const failureRate = unattributedFailures.length / totalToolCalls;
    const deduction = Math.min(10, Math.max(2, Math.round(failureRate * 15) + (unattributedFailures.length >= 3 ? 2 : 0)));
    toolEarned -= deduction;
    const toolNames = [...new Set(unattributedFailures.map(call => call.toolName))];
    const first = unattributedFailures[0];
    findings.push({
      id: 'tool-failed-calls',
      dimension: 'tool-efficiency',
      severity: unattributedFailures.length >= 3 ? 'critical' : 'warning',
      deltaPoints: -deduction,
      title: toolNames.length === 1
        ? `\`${toolNames[0]}\` failed ${unattributedFailures.length}×`
        : `${unattributedFailures.length} of ${totalToolCalls} tool calls failed`,
      evidence: `First failure on step #${first.step}${first.detail ? ` (${first.detail})` : ''}${first.error ? `: ${first.error}` : '.'}`,
      stepIndices: unattributedFailures.map(call => call.step),
      steps: unattributedFailures.map(toStepRef),
      remediation: {
        kind: 'avoid-tool-pattern',
        label: 'Inspect before retrying',
        description: 'Read the error and the current state before calling the tool again.',
        suggestedPromptSnippet: 'If a tool call fails, read the error and inspect the current state before retrying.'
      }
    });

    // Identical failing calls in a row, among the unexplained failures
    const loopSteps: ToolCall[] = [];
    let streak: ToolCall[] = [];
    for (const call of calls) {
      if (attributedSteps.has(call.step)) continue;
      const previous = streak[streak.length - 1];
      if (call.ok === false && previous && previous.toolName === call.toolName) {
        streak.push(call);
      } else {
        if (streak.length >= 3) loopSteps.push(...streak);
        streak = call.ok === false ? [call] : [];
      }
    }
    if (streak.length >= 3) loopSteps.push(...streak);
    if (loopSteps.length > 0) {
      const loopDeduction = Math.min(8, 1 + loopSteps.length * 2);
      toolEarned -= loopDeduction;
      findings.push({
        id: 'tool-retry-loop',
        dimension: 'tool-efficiency',
        severity: 'critical',
        deltaPoints: -loopDeduction,
        title: `\`${loopSteps[0].toolName}\` retried ${loopSteps.length}× without changing approach`,
        evidence: `Steps ${formatStepRange(loopSteps)} repeated a failing call${loopSteps[0].detail ? ` (${loopSteps[0].detail})` : ''}.`,
        stepIndices: loopSteps.map(call => call.step),
        steps: loopSteps.map(toStepRef),
        remediation: {
          kind: 'avoid-tool-pattern',
          label: 'Break retry loops early',
          description: 'Stop repeating identical failing tool calls; inspect file state or error output first.'
        }
      });
    }
  }

  if (readOrSearchCount >= 25 && !usedSubagent) {
    const deduction = 3;
    toolEarned -= deduction;
    findings.push({
      id: 'tool-read-sprawl',
      dimension: 'tool-efficiency',
      severity: 'info',
      deltaPoints: -deduction,
      title: `${readOrSearchCount} serial reads in the main context`,
      evidence: `Exploration ran ${readOrSearchCount} read/search calls in the main conversation instead of a delegated subagent.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Delegate exploration',
        description: 'Hand broad exploration to a research subagent and keep the main context for the change.',
        suggestedPromptSnippet: 'Delegate broad codebase exploration to a subagent and report back only what matters.'
      }
    });
  } else if (readOrSearchCount > 12 && writeCount > 0 && readOrSearchCount / Math.max(1, writeCount) > 8) {
    const deduction = 4;
    toolEarned -= deduction;
    findings.push({
      id: 'tool-high-read-churn',
      dimension: 'tool-efficiency',
      severity: 'info',
      deltaPoints: -deduction,
      title: `High read/search-to-edit churn (${readOrSearchCount} reads vs ${writeCount} edits)`,
      evidence: `Session executed ${readOrSearchCount} read/search calls for ${writeCount} file ${writeCount === 1 ? 'edit' : 'edits'}.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Narrow Initial File Scope',
        description: 'Include target file paths in the prompt or use `code_intelligence` to jump directly to definitions.'
      }
    });
  }

  if (permissionRequestCount >= 3) {
    const deduction = 3;
    toolEarned -= deduction;
    findings.push({
      id: 'tool-permission-friction',
      dimension: 'tool-efficiency',
      severity: 'info',
      deltaPoints: -deduction,
      title: `Repeated permission prompts (${permissionRequestCount} requests)`,
      evidence: `Session paused ${permissionRequestCount} times waiting for tool approval.`,
      remediation: {
        kind: 'change-tool-mode',
        label: 'Use Autopilot Permission Mode',
        description: 'Switch permission policy to Autopilot when running trusted multi-step tasks.'
      }
    });
  }

  const maxSteps = input.session.taskDefinition?.maxSteps ?? 500;
  if (input.session.stepCount > 0 && maxSteps > 0 && input.session.stepCount / maxSteps >= 0.8) {
    const deduction = 3;
    toolEarned -= deduction;
    findings.push({
      id: 'tool-step-budget-exhaustion',
      dimension: 'tool-efficiency',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Near step-budget ceiling (${input.session.stepCount}/${maxSteps} steps)`,
      evidence: `Session consumed ${Math.round((input.session.stepCount / maxSteps) * 100)}% of its step budget.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Split Into Focused Subtasks',
        description: 'Decompose large multi-stage goals into smaller tasks or a governed workflow.'
      }
    });
  }

  toolEarned = Math.max(0, Math.min(toolMax, toolEarned));

  // ── Dimension 4: MCP & Structured Capability Leverage (max 15) ──────────
  const mcpMax = 15;
  let mcpEarned = mcpMax;
  const shellSearchFallbackCount = shellSearchCalls.length;
  const shellSearchStepIndices = shellSearchCalls.map(call => call.step);

  if (shellSearchFallbackCount > 0 && hasCodeIntel && mcpToolsUsedSet.size === 0) {
    const deduction = Math.min(10, 4 + shellSearchFallbackCount * 1);
    mcpEarned -= deduction;
    findings.push({
      id: 'mcp-shell-grep-workaround',
      dimension: 'mcp-leverage',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Shell \`grep\` used ${shellSearchFallbackCount}× while \`code_intelligence\` was online`,
      evidence: `Spawned ${shellSearchFallbackCount} shell ${shellSearchFallbackCount === 1 ? 'search' : 'searches'} (steps ${formatStepRange(shellSearchCalls)}) instead of calling \`find_symbol\` / \`search_code\`.`,
      stepIndices: shellSearchStepIndices,
      steps: shellSearchCalls.map(toStepRef),
      remediation: {
        kind: 'enable-mcp',
        label: 'Prefer code_intelligence',
        description: 'Prefer `search_code`, `find_symbol`, and `get_callers` over raw shell `grep`/`find`.',
        targetId: 'code_intelligence',
        suggestedPromptSnippet: 'Use `code_intelligence` (`find_symbol`, `search_code`) instead of shell `grep`.'
      }
    });
  } else if (shellSearchFallbackCount >= 3 && hasCodeIntel) {
    const deduction = 4;
    mcpEarned -= deduction;
    findings.push({
      id: 'mcp-partial-shell-search',
      dimension: 'mcp-leverage',
      severity: 'info',
      deltaPoints: -deduction,
      title: `Mixed ${shellSearchFallbackCount} raw shell searches with structured tools`,
      evidence: `Steps ${formatStepRange(shellSearchCalls)} fell back to shell search.`,
      stepIndices: shellSearchStepIndices,
      steps: shellSearchCalls.map(toStepRef),
      remediation: {
        kind: 'enable-mcp',
        label: 'Prefer Structured Search',
        description: 'Reach for `code_intelligence` first for symbol definitions and call hierarchies.',
        targetId: 'code_intelligence'
      }
    });
  }

  if (shellTrackerFallbackCount > 0 && hasTracker) {
    const deduction = 5;
    mcpEarned -= deduction;
    findings.push({
      id: 'mcp-shell-tracker-workaround',
      dimension: 'mcp-leverage',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'Used shell CLI for issue tracking instead of `tracker_*` MCP tools',
      evidence: `Observed ${shellTrackerFallbackCount} shell tracker CLI call(s) when built-in \`tracker_get_ticket\` / \`tracker_transition_ticket\` tools were available.`,
      remediation: {
        kind: 'enable-mcp',
        label: 'Use tracker_* MCP Tools',
        description: 'Use `tracker_get_ticket`, `tracker_update_ticket`, and `tracker_transition_ticket` for board operations.',
        targetId: 'tracker'
      }
    });
  }

  if (mcpFailedCalls > 0) {
    const deduction = Math.min(5, mcpFailedCalls * 2);
    mcpEarned -= deduction;
    findings.push({
      id: 'mcp-call-failures',
      dimension: 'mcp-leverage',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `${mcpFailedCalls} structured/MCP tool ${mcpFailedCalls === 1 ? 'call' : 'calls'} failed`,
      evidence: `MCP or structured tool invocations returned ${mcpFailedCalls} error(s).`,
      remediation: {
        kind: 'avoid-tool-pattern',
        label: 'Check MCP Tool Schema',
        description: 'Verify required MCP arguments (such as repository name or issueKey) before calling.'
      }
    });
  }

  if (input.userFeedback?.frictionTags?.includes('missed-mcp')) {
    const deduction = 4;
    mcpEarned -= deduction;
    findings.push({
      id: 'user-flagged-missed-mcp',
      dimension: 'mcp-leverage',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'User feedback flagged missed MCP server / structured tool',
      evidence: input.userFeedback.notes?.trim()
        ? `User note: "${input.userFeedback.notes.trim()}"`
        : 'User marked `missed-mcp` in session feedback.',
      remediation: {
        kind: 'enable-mcp',
        label: 'Name Required MCP in Prompt',
        description: 'Explicitly instruct the agent which MCP server or tool to invoke first.'
      }
    });
  }


  mcpEarned = Math.max(0, Math.min(mcpMax, mcpEarned));

  // ── Dimension 5: Outcome & Verification Integrity (max 20) ──────────────
  const outcomeMax = 20;
  let outcomeEarned = outcomeMax;
  const hasPostEditVerification =
    writeCount === 0 || Boolean(lastSuccessfulVerification && lastWriteCall && lastSuccessfulVerification.step > lastWriteCall.step);
  const unresolvedVerification =
    lastVerificationAttempt && lastVerificationAttempt.ok === false && lastVerificationAttempt !== lastSuccessfulVerification
      ? lastVerificationAttempt
      : undefined;

  if (input.session.state === 'failed') {
    const deduction = 10;
    outcomeEarned -= deduction;
    findings.push({
      id: 'outcome-session-failed',
      dimension: 'outcome-verification',
      severity: 'critical',
      deltaPoints: -deduction,
      title: 'Session terminated in `failed` state',
      evidence: input.session.lastError
        ? `Terminal error: ${input.session.lastError}`
        : 'Session ended with a failure state before completing the goal.',
      remediation: {
        kind: 'refine-prompt',
        label: 'Retry With Scoped Recovery Prompt',
        description: 'Address the terminal error or narrow the task scope before re-running.'
      }
    });
  } else if (input.session.state === 'aborted') {
    const deduction = 6;
    outcomeEarned -= deduction;
    findings.push({
      id: 'outcome-session-aborted',
      dimension: 'outcome-verification',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'Session was aborted before completion',
      evidence: 'Execution was stopped mid-flight before reaching a verified terminal outcome.',
      remediation: {
        kind: 'refine-prompt',
        label: 'Resume With Focused Prompt',
        description: 'Continue from the completed steps and state the remaining verification check.'
      }
    });
  }

  if (unresolvedVerification) {
    const deduction = 6;
    outcomeEarned -= deduction;
    const command = (unresolvedVerification.commandArg ?? unresolvedVerification.detail ?? unresolvedVerification.toolName).slice(0, 80);
    findings.push({
      id: 'outcome-unresolved-failure',
      dimension: 'outcome-verification',
      severity: 'critical',
      deltaPoints: -deduction,
      title: `\`${command}\` failed and was never fixed`,
      evidence: `Step #${unresolvedVerification.step} exited with a failure and the turn ended without a passing re-run${unresolvedVerification.error ? `: ${unresolvedVerification.error}` : '.'}`,
      stepIndices: [unresolvedVerification.step],
      steps: [toStepRef(unresolvedVerification)],
      remediation: {
        kind: 'add-test-command',
        label: `Re-run ${command.length > 32 ? `${command.slice(0, 32)}…` : command}`,
        description: 'Fix the failure and re-run the same command until it passes.',
        targetId: command,
        suggestedPromptSnippet: `Fix the failure from \`${command}\` and re-run it until it passes.`
      }
    });
  } else if (writeCount > 0 && !hasPostEditVerification && lastWriteCall) {
    const deduction = 6;
    outcomeEarned -= deduction;
    const touched = [...touchedPathsSet];
    const testCommand = pickTestCommand(input.promptText, input.workspaceHints, touched);
    findings.push({
      id: 'outcome-unverified-writes',
      dimension: 'outcome-verification',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Final edit (step #${lastWriteCall.step}) not followed by a test or typecheck`,
      evidence: `Wrote ${writeCount} file ${writeCount === 1 ? 'edit' : 'edits'} (${touched.slice(0, 3).map(fileName).join(', ')}) and finished without running a check after the last write.`,
      stepIndices: [lastWriteCall.step],
      steps: [toStepRef(lastWriteCall)],
      remediation: testCommand
        ? {
            kind: 'add-test-command',
            label: `Run ${testCommand.label}`,
            description: `Run \`${testCommand.command}\` after the final edit.`,
            targetId: testCommand.command,
            suggestedPromptSnippet: `Run \`${testCommand.command}\` and fix anything it reports.`
          }
        : {
            kind: 'add-verification',
            label: 'Run typecheck & tests',
            description: 'Run the typecheck or relevant tests after the last file write.',
            suggestedPromptSnippet: 'Run the typecheck and the relevant tests after the final edit.'
          }
    });
  }

  if (undoEditCount > 0) {
    const deduction = Math.min(6, undoEditCount * 3);
    outcomeEarned -= deduction;
    findings.push({
      id: 'outcome-user-undid-edits',
      dimension: 'outcome-verification',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `User reverted ${undoEditCount} agent file ${undoEditCount === 1 ? 'edit' : 'edits'}`,
      evidence: `Transcript records ${undoEditCount} \`undoToolFileChange\` action(s) by the user.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Constrain Allowed Files',
        description: 'Specify which files may be modified and which files must remain untouched.'
      }
    });
  }

  // Incorporate explicit human feedback verdict & friction tags deterministically
  if (input.userFeedback) {
    const { verdict, frictionTags = [], notes } = input.userFeedback;
    if (verdict === 'failed-goal') {
      const deduction = 10;
      outcomeEarned -= deduction;
      findings.push({
        id: 'user-verdict-failed-goal',
        dimension: 'outcome-verification',
        severity: 'critical',
        deltaPoints: -deduction,
        title: 'User rated session outcome as Failed Goal',
        evidence: notes?.trim() ? `User feedback: "${notes.trim()}"` : 'User submitted a `failed-goal` verdict.',
        remediation: {
          kind: 'refine-prompt',
          label: 'Apply User Feedback to Follow-Up',
          description: notes?.trim()
            ? `Address user feedback: ${notes.trim()}`
            : 'Re-run with explicit acceptance criteria and recommended skills.'
        }
      });
    } else if (verdict === 'needs-work') {
      const deduction = 5;
      outcomeEarned -= deduction;
      findings.push({
        id: 'user-verdict-needs-work',
        dimension: 'outcome-verification',
        severity: 'warning',
        deltaPoints: -deduction,
        title: 'User rated session outcome as Needs Work',
        evidence: notes?.trim() ? `User feedback: "${notes.trim()}"` : 'User submitted a `needs-work` verdict.',
        remediation: {
          kind: 'refine-prompt',
          label: 'Apply User Feedback to Follow-Up',
          description: notes?.trim()
            ? `Address user feedback: ${notes.trim()}`
            : 'Refine the follow-up prompt using the flagged friction items.'
        }
      });
    }

    const extraTags = frictionTags.filter(
      tag => tag === 'wrong-scope' || tag === 'ignored-instructions' || tag === 'unverified-changes' || tag === 'wasted-steps'
    );
    if (extraTags.length > 0) {
      const deduction = Math.min(6, extraTags.length * 2);
      outcomeEarned -= deduction;
      findings.push({
        id: 'user-friction-tags',
        dimension: 'outcome-verification',
        severity: 'warning',
        deltaPoints: -deduction,
        title: `User flagged friction: ${extraTags.join(', ')}`,
        evidence: notes?.trim()
          ? `Tags [${extraTags.join(', ')}] — "${notes.trim()}"`
          : `User tagged session with: ${extraTags.join(', ')}.`,
        remediation: {
          kind: 'refine-prompt',
          label: 'Tighten Guardrails in Follow-Up',
          description: `Add explicit constraints addressing: ${extraTags.join(', ')}.`
        }
      });
    }
  }

  outcomeEarned = Math.max(0, Math.min(outcomeMax, outcomeEarned));

  return {
    toolDimension: {
      dimension: 'tool-efficiency',
      label: 'Tool & Execution Efficiency',
      earnedPoints: toolEarned,
      maxPoints: toolMax,
      normalizedScore: Math.round((toolEarned / toolMax) * 100),
      summary:
        toolEarned === toolMax
          ? `${totalToolCalls} tool ${totalToolCalls === 1 ? 'call' : 'calls'}, 0 failures, 0 retry loops.`
          : `${successfulToolCalls}/${totalToolCalls} succeeded · ${failedToolCalls} failed.`
    },
    mcpDimension: {
      dimension: 'mcp-leverage',
      label: 'MCP & Capability Leverage',
      earnedPoints: mcpEarned,
      maxPoints: mcpMax,
      normalizedScore: Math.round((mcpEarned / mcpMax) * 100),
      summary:
        mcpEarned === mcpMax
          ? mcpToolsUsedSet.size > 0
            ? `Used structured MCP tools (${[...mcpToolsUsedSet].slice(0, 3).join(', ')}).`
            : 'No raw shell workarounds detected.'
          : `${mcpToolsUsedSet.size} MCP calls · ${shellSearchFallbackCount} raw shell search ${shellSearchFallbackCount === 1 ? 'call' : 'calls'}.`
    },
    outcomeDimension: {
      dimension: 'outcome-verification',
      label: 'Outcome & Verification',
      earnedPoints: outcomeEarned,
      maxPoints: outcomeMax,
      normalizedScore: Math.round((outcomeEarned / outcomeMax) * 100),
      summary:
        outcomeEarned === outcomeMax
          ? 'Session completed cleanly with verified changes.'
          : findings
              .filter(f => f.dimension === 'outcome-verification')
              .map(f => f.title)
              .join('; ')
    },
    findings,
    toolsUsed: [...toolsUsedSet].sort(),
    mcpToolsUsed: [...mcpToolsUsedSet].sort(),
    totalToolCalls,
    successfulToolCalls,
    failedToolCalls,
    retryLoopCount: findings.filter(f => f.id === 'tool-retry-loop' || f.id.startsWith('tool-blind-edit-loop:') || f.id.startsWith('tool-edit-retry-loop:')).length,
    shellSearchFallbackCount,
    touchedPaths: [...touchedPathsSet].sort(),
    hasPostEditVerification,
    blindEditCount: isolatedBlindEdits.length + failedEditGroups.filter(group => group.blind).length,
    failedEditCount: failedEditGroups.reduce((sum, group) => sum + group.calls.length, 0),
    verificationRunCount,
    ...(lastWriteCall ? { lastWriteStep: lastWriteCall.step } : {}),
    pathWriteSteps
  };
}
