import type { AgentEventSummary } from '../agentTypes';
import { analyzeCapabilityAlignment } from './capabilityAlignment';
import { analyzeExecutionSignals, selectTurnEvents } from './executionSignals';
import {
  FEEDBACK_SCHEMA_VERSION,
  SCORING_RUBRIC_VERSION,
  computeFeedbackInputDigest,
  scoreToFeedbackGrade,
  type DeterministicFeedbackReport,
  type FeedbackDimensionScore,
  type FeedbackEvaluationInput,
  type FeedbackFinding,
  type FeedbackFindingSeverity
} from './feedbackTypes';
import { analyzePromptSignals } from './promptSignals';

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
 * Builds a deterministic, copy-ready improved prompt from the original prompt
 * and the ordered findings without calling an external LLM.
 */
export function buildDeterministicSuggestedPrompt(
  originalPrompt: string,
  findings: readonly FeedbackFinding[],
  recommendedSkills: readonly string[]
): string {
  const base = originalPrompt.trim();
  if (!base) return '';

  const additions: string[] = [];

  if (recommendedSkills.length > 0) {
    const missingFromText = recommendedSkills.filter(
      skill => !new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(base)
    );
    if (missingFromText.length > 0) {
      additions.push(`Use the ${missingFromText.map(s => `\`${s}\``).join(', ')} skill guidelines.`);
    }
  }

  for (const finding of findings) {
    if (finding.remediation.kind === 'attach-skill') continue;
    const snippet = finding.remediation.suggestedPromptSnippet?.trim();
    if (snippet && !base.toLowerCase().includes(snippet.toLowerCase()) && !additions.includes(snippet)) {
      additions.push(snippet);
    }
  }

  if (additions.length === 0) {
    return base;
  }

  return `${base}\n\nRequirements & Verification:\n${additions.map(line => `- ${line}`).join('\n')}`;
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
    contextLimit: effectiveContextLimit
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
    userFeedback: input.userFeedback
  });

  // 3. Skill & Agent Alignment (max 20)
  const capabilityAnalysis = analyzeCapabilityAlignment({
    promptText: effectivePromptText,
    sessionMode: effectiveSessionMode,
    profileId: effectiveProfileId,
    activeSkills: input.activeSkills,
    session,
    touchedPaths: executionAnalysis.touchedPaths,
    availableSkills: input.availableSkills,
    availableAgents: input.availableAgents,
    userFeedback: input.userFeedback
  });

  const dimensions: FeedbackDimensionScore[] = [
    promptAnalysis.dimension,
    executionAnalysis.toolDimension,
    capabilityAnalysis.dimension,
    executionAnalysis.mcpDimension,
    executionAnalysis.outcomeDimension
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
  if (input.kind === 'prompt-readiness') {
    // Normalize pre-send dimensions (Prompt Clarity 20 + Skill/Agent Alignment 20 + MCP Readiness 15 = 55 max) to 0-100
    const preSendMax =
      promptAnalysis.dimension.maxPoints +
      capabilityAnalysis.dimension.maxPoints +
      executionAnalysis.mcpDimension.maxPoints;
    const preSendEarned =
      promptAnalysis.dimension.earnedPoints +
      capabilityAnalysis.dimension.earnedPoints +
      executionAnalysis.mcpDimension.earnedPoints;
    overallScore = Math.max(0, Math.min(100, Math.round((preSendEarned / preSendMax) * 100)));
  } else {
    const totalEarned = dimensions.reduce((sum, d) => sum + d.earnedPoints, 0);
    const totalMax = dimensions.reduce((sum, d) => sum + d.maxPoints, 0);
    overallScore = Math.max(0, Math.min(100, Math.round((totalEarned / totalMax) * 100)));
  }

  // Projected score if actionable remediations are applied
  const recoverablePoints = findings.reduce((sum, f) => sum + Math.abs(f.deltaPoints), 0);
  const projectedScore =
    findings.length === 0
      ? overallScore
      : Math.min(
          98,
          Math.max(
            overallScore,
            input.kind === 'prompt-readiness'
              ? Math.min(96, overallScore + Math.round((recoverablePoints / 55) * 100 * 0.85))
              : Math.min(96, overallScore + Math.round(recoverablePoints * 0.85))
          )
        );

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
    capabilityAnalysis.skillsRecommended
  );

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
    findings,
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
    ...(input.userFeedback ? { userFeedback: input.userFeedback } : {})
  };
}
