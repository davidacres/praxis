import { createHash } from 'node:crypto';
import type {
  AgentSessionRecord,
  AgentToolMode,
  SessionMode
} from '../agentTypes';

export const SCORING_RUBRIC_VERSION = 1 as const;
export const FEEDBACK_SCHEMA_VERSION = 1 as const;

export type FeedbackEvaluationKind = 'prompt-readiness' | 'session-execution';

export type FeedbackDimensionId =
  | 'prompt-clarity'
  | 'tool-efficiency'
  | 'skill-agent-alignment'
  | 'mcp-leverage'
  | 'outcome-verification';

export type FeedbackGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export type FeedbackVerdict = 'helpful' | 'needs-work' | 'failed-goal';

export type FeedbackFrictionTag =
  | 'missed-skill'
  | 'missed-mcp'
  | 'wasted-steps'
  | 'wrong-scope'
  | 'ignored-instructions'
  | 'unverified-changes'
  | 'wrong-agent-or-mode';

export type FeedbackFindingSeverity = 'info' | 'warning' | 'critical';

export type FeedbackRemediationKind =
  | 'attach-skill'
  | 'select-agent'
  | 'enable-mcp'
  | 'change-tool-mode'
  | 'refine-prompt'
  | 'add-verification'
  | 'avoid-tool-pattern';

export interface UserFeedbackInput {
  targetKind: 'prompt' | 'session' | 'turn';
  sessionId?: string;
  issueKey?: string;
  turnIndex?: number;
  promptText: string;
  verdict?: FeedbackVerdict;
  frictionTags?: FeedbackFrictionTag[];
  notes?: string;
  createdAt: string;
}

export interface FeedbackDimensionScore {
  dimension: FeedbackDimensionId;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  normalizedScore: number;
  summary: string;
}

export interface FeedbackRemediation {
  kind: FeedbackRemediationKind;
  label: string;
  description: string;
  targetId?: string;
  suggestedPromptSnippet?: string;
}

export interface FeedbackFinding {
  id: string;
  dimension: FeedbackDimensionId;
  severity: FeedbackFindingSeverity;
  /** Negative integer for point deductions (e.g. -6), or 0 for informational notes. */
  deltaPoints: number;
  title: string;
  evidence: string;
  stepIndices?: number[];
  remediation: FeedbackRemediation;
}

export interface FeedbackCapabilityInventory {
  promptsAnalyzed: number;
  toolsUsed: string[];
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  retryLoopCount: number;
  shellSearchFallbackCount: number;
  mcpToolsUsed: string[];
  mcpServersConfigured: string[];
  agentProfileId?: string;
  recommendedAgentProfileId?: string;
  skillsAttached: string[];
  skillsDetected: string[];
  skillsRecommended: string[];
}

export interface FeedbackAiRewrite {
  rewrittenPrompt: string;
  rationale: string;
  modelId?: string;
  deterministicFallback?: boolean;
}

export interface DeterministicFeedbackReport {
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
  rubricVersion: typeof SCORING_RUBRIC_VERSION;
  reportId: string;
  evaluatedAt: string;
  kind: FeedbackEvaluationKind;
  sessionId?: string;
  issueKey?: string;
  turnIndex?: number;
  promptText: string;
  inputDigest: string;
  overallScore: number;
  /** Projected 0-100 score if all recommended remediations are applied. */
  projectedScore: number;
  grade: FeedbackGrade;
  projectedGrade: FeedbackGrade;
  dimensions: FeedbackDimensionScore[];
  findings: FeedbackFinding[];
  inventory: FeedbackCapabilityInventory;
  suggestedPrompt: string;
  userFeedback?: UserFeedbackInput;
  aiRewrite?: FeedbackAiRewrite;
}

/** Lightweight badge summary stamped onto `AgentSessionRecord` for list/header pills. */
export interface SessionFeedbackSummary {
  overallScore: number;
  grade: FeedbackGrade;
  verdict?: FeedbackVerdict;
  findingCount: number;
  updatedAt: string;
}

