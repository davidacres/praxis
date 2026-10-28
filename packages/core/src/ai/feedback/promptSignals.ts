import type { AgentToolMode, SessionMode } from '../agentTypes';
import type { FeedbackDimensionScore, FeedbackFinding } from './feedbackTypes';

export interface PromptSignalAnalysis {
  dimension: FeedbackDimensionScore;
  findings: FeedbackFinding[];
  hasEditIntent: boolean;
  hasScopeAnchor: boolean;
  hasVerificationClause: boolean;
  wordCount: number;
}

const EDIT_INTENT_PATTERN = /\b(implement|create|write|edit|modify|update|refactor|fix|add|remove|delete|rename|build|patch|scaffold|wire)\b/i;
const READ_ONLY_INTENT_PATTERN = /\b(do not edit|don't edit|read[- ]only|without modifying|only analyze|just explain|investigate only)\b/i;
const FILE_OR_PATH_ANCHOR_PATTERN = /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|cs|dart)\b|`[^`]{2,80}`)/;
const TICKET_ANCHOR_PATTERN = /\b(?:FX-[A-Z]+-\d+|TASK-\d+|[A-Z]{2,10}-\d+|#\d+)\b/;
const VERIFICATION_PATTERN = /\b(test|tests|unit test|e2e|playwright|verify|verification|check-types|typecheck|compile|build|lint|assert|npm run|node --test)\b/i;

/**
 * Evaluates Dimension 1: Prompt Clarity & Context Readiness (max 20 points).
 *
 * Signals:
 * - Prompt length & specificity (up to -6 pts for vague/terse prompts)
 * - File/symbol/ticket scope anchors (up to -4 pts when missing on actionable requests)
 * - Verification/acceptance expectations (up to -4 pts when missing on edit/implementation tasks)
 * - Tool mode alignment (`read-only` / `project-only` vs edit intent: -6 pts)
 * - Context window headroom (`contextTokens / contextLimit >= 0.85`: -4 pts)
 */
export function analyzePromptSignals(input: {
  promptText: string;
  toolMode?: AgentToolMode;
  sessionMode?: SessionMode;
  issueKey?: string;
  contextTokens?: number;
  contextLimit?: number;
}): PromptSignalAnalysis {
  const maxPoints = 20;
  let earnedPoints = maxPoints;
  const findings: FeedbackFinding[] = [];

  const text = input.promptText.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const hasEditIntent = EDIT_INTENT_PATTERN.test(text) && !READ_ONLY_INTENT_PATTERN.test(text);
  const hasFileAnchor = FILE_OR_PATH_ANCHOR_PATTERN.test(text);
  const hasTicketAnchor = TICKET_ANCHOR_PATTERN.test(text) || Boolean(input.issueKey && !input.issueKey.startsWith('CHAT-') && !input.issueKey.startsWith('session-'));
  const hasScopeAnchor = hasFileAnchor || hasTicketAnchor;
  const hasVerificationClause = VERIFICATION_PATTERN.test(text);

  const effectiveToolMode: AgentToolMode = input.toolMode ?? 'full';
  const effectiveSessionMode: SessionMode = input.sessionMode ?? 'chat';

  // 1. Specificity / length check
  if (wordCount < 6) {
    const deduction = 6;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-too-terse',
      dimension: 'prompt-clarity',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'Prompt is too terse and underspecified',
      evidence: `Prompt contains only ${wordCount} ${wordCount === 1 ? 'word' : 'words'} ("${text.slice(0, 60)}"), forcing the agent to guess scope and acceptance criteria.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Expand Goal & Scope',
        description: 'State the concrete objective, target files or module, and expected outcome.',
        suggestedPromptSnippet: 'Specify the target files/components, desired behavior change, and how to verify it.'
      }
    });
  } else if (wordCount < 12 && !hasScopeAnchor) {
    const deduction = 3;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-low-specificity',
      dimension: 'prompt-clarity',
      severity: 'info',
      deltaPoints: -deduction,
      title: 'Prompt lacks specific constraints or context',
      evidence: `Prompt has ${wordCount} words without naming specific files, symbols, or ticket IDs.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Add Scope Context',
        description: 'Name the target module, file path, or symbol so the agent starts in the right place.',
        suggestedPromptSnippet: 'Focus on the relevant files in this workspace and preserve existing public contracts.'
      }
    });
  }

  // 2. Missing file/symbol/ticket anchor
  if (!hasScopeAnchor && (hasEditIntent || wordCount >= 6)) {
    const deduction = 4;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-missing-scope-anchor',
      dimension: 'prompt-clarity',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'Missing explicit file, path, symbol, or ticket anchor',
      evidence: 'No file path (e.g. `src/...`), code identifier, or ticket key was found in the prompt.',
      remediation: {
        kind: 'refine-prompt',
        label: 'Add Target Path / Scope',
        description: 'Anchor the prompt to specific paths, symbols, or a ticket key to avoid broad repository scans.',
        suggestedPromptSnippet: 'Target the relevant files under the workspace root and list any touched files.'
      }
    });
  }

  // 3. Missing verification clause on edit/implementation tasks
  if (hasEditIntent && effectiveSessionMode === 'chat' && !hasVerificationClause) {
    const deduction = 4;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-missing-verification',
      dimension: 'prompt-clarity',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'Missing verification or test expectation',
      evidence: 'Prompt asks to create or modify files without stating how the result should be tested or verified.',
      remediation: {
        kind: 'add-verification',
        label: '+ Add Verification Clause',
        description: 'Append explicit build/typecheck/test verification criteria to the prompt.',
        suggestedPromptSnippet: 'Verify the changes by running the relevant typecheck and unit/E2E tests before finishing.'
      }
    });
  }

  // 4. Contradiction between edit intent and restricted toolMode
  if (hasEditIntent && effectiveSessionMode === 'chat' && effectiveToolMode !== 'full') {
    const deduction = 6;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-tool-mode-conflict',
      dimension: 'prompt-clarity',
      severity: 'critical',
      deltaPoints: -deduction,
      title: `Tool mode conflict (\`${effectiveToolMode}\` vs edit intent)`,
      evidence: `Prompt requests file creation or edits while session tool access is set to \`${effectiveToolMode}\`.`,
      remediation: {
        kind: 'change-tool-mode',
        label: 'Switch to Full Access',
        description: 'Switch tool access to Full (`full`) so the agent can write files and run verification commands.',
        targetId: 'full'
      }
    });
  }

  // 5. Context window pressure check
  if (
    typeof input.contextTokens === 'number' &&
    typeof input.contextLimit === 'number' &&
    input.contextLimit > 0
  ) {
    const ratio = input.contextTokens / input.contextLimit;
    if (ratio >= 0.85) {
      const pct = Math.round(ratio * 100);
      const deduction = 4;
      earnedPoints -= deduction;
      findings.push({
        id: 'prompt-context-pressure',
        dimension: 'prompt-clarity',
        severity: 'warning',
        deltaPoints: -deduction,
        title: `High context window occupancy (${pct}%)`,
        evidence: `Context window is at ${input.contextTokens.toLocaleString()} / ${input.contextLimit.toLocaleString()} tokens (${pct}% >= 85%), increasing truncation and instruction-drift risk.`,
        remediation: {
          kind: 'refine-prompt',
          label: 'Start Fresh or Hand Over',
          description: 'Start a fresh session or hand over with a compact brief so the model has full context headroom.'
        }
      });
    }
  }

  earnedPoints = Math.max(0, Math.min(maxPoints, earnedPoints));
  const normalizedScore = Math.round((earnedPoints / maxPoints) * 100);

  const summary =
    earnedPoints === maxPoints
      ? 'Clear scope, aligned tool mode, and explicit verification criteria.'
      : findings.map(f => f.title).join('; ');

  return {
    dimension: {
      dimension: 'prompt-clarity',
      label: 'Prompt Clarity & Context',
      earnedPoints,
      maxPoints,
      normalizedScore,
      summary
    },
    findings,
    hasEditIntent,
    hasScopeAnchor,
    hasVerificationClause,
    wordCount
  };
}
