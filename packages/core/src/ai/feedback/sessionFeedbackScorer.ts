import { boundedFeedbackMessages } from './promptClarity';
import { buildFeedbackRehearsal, buildFeedbackTurningPoint } from './feedbackCoaching';
import type { AgentEventSummary } from '../agentTypes';
import { analyzeCapabilityAlignment } from './capabilityAlignment';
import { analyzeExecutionSignals, selectTurnEvents } from './executionSignals';
import {
  FEEDBACK_SCHEMA_VERSION,
  SCORING_RUBRIC_VERSION,
  computeFeedbackInputDigest,
  scoreToFeedbackGrade,
  type DeterministicFeedbackReport,
  type FeedbackDiagnosis,
  type FeedbackDimensionScore,
  type FeedbackEvaluationInput,
  type FeedbackEvaluationKind,
  type FeedbackFinding,
  type FeedbackFindingSeverity,
  type FeedbackSignal
} from './feedbackTypes';
import { analyzePromptSignals } from './promptSignals';

/** Pre-send score weights (sum 100): the prompt is what the user can still change. */
export const PRE_SEND_WEIGHTS = {
  'prompt-clarity': 60,
  'skill-agent-alignment': 25,
  'mcp-leverage': 15
} as const;

/** A fix the composer can apply for the user: a setting, or a concrete clause to insert. */
export function isOneClickFix(finding: FeedbackFinding): boolean {
  const { remediation } = finding;
  if (remediation.kind === 'change-tool-mode' || remediation.kind === 'attach-skill' || remediation.kind === 'select-agent') {
    return Boolean(remediation.targetId);
  }
  return Boolean(remediation.suggestedPromptSnippet);
}

const SEVERITY_RANK: Record<FeedbackFindingSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2
};

function countPromptTurns(events: readonly AgentEventSummary[], hasGoal: boolean): number {
  const userTurnEvents = events.filter(e => e.type === 'user_input_completed').length;
  if (userTurnEvents === 0) return hasGoal ? 1 : 0;
  return hasGoal ? userTurnEvents + 1 : userTurnEvents;
}

/**
 * Builds a deterministic, copy-ready improved prompt from the findings without
 * calling an LLM. Only concrete fixes are written into the text: a pinned
 * workspace file and a real test command are woven into the sentence
 * (`… in @src/Foo.tsx and verify with \`npm test\`.`); other snippets follow as
 * short sentences. Skills and tool access are applied as settings, not text.
 *
 * For a session evaluation the result is a follow-up prompt instead: one line
 * per concrete fix the next turn should make.
 */
export function buildDeterministicSuggestedPrompt(
  originalPrompt: string,
  findings: readonly FeedbackFinding[],
  _recommendedSkills: readonly string[] = [],
  kind: FeedbackEvaluationKind = 'prompt-readiness'
): string {
  const base = originalPrompt.trim();
  const snippets: Array<{ kind: string; text: string }> = [];
  for (const finding of findings) {
    const { remediation } = finding;
    if (remediation.kind === 'attach-skill' || remediation.kind === 'change-tool-mode' || remediation.kind === 'select-agent') continue;
    const text = remediation.suggestedPromptSnippet?.trim();
    if (!text || base.toLowerCase().includes(text.toLowerCase()) || snippets.some(item => item.text === text)) continue;
    snippets.push({ kind: remediation.kind, text });
  }

  if (kind === 'session-execution') {
    if (snippets.length === 0) return '';
    return `Follow up on the previous turn:\n${snippets.map(item => `- ${item.text}`).join('\n')}`;
  }

  if (!base) return '';
  const inline = snippets.filter(item => item.kind === 'pin-file' || item.kind === 'add-test-command' || item.kind === 'add-verification');
  const sentences = snippets.filter(item => !inline.includes(item)).map(item => item.text);
  if (inline.length === 0 && sentences.length === 0) return base;

  const pins = inline.filter(item => item.kind === 'pin-file').map(item => item.text);
  const checks = inline.filter(item => item.kind !== 'pin-file').map(item => item.text);
  let sentence = base.replace(/[.!\s]+$/, '');
  if (pins.length > 0) sentence += ` ${pins.join(' and ').replace(/ and in @/g, ' and @')}`;
  if (checks.length > 0) sentence += ` ${checks[0]}`;
  sentence += '.';
  return sentences.length > 0 ? `${sentence}\n\n${sentences.join(' ')}` : sentence;
}