/** Catalog entry for a skill available in the workspace or user environment. */
export interface FeedbackSkillCandidate {
  name: string;
  title?: string;
  description: string;
  triggers: string[];
}

/** Catalog entry for an Agent Hub profile available in the workspace or user environment. */
export interface FeedbackAgentCandidate {
  id: string;
  name: string;
  description?: string;
  preferredSkills?: string[];
}

/** Request payload for pre-send composer prompt evaluation (`ai:evaluatePrompt`). */
export interface PromptEvaluationRequest {
  promptText: string;
  toolMode?: AgentToolMode;
  sessionMode?: SessionMode;
  profileId?: string;
  activeSkills?: string[];
  workingDirectory?: string;
  issueKey?: string;
  projectId?: string;
  contextTokens?: number;
  contextLimit?: number;
}

/** Request payload for session/turn evaluation (`ai:evaluateSession`). */
export interface SessionEvaluationRequest {
  issueKey: string;
  turnIndex?: number;
}

/** Request payload for submitting user feedback (`ai:submitSessionFeedback`). */
export interface SubmitSessionFeedbackRequest {
  issueKey?: string;
  sessionId?: string;
  turnIndex?: number;
  promptText?: string;
  verdict: FeedbackVerdict;
  frictionTags?: FeedbackFrictionTag[];
  notes?: string;
}

/** Request payload for optional prompt rewrite (`ai:rewritePromptFromFeedback`). */
export interface RewritePromptFromFeedbackRequest {
  promptText: string;
  issueKey?: string;
  turnIndex?: number;
  toolMode?: AgentToolMode;
  sessionMode?: SessionMode;
  profileId?: string;
  activeSkills?: string[];
  useAiModel?: boolean;
}

/** Complete canonical input to the pure `evaluateSessionOrPrompt` engine. */
export interface FeedbackEvaluationInput {
  kind: FeedbackEvaluationKind;
  promptText: string;
  toolMode?: AgentToolMode;
  sessionMode?: SessionMode;
  profileId?: string;
  activeSkills?: readonly string[];
  workingDirectory?: string;
  issueKey?: string;
  sessionId?: string;
  turnIndex?: number;
  contextTokens?: number;
  contextLimit?: number;
  session?: AgentSessionRecord;
  availableSkills?: readonly FeedbackSkillCandidate[];
  availableAgents?: readonly FeedbackAgentCandidate[];
  configuredMcpServers?: readonly string[];
  codeIntelligenceAvailable?: boolean;
  trackerToolsAvailable?: boolean;
  browserToolsAvailable?: boolean;
  userFeedback?: UserFeedbackInput;
  evaluatedAt?: string;
}

/** Maps a 0-100 integer score to a letter grade A-F. */
export function scoreToFeedbackGrade(score: number): FeedbackGrade {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  if (clamped >= 90) return 'A';
  if (clamped >= 80) return 'B';
  if (clamped >= 70) return 'C';
  if (clamped >= 60) return 'D';
  return 'F';
}

/**
 * Recursively canonicalizes any JSON-serializable value by sorting object keys
 * lexicographically and normalizing unordered catalog sets so identical semantic
 * inputs always yield the exact same JSON representation.
 */
export function canonicalizeForDigest(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeForDigest(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeForDigest(record[key]);
    }
    return result;
  }
  return String(value);
}

/**
 * Computes a deterministic SHA-256 hex digest over the canonicalized evaluation input,
 * invariant to object key insertion order and catalog array ordering.
 */
