import type { AgentEventSummary, AgentSessionRecord } from '../agentTypes';
import type {
  FeedbackDimensionScore,
  FeedbackFinding,
  UserFeedbackInput
} from './feedbackTypes';

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
}

const SHELL_SEARCH_COMMAND = /\b(grep|rg|ripgrep|find|ack|ag)\b/i;
const SHELL_TRACKER_COMMAND = /\b(gh\s+issue|glab\s+issue|jira\s+issue|curl\b.*\/issues)\b/i;
const VERIFICATION_SHELL_COMMAND = /\b(test|tsc|check-types|compile|build|playwright|vitest|jest|mocha|pytest|cargo\s+test|dotnet\s+test|go\s+test|npm\s+run\s+(?:test|build|check))\b/i;
const WRITE_TOOL_NAME = /\b(write_file|edit_file|edit|create_file|patch|str_replace|apply_patch|multiedit)\b/i;
const READ_SEARCH_TOOL_NAME = /\b(read_file|list_dir|search|grep|find_symbol|search_code|get_source)\b/i;

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
}): ToolExecutionAnalysis {
  const findings: FeedbackFinding[] = [];
  const configuredMcps = [...new Set((input.configuredMcpServers ?? []).map(s => s.trim()).filter(Boolean))];
  const hasCodeIntel = input.codeIntelligenceAvailable !== false;
  const hasTracker = Boolean(input.trackerToolsAvailable || input.session?.connectionId);

  // Pre-send prompt readiness mode has no execution events yet
  if (input.kind === 'prompt-readiness' || !input.session) {
    let mcpMax = 15;
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
      hasPostEditVerification: false
    };
  }

  const events = selectTurnEvents(input.session.events ?? [], input.turnIndex);
  const toolsUsedSet = new Set<string>();
  const mcpToolsUsedSet = new Set<string>();
  const touchedPathsSet = new Set<string>();

  let totalToolCalls = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let mcpFailedCalls = 0;
  let retryLoopCount = 0;
  const retryStepIndices: number[] = [];
  let shellSearchFallbackCount = 0;
  const shellSearchStepIndices: number[] = [];
  let shellTrackerFallbackCount = 0;
  let readOrSearchCount = 0;
  let writeCount = 0;
  let lastWriteEventIndex = -1;
  let lastVerificationEventIndex = -1;
  let permissionRequestCount = 0;
  let undoEditCount = 0;

  // Track consecutive identical/near-identical tool calls for retry-loop detection
  let prevToolSig = '';
  let prevToolFailed = false;
  let currentStreak = 0;

  events.forEach((event, idx) => {
    const stepNumber = idx + 1;
    if (event.type === 'permission_requested') {
      permissionRequestCount += 1;
    }
    if (event.type === 'info' && /You undid the edit to/i.test(event.summary ?? '')) {
      undoEditCount += 1;
    }

    if (event.type === 'tool_start' || event.type === 'tool_complete') {
      const toolName = (event.data?.toolName ?? '').trim() || (event.data?.kind ?? 'tool');
      toolsUsedSet.add(toolName);
      if (isMcpOrStructuredTool(toolName)) {
        mcpToolsUsedSet.add(toolName);
      }

      for (const change of event.data?.fileChanges ?? []) {
        if (change.path) touchedPathsSet.add(change.path);
      }
      if (typeof event.data?.args?.path === 'string' && isWriteEvent(event)) {
        touchedPathsSet.add(event.data.args.path);
      }
      if (typeof event.data?.args?.Path === 'string' && isWriteEvent(event)) {
        touchedPathsSet.add(event.data.args.Path);
      }
    }

    // Count each tool invocation once (prefer `tool_complete`, or `tool_start` if no matching `tool_complete` exists)
    const isCountedToolStep =
      event.type === 'tool_complete' ||
      (event.type === 'tool_start' &&
        !events.some(
          (later, laterIdx) =>
            laterIdx > idx &&
            later.type === 'tool_complete' &&
            ((event.data?.callId && later.data?.callId === event.data.callId) ||
              (!event.data?.callId && later.data?.toolName === event.data?.toolName))
        ));

    if (!isCountedToolStep) return;

    const toolName = (event.data?.toolName ?? '').trim() || (event.data?.kind ?? 'tool');
    totalToolCalls += 1;
    const failed = event.data?.ok === false || /failed|error/i.test(event.type);
    if (failed) {
      failedToolCalls += 1;
      if (isMcpOrStructuredTool(toolName)) {
        mcpFailedCalls += 1;
      }
    } else {
      successfulToolCalls += 1;
    }

    const argsKey = (event.data?.argsSummary ?? JSON.stringify(event.data?.args ?? {})).slice(0, 80);
    const sig = `${toolName}:${argsKey}`;
    if (failed && (sig === prevToolSig || (prevToolFailed && toolName === prevToolSig.split(':')[0]))) {
      currentStreak += 1;
      if (currentStreak >= 2) {
        retryLoopCount += 1;
        retryStepIndices.push(stepNumber);
      }
    } else {
      currentStreak = failed ? 1 : 0;
    }
    prevToolSig = sig;
    prevToolFailed = failed;

    if (isWriteEvent(event) && !failed) {
      writeCount += 1;
      lastWriteEventIndex = idx;
    } else if (
      event.data?.kind === 'read' ||
      event.data?.kind === 'search' ||
      event.data?.kind === 'list' ||
      READ_SEARCH_TOOL_NAME.test(toolName)
    ) {
      readOrSearchCount += 1;
    }

    if (isShellEvent(event)) {
      const cmd = extractShellCommandText(event);
      if (SHELL_SEARCH_COMMAND.test(cmd) && !VERIFICATION_SHELL_COMMAND.test(cmd)) {
        shellSearchFallbackCount += 1;
        shellSearchStepIndices.push(stepNumber);
      }
      if (SHELL_TRACKER_COMMAND.test(cmd)) {
        shellTrackerFallbackCount += 1;
      }
      if (VERIFICATION_SHELL_COMMAND.test(cmd) && !failed) {
        lastVerificationEventIndex = idx;
      }
    }
  });

  // ── Dimension 2: Tool & Execution Efficiency (max 25) ───────────────────
  const toolMax = 25;
  let toolEarned = toolMax;

  if (failedToolCalls > 0 && totalToolCalls > 0) {
    const failureRate = failedToolCalls / totalToolCalls;
    const deduction = Math.min(10, Math.max(2, Math.round(failureRate * 15) + (failedToolCalls >= 3 ? 2 : 0)));
    toolEarned -= deduction;
    findings.push({
      id: 'tool-failed-calls',
      dimension: 'tool-efficiency',
      severity: failedToolCalls >= 3 ? 'critical' : 'warning',
      deltaPoints: -deduction,
      title: `${failedToolCalls} of ${totalToolCalls} tool ${totalToolCalls === 1 ? 'call' : 'calls'} failed`,
      evidence: `Observed ${failedToolCalls} failed tool ${failedToolCalls === 1 ? 'invocation' : 'invocations'} (${Math.round(failureRate * 100)}% error rate).`,
      ...(retryStepIndices.length > 0 ? { stepIndices: retryStepIndices } : {}),
      remediation: {
        kind: 'avoid-tool-pattern',
        label: 'Read Target Before Editing',
        description: 'Inspect target file lines or schema before invoking write/edit tools to avoid failed calls.',
        suggestedPromptSnippet: 'Read target file sections before applying edits so tool calls succeed on the first attempt.'
      }
    });
  }

  if (retryLoopCount > 0) {
    const deduction = Math.min(8, 3 + retryLoopCount * 2);
    toolEarned -= deduction;
    findings.push({
      id: 'tool-retry-loop',
      dimension: 'tool-efficiency',
      severity: 'critical',
      deltaPoints: -deduction,
      title: `Consecutive failed tool retry loop (${retryLoopCount + 1}×)`,
      evidence: `Steps ${retryStepIndices.map(s => `#${s}`).join(', ')} repeated failing tool calls without changing strategy.`,
      stepIndices: retryStepIndices,
      remediation: {
        kind: 'avoid-tool-pattern',
        label: 'Break Retry Loops Early',
        description: 'Stop repeating identical failing tool calls; inspect file state or error output first.'
      }
    });
  }

  if (readOrSearchCount > 12 && writeCount > 0 && readOrSearchCount / Math.max(1, writeCount) > 8) {
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

  if (shellSearchFallbackCount > 0 && hasCodeIntel && mcpToolsUsedSet.size === 0) {
    const deduction = Math.min(10, 4 + shellSearchFallbackCount * 1);
    mcpEarned -= deduction;
    findings.push({
      id: 'mcp-shell-grep-workaround',
      dimension: 'mcp-leverage',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Used raw shell \`grep\`/\`find\` ${shellSearchFallbackCount}× instead of \`code_intelligence\``,
      evidence: `Steps ${shellSearchStepIndices.map(s => `#${s}`).join(', ')} shelled out to raw text search while \`code_intelligence\` MCP tools were available.`,
      stepIndices: shellSearchStepIndices,
      remediation: {
        kind: 'enable-mcp',
        label: 'Use code_intelligence MCP',
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
      evidence: `Steps ${shellSearchStepIndices.map(s => `#${s}`).join(', ')} fell back to shell search.`,
      stepIndices: shellSearchStepIndices,
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
  const hasPostEditVerification = writeCount === 0 || lastVerificationEventIndex > lastWriteEventIndex;

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

  if (writeCount > 0 && !hasPostEditVerification) {
    const deduction = 6;
    outcomeEarned -= deduction;
    findings.push({
      id: 'outcome-unverified-writes',
      dimension: 'outcome-verification',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'File edits were not followed by a build, typecheck, or test command',
      evidence: `Session wrote ${writeCount} file edit(s) (${[...touchedPathsSet].slice(0, 3).join(', ')}) with no verification command after the final write.`,
      remediation: {
        kind: 'add-verification',
        label: '+ Add Verification Step',
        description: 'Always run `npm run check-types` or the relevant unit test suite after the last file write.',
        suggestedPromptSnippet: 'Run the build/typecheck and relevant unit tests after completing all file edits.'
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
          : `${successfulToolCalls}/${totalToolCalls} succeeded · ${retryLoopCount} retry ${retryLoopCount === 1 ? 'loop' : 'loops'}.`
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
    retryLoopCount,
    shellSearchFallbackCount,
    touchedPaths: [...touchedPathsSet].sort(),
    hasPostEditVerification
  };
}