const DIAGNOSIS_PHRASES: Array<{ match: (id: string) => boolean; phrase: string }> = [
  { match: id => /^tool-(blind-edit-loop|edit-retry-loop|retry-loop|file-thrash)/.test(id), phrase: 'avoidable tool thrashing' },
  { match: id => id === 'outcome-unresolved-failure', phrase: 'an unresolved test failure' },
  { match: id => id === 'outcome-unverified-writes', phrase: 'unverified edits' },
  { match: id => id === 'tool-blind-edits', phrase: 'edits made without reading' },
  { match: id => id.startsWith('skill-missed-'), phrase: 'a missed skill' },
  { match: id => id.startsWith('mcp-shell') || id === 'mcp-partial-shell-search', phrase: 'shell search instead of code_intelligence' },
  { match: id => id === 'tool-failed-calls', phrase: 'failing tool calls' },
  { match: id => id === 'agent-profile-mode-mismatch', phrase: 'the wrong agent profile' }
];

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} & ${items[items.length - 1]}`;
}

/** One-sentence executive summary of a report, derived only from its findings. */
export function buildFeedbackDiagnosis(
  kind: FeedbackEvaluationKind,
  findings: readonly FeedbackFinding[],
  sessionState?: string
): FeedbackDiagnosis {
  const systemFindings = findings.filter(f => !f.id.startsWith('user-'));
  if (kind === 'prompt-readiness') {
    const top = systemFindings[0];
    return top
      ? { headline: top.title, detail: top.evidence }
      : { headline: 'Prompt is ready', detail: 'Scope, tool access, and verification are all in place.' };
  }
  const outcome =
    sessionState === 'failed' ? 'Failed' : sessionState === 'aborted' ? 'Stopped early' : 'Completed';
  const phrases: string[] = [];
  for (const finding of systemFindings) {
    const phrase = DIAGNOSIS_PHRASES.find(entry => entry.match(finding.id))?.phrase;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  if (systemFindings.length === 0) {
    return {
      headline: `${outcome} cleanly`,
      detail: 'No wasted steps, missed capabilities, or unverified edits were detected.'
    };
  }
  return {
    headline: phrases.length > 0 ? `${outcome} with ${joinWithAnd(phrases.slice(0, 2))}` : `${outcome} with ${systemFindings.length} ${systemFindings.length === 1 ? 'issue' : 'issues'}`,
    detail: `${systemFindings.slice(0, 3).map(f => f.title).join('; ')}.`
  };
}

/**
 * Pure deterministic scoring engine (`SCORING_RUBRIC_VERSION = 1`).
 *
 * Given identical `FeedbackEvaluationInput`, always returns byte-identical
 * scores, grades, 5-dimension breakdowns, findings, and `inputDigest`.
 */
export function evaluateSessionOrPrompt(
  input: FeedbackEvaluationInput
): DeterministicFeedbackReport {
  const session = input.session;
  const turnEvents = session ? selectTurnEvents(session.events ?? [], input.turnIndex) : [];

  const turnPromptEvent =
    input.turnIndex !== undefined
      ? turnEvents.find(e => e.type === 'user_input_completed')
      : undefined;

  const effectivePromptText =
    input.promptText.trim() ||
    turnPromptEvent?.detail?.trim() ||
    turnPromptEvent?.summary?.trim() ||
    session?.taskDefinition?.goal?.trim() ||
    '';

  const effectiveToolMode = input.toolMode ?? session?.toolMode ?? 'full';
  const effectiveSessionMode =
    input.sessionMode ?? session?.mode ?? session?.taskDefinition?.sessionMode ?? 'chat';
  const effectiveProfileId =
    input.profileId ?? session?.profileId ?? session?.agentId;
  const effectiveIssueKey = input.issueKey ?? session?.issueKey;
  const effectiveContextTokens = input.contextTokens ?? session?.contextTokens;
  const effectiveContextLimit = input.contextLimit ?? session?.contextLimit;

  const canonicalInput: FeedbackEvaluationInput = {
    ...input,
    promptText: effectivePromptText,
    toolMode: effectiveToolMode,
    sessionMode: effectiveSessionMode,
    ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
    ...(effectiveIssueKey ? { issueKey: effectiveIssueKey } : {}),
    ...(effectiveContextTokens !== undefined ? { contextTokens: effectiveContextTokens } : {}),
    ...(effectiveContextLimit !== undefined ? { contextLimit: effectiveContextLimit } : {})
  };

  const inputDigest = computeFeedbackInputDigest(canonicalInput);

  // 1. Prompt Clarity & Context Readiness (max 20)
  const promptAnalysis = analyzePromptSignals({
    promptText: effectivePromptText,
    toolMode: effectiveToolMode,
    sessionMode: effectiveSessionMode,
    issueKey: effectiveIssueKey,
    contextTokens: effectiveContextTokens,
    contextLimit: effectiveContextLimit,
    priorContext: input.priorContext,
    workspaceHints: input.workspaceHints,
    clarity: input.clarity
  });

  // 2, 4, 5. Execution Efficiency (25), MCP Leverage (15), Outcome & Verification (20)
  const executionAnalysis = analyzeExecutionSignals({
    kind: input.kind,
    promptText: effectivePromptText,
    session,
    turnIndex: input.turnIndex,
    configuredMcpServers: input.configuredMcpServers,
    codeIntelligenceAvailable: input.codeIntelligenceAvailable,
    trackerToolsAvailable: input.trackerToolsAvailable,
    browserToolsAvailable: input.browserToolsAvailable,
    userFeedback: input.userFeedback,
    workspaceHints: input.workspaceHints
  });

  // 3. Skill & Agent Alignment (max 20)
  const capabilityAnalysis = analyzeCapabilityAlignment({
    promptText: effectivePromptText,
    sessionMode: effectiveSessionMode,
    profileId: effectiveProfileId,
    activeSkills: input.activeSkills,
    session,
    touchedPaths: executionAnalysis.touchedPaths,
    pathWriteSteps: executionAnalysis.pathWriteSteps,
    availableSkills: input.availableSkills,
    availableAgents: input.availableAgents,
    userFeedback: input.userFeedback
  });

  const isSession = input.kind === 'session-execution' && Boolean(session);
  const toolSignals: FeedbackSignal[] = [];
  const mcpSignals: FeedbackSignal[] = [];
  const outcomeSignals: FeedbackSignal[] = [];
  if (isSession) {
    toolSignals.push({ label: `${executionAnalysis.totalToolCalls} calls`, tone: 'neutral' });
    if (executionAnalysis.failedEditCount > 0) {
      toolSignals.push({ label: `${executionAnalysis.failedEditCount} failed edits`, tone: 'bad' });
    } else if (executionAnalysis.failedToolCalls > 0) {
      toolSignals.push({ label: `${executionAnalysis.failedToolCalls} failed`, tone: 'bad' });
    }
    if (executionAnalysis.blindEditCount > 0) {
      toolSignals.push({ label: `${executionAnalysis.blindEditCount} blind ${executionAnalysis.blindEditCount === 1 ? 'edit' : 'edits'} before read`, tone: 'warn' });
    }
    mcpSignals.push({ label: `${executionAnalysis.mcpToolsUsed.length} MCP ${executionAnalysis.mcpToolsUsed.length === 1 ? 'tool' : 'tools'}`, tone: executionAnalysis.mcpToolsUsed.length > 0 ? 'good' : 'neutral' });
    if (executionAnalysis.shellSearchFallbackCount > 0) {
      mcpSignals.push({ label: `${executionAnalysis.shellSearchFallbackCount} shell grep vs code_intelligence`, tone: 'warn' });
    }
    if (executionAnalysis.lastWriteStep !== undefined) {
      outcomeSignals.push(
        executionAnalysis.hasPostEditVerification
          ? { label: '✓ Verified after final edit', tone: 'good' }
          : { label: `! No test/build after step #${executionAnalysis.lastWriteStep}`, tone: 'bad' }
      );
    }
    if (session?.state === 'failed' || session?.state === 'aborted') {
      outcomeSignals.push({ label: `State: ${session.state}`, tone: 'bad' });
    }
    const verdict = input.userFeedback?.verdict;
    if (verdict) {
      const label = verdict === 'helpful' ? 'Helpful' : verdict === 'needs-work' ? 'Needs Work' : 'Failed Goal';
      outcomeSignals.push({ label: `Verdict: ${label}`, tone: verdict === 'helpful' ? 'good' : 'warn' });
    }
  } else {
    mcpSignals.push(
      ...[input.codeIntelligenceAvailable !== false ? 'code_intelligence' : '', ...(input.configuredMcpServers ?? [])]
        .filter(Boolean)
        .slice(0, 3)
        .map(name => ({ label: `✓ ${name}`, tone: 'good' as const }))
    );
  }

  const withSignals = (dimension: FeedbackDimensionScore, signals: FeedbackSignal[]): FeedbackDimensionScore =>
    signals.length > 0 ? { ...dimension, signals: [...(dimension.signals ?? []), ...signals] } : dimension;

  const dimensions: FeedbackDimensionScore[] = [
    promptAnalysis.dimension,
    withSignals(executionAnalysis.toolDimension, toolSignals),
    capabilityAnalysis.dimension,
    withSignals(executionAnalysis.mcpDimension, mcpSignals),
    withSignals(executionAnalysis.outcomeDimension, outcomeSignals)
  ];

  // Combine and deterministically sort findings by:
  // 1) largest point impact (most negative deltaPoints first)
  // 2) severity (critical -> warning -> info)
  // 3) stable finding id
  const findings: FeedbackFinding[] = [
    ...promptAnalysis.findings,
    ...executionAnalysis.findings,
    ...capabilityAnalysis.findings
  ].sort((a, b) => {
    const impactDiff = a.deltaPoints - b.deltaPoints; // e.g. -10 before -4
    if (impactDiff !== 0) return impactDiff;
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.id.localeCompare(b.id);
  });

  let overallScore: number;
  let scoredFindings = findings;
  if (input.kind === 'prompt-readiness') {
    // Before sending, the prompt itself is what the user controls, so clarity carries most of
    // the weight: a vague prompt cannot hide behind full marks for skills and MCP readiness.
    const weighted = (clarity: number, skills: number, mcp: number) =>
      Math.round(
        (clarity / promptAnalysis.dimension.maxPoints) * PRE_SEND_WEIGHTS['prompt-clarity'] +
        (skills / capabilityAnalysis.dimension.maxPoints) * PRE_SEND_WEIGHTS['skill-agent-alignment'] +
        (mcp / executionAnalysis.mcpDimension.maxPoints) * PRE_SEND_WEIGHTS['mcp-leverage']
      );
    overallScore = Math.max(0, Math.min(100, weighted(
      promptAnalysis.dimension.earnedPoints,
      capabilityAnalysis.dimension.earnedPoints,
      executionAnalysis.mcpDimension.earnedPoints
    )));
    scoredFindings = findings.map(finding => {
      const weight = PRE_SEND_WEIGHTS[finding.dimension as keyof typeof PRE_SEND_WEIGHTS];
      const max = dimensions.find(d => d.dimension === finding.dimension)?.maxPoints;
      return weight && max ? { ...finding, scoreImpact: Math.round((Math.abs(finding.deltaPoints) / max) * weight) } : finding;
    });
  } else {
    const totalEarned = dimensions.reduce((sum, d) => sum + d.earnedPoints, 0);
    const totalMax = dimensions.reduce((sum, d) => sum + d.maxPoints, 0);
    overallScore = Math.max(0, Math.min(100, Math.round((totalEarned / totalMax) * 100)));
    scoredFindings = findings.map(finding => ({ ...finding, scoreImpact: Math.abs(finding.deltaPoints) }));
  }

  // Projected score. Before sending it counts only what one click can fix (a settings change
  // or an inserted clause) — a vague goal needs the user's rewrite, so it is not promised.
  // After a session it is the follow-up's potential, so every finding counts (never a perfect 100).
  const projectedScore =
    findings.length === 0
      ? overallScore
      : input.kind === 'prompt-readiness'
        ? Math.min(100, overallScore + scoredFindings.filter(isOneClickFix).reduce((sum, f) => sum + (f.scoreImpact ?? 0), 0))
        : Math.max(overallScore, Math.min(96, overallScore + Math.round(scoredFindings.reduce((sum, f) => sum + (f.scoreImpact ?? 0), 0) * 0.85)));

  const grade = scoreToFeedbackGrade(overallScore);
  const projectedGrade = scoreToFeedbackGrade(projectedScore);

  const promptsAnalyzed = session
    ? input.turnIndex !== undefined
      ? 1
      : countPromptTurns(session.events ?? [], Boolean(session.taskDefinition?.goal))
    : effectivePromptText
      ? 1
      : 0;

  const configuredMcpList = [
    ...(input.codeIntelligenceAvailable !== false ? ['code_intelligence'] : []),
    ...(input.trackerToolsAvailable || session?.connectionId ? ['tracker'] : []),
    ...(input.browserToolsAvailable ? ['browser'] : []),
    ...(input.configuredMcpServers ?? [])
  ];
  const uniqueConfiguredMcps = [...new Set(configuredMcpList.map(s => s.trim()).filter(Boolean))].sort();

  const suggestedPrompt = buildDeterministicSuggestedPrompt(
    effectivePromptText,
    findings,
    capabilityAnalysis.skillsRecommended,
    input.kind
  );
  const diagnosis = buildFeedbackDiagnosis(input.kind, findings, session?.state);

  const evaluatedAt = input.evaluatedAt ?? '1970-01-01T00:00:00.000Z';
  const reportId = `fb-${inputDigest.slice(0, 12)}`;

  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    rubricVersion: SCORING_RUBRIC_VERSION,
    reportId,
    evaluatedAt,
    kind: input.kind,
    ...(session?.sessionId || input.sessionId ? { sessionId: session?.sessionId ?? input.sessionId } : {}),
    ...(effectiveIssueKey ? { issueKey: effectiveIssueKey } : {}),
    ...(input.turnIndex !== undefined ? { turnIndex: input.turnIndex } : {}),
    promptText: effectivePromptText,
    inputDigest,
    overallScore,
    projectedScore,
    grade,
    projectedGrade,
    dimensions,
    findings: scoredFindings,
    ...(input.priorContext ? { reviewContext: { turnCount: input.priorContext.turnCount, touchedPaths: [...input.priorContext.touchedPaths], issueKey: input.priorContext.issueKey, recentMessages: boundedFeedbackMessages(input.priorContext) } } : {}),
    rehearsal: buildFeedbackRehearsal({ ...input, promptText: effectivePromptText }),
    turningPoint: buildFeedbackTurningPoint(scoredFindings),
    inventory: {
      promptsAnalyzed,
      toolsUsed: executionAnalysis.toolsUsed,
      totalToolCalls: executionAnalysis.totalToolCalls,
      successfulToolCalls: executionAnalysis.successfulToolCalls,
      failedToolCalls: executionAnalysis.failedToolCalls,
      retryLoopCount: executionAnalysis.retryLoopCount,
      shellSearchFallbackCount: executionAnalysis.shellSearchFallbackCount,
      mcpToolsUsed: executionAnalysis.mcpToolsUsed,
      mcpServersConfigured: uniqueConfiguredMcps,
      ...(capabilityAnalysis.agentProfileId ? { agentProfileId: capabilityAnalysis.agentProfileId } : {}),
      ...(capabilityAnalysis.recommendedAgentProfileId
        ? { recommendedAgentProfileId: capabilityAnalysis.recommendedAgentProfileId }
        : {}),
      skillsAttached: capabilityAnalysis.skillsAttached,
      skillsDetected: capabilityAnalysis.skillsDetected,
      skillsRecommended: capabilityAnalysis.skillsRecommended
    },
    suggestedPrompt,
    intent: promptAnalysis.intent,
    diagnosis,
    ...(promptAnalysis.inheritsContext && input.priorContext ? { contextInheritance: input.priorContext } : {}),
    ...(input.clarity ? { clarity: input.clarity } : {}),
    ...(input.userFeedback ? { userFeedback: input.userFeedback } : {})
  };
}