export function computeFeedbackInputDigest(input: FeedbackEvaluationInput): string {
  const normalizedSkills = [...(input.availableSkills ?? [])]
    .map(skill => ({
      name: skill.name.trim(),
      description: skill.description.trim(),
      triggers: [...(skill.triggers ?? [])].map(t => t.trim().toLowerCase()).filter(Boolean).sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const normalizedAgents = [...(input.availableAgents ?? [])]
    .map(agent => ({
      id: agent.id.trim(),
      name: agent.name.trim(),
      description: (agent.description ?? '').trim(),
      preferredSkills: [...(agent.preferredSkills ?? [])].map(s => s.trim()).filter(Boolean).sort()
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const normalizedActiveSkills = [...new Set((input.activeSkills ?? input.session?.activeSkills ?? []).map(s => s.trim()).filter(Boolean))].sort();
  const normalizedMcpServers = [...new Set((input.configuredMcpServers ?? []).map(s => s.trim()).filter(Boolean))].sort();
  const normalizedFrictionTags = [...new Set((input.userFeedback?.frictionTags ?? []).map(t => t.trim() as FeedbackFrictionTag))].sort();

  const sessionSnapshot = input.session
    ? {
        sessionId: input.session.sessionId,
        issueKey: input.session.issueKey,
        state: input.session.state,
        mode: input.session.mode ?? input.session.taskDefinition?.sessionMode ?? 'chat',
        toolMode: input.session.toolMode ?? 'full',
        profileId: input.session.profileId ?? input.session.agentId ?? '',
        stepCount: input.session.stepCount,
        maxSteps: input.session.taskDefinition?.maxSteps ?? null,
        contextTokens: input.session.contextTokens ?? null,
        contextLimit: input.session.contextLimit ?? null,
        activeSkills: [...new Set((input.session.activeSkills ?? []).map(s => s.trim()))].sort(),
        detectedSkills: [...(input.session.detectedSkills ?? [])]
          .map(d => ({ skillId: d.skillId, via: d.via, count: d.count }))
          .sort((a, b) => a.skillId.localeCompare(b.skillId)),
        events: (input.session.events ?? []).map(ev => ({
          timestamp: ev.timestamp,
          type: ev.type,
          summary: ev.summary,
          detail: ev.detail ?? '',
          data: ev.data
            ? {
                toolName: ev.data.toolName ?? '',
                kind: ev.data.kind ?? '',
                argsSummary: ev.data.argsSummary ?? '',
                args: ev.data.args ?? null,
                ok: ev.data.ok ?? null,
                fileChanges: (ev.data.fileChanges ?? []).map(fc => ({ path: fc.path }))
              }
            : null
        }))
      }
    : null;

  const payload = canonicalizeForDigest({
    rubricVersion: SCORING_RUBRIC_VERSION,
    kind: input.kind,
    promptText: input.promptText.trim(),
    toolMode: input.toolMode ?? input.session?.toolMode ?? 'full',
    sessionMode: input.sessionMode ?? input.session?.mode ?? 'chat',
    profileId: input.profileId ?? input.session?.profileId ?? input.session?.agentId ?? '',
    activeSkills: normalizedActiveSkills,
    issueKey: input.issueKey ?? input.session?.issueKey ?? '',
    turnIndex: input.turnIndex ?? null,
    contextTokens: input.contextTokens ?? input.session?.contextTokens ?? null,
    contextLimit: input.contextLimit ?? input.session?.contextLimit ?? null,
    codeIntelligenceAvailable: Boolean(input.codeIntelligenceAvailable),
    trackerToolsAvailable: Boolean(input.trackerToolsAvailable),
    browserToolsAvailable: Boolean(input.browserToolsAvailable),
    configuredMcpServers: normalizedMcpServers,
    availableSkills: normalizedSkills,
    availableAgents: normalizedAgents,
    session: sessionSnapshot,
    userFeedback: input.userFeedback
      ? {
          targetKind: input.userFeedback.targetKind,
          verdict: input.userFeedback.verdict ?? null,
          frictionTags: normalizedFrictionTags,
          notes: (input.userFeedback.notes ?? '').trim()
        }
      : null
  });

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
