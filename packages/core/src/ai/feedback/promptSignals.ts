import type { AgentToolMode, SessionMode } from '../agentTypes';
import type {
  FeedbackDimensionScore,
  FeedbackFinding,
  FeedbackPriorContext,
  FeedbackRemediation,
  FeedbackSignal,
  FeedbackWorkspaceHints,
  PromptIntent
} from './feedbackTypes';
import { CLARITY_CHECKLIST, scoreClarityAnswers, type ClarityAssessment } from './promptClarity';
import { pickTestCommand, rankFileCandidates, unknownIdentifiers } from './workspaceGrounding';

export interface PromptSignalAnalysis {
  dimension: FeedbackDimensionScore;
  findings: FeedbackFinding[];
  intent: PromptIntent;
  hasEditIntent: boolean;
  hasScopeAnchor: boolean;
  hasVerificationClause: boolean;
  wordCount: number;
  /** True when the prompt is only clear because of earlier turns in the session. */
  inheritsContext: boolean;
}

const EDIT_INTENT_PATTERN = /\b(implement|create|write|edit|modify|update|refactor|fix|add|remove|delete|rename|build|patch|scaffold|wire)\b/i;
/** An imperative opening ("put…", "make…", "move…") is a request to change something even without a code verb. */
const IMPERATIVE_START_PATTERN = /^(?:please\s+)?(put|move|make|do|change|set|replace|swap|convert|migrate|clean|tidy|improve|handle|sort|get|turn|use|hook|connect|finish|apply|bump|upgrade|tweak|adjust|align|place|insert|drop|stick|wrap|merge|split|deploy|run)\b/i;
const READ_ONLY_INTENT_PATTERN = /\b(do not edit|don't edit|read[- ]only|without modifying|only analyze|just explain|investigate only)\b/i;
const FILE_OR_PATH_ANCHOR_PATTERN = /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|cs|dart)\b|`[^`]{2,80}`|@[A-Za-z0-9_./-]{3,})/;
const TICKET_ANCHOR_PATTERN = /\b(?:FX-[A-Z]+-\d+|TASK-\d+|[A-Z]{2,10}-\d+|#\d+)\b/;
const VERIFICATION_PATTERN = /\b(test|tests|unit test|e2e|playwright|verify|verification|check-types|typecheck|compile|build|lint|assert|npm run|node --test)\b/i;
const QUESTION_LEAD_PATTERN = /^(how|what|why|where|which|who|when|does|is|are|should|(?:can|could) you (?:explain|tell me|describe)|explain|tell me|describe)\b/i;
const FOLLOW_UP_REFERENCE_PATTERN = /\b(it|that|this|those|these|again|same|above|previous|earlier|remaining|rest|commit|push|continue|retry|rerun|re-run|also|instead|too)\b/i;
const REVIEW_PATTERN = /\b(review|audit|critique)\b/i;
const PLAN_PATTERN = /\b(plan|roadmap|decompose|stories|feature plan|break (?:it|this) down)\b/i;
const BUGFIX_PATTERN = /\b(fix|bug|broken|regression|crash|failing|fails|error|truncated|misaligned|wrong)\b/i;

const INTENT_LABELS: Record<PromptIntent, string> = {
  question: 'Question',
  'follow-up': 'Follow-up',
  bugfix: 'Bugfix / Edit',
  feature: 'Feature / Edit',
  plan: 'Plan',
  review: 'Review',
  general: 'General'
};

export function promptIntentLabel(intent: PromptIntent): string {
  return INTENT_LABELS[intent];
}

/**
 * Classifies what a prompt is asking for. A question is never graded on file
 * anchors or test commands, and a short follow-up inside a session with
 * earlier turns inherits that session's scope.
 */
function hasActionIntent(text: string): boolean {
  return (EDIT_INTENT_PATTERN.test(text) || IMPERATIVE_START_PATTERN.test(text)) && !READ_ONLY_INTENT_PATTERN.test(text);
}


export function classifyPromptIntent(promptText: string, hasPriorTurns: boolean): PromptIntent {
  const text = promptText.trim();
  const hasEdit = hasActionIntent(text);
  // "how do I fix…" is a question even with an edit verb; "can you add…?" is a request.
  if (QUESTION_LEAD_PATTERN.test(text) || (/\?\s*$/.test(text) && !hasEdit)) return 'question';
  // Only a prompt that actually refers back to earlier turns inherits their scope —
  // being short is not enough ("put the thing in the box" is vague on any turn).
  if (hasPriorTurns && FOLLOW_UP_REFERENCE_PATTERN.test(text)) return 'follow-up';
  if (REVIEW_PATTERN.test(text) && !hasEdit) return 'review';
  if (PLAN_PATTERN.test(text) && /\b(create|write|draft|make)\b/i.test(text)) return 'plan';
  if (BUGFIX_PATTERN.test(text) && hasEdit) return 'bugfix';
  if (hasEdit) return 'feature';
  return 'general';
}

/**
 * Evaluates Dimension 1: Prompt Clarity & Context Readiness (max 20 points).
 *
 * Clarity is judged by a model against the fixed checklist in `promptClarity.ts`
 * and scored here by code. Without checklist answers (no model configured, the
 * call failed, or it is still running) only facts are reported — nothing is
 * guessed from word lists, which proved unable to tell a clear prompt from a
 * vague one:
 * - Tool access vs edit request (-6) — a hard blocker
 * - Identifiers the code index has never heard of (-4)
 * - Context window headroom (-4)
 *
 * Fix chips stay grounded in the workspace: a missing target offers the files
 * whose names match the prompt, a missing "done" offers the matching test.
 */
export function analyzePromptSignals(input: {
  promptText: string;
  toolMode?: AgentToolMode;
  sessionMode?: SessionMode;
  issueKey?: string;
  contextTokens?: number;
  contextLimit?: number;
  priorContext?: FeedbackPriorContext;
  workspaceHints?: FeedbackWorkspaceHints;
  clarity?: ClarityAssessment;
}): PromptSignalAnalysis {
  const maxPoints = 20;
  let earnedPoints = maxPoints;
  const findings: FeedbackFinding[] = [];

  const text = input.promptText.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasPriorTurns = (input.priorContext?.turnCount ?? 0) > 0;
  const answers = input.clarity?.status === 'checked' ? input.clarity.answers : undefined;
  const heuristicIntent = classifyPromptIntent(text, hasPriorTurns);
  // The model's reading of what kind of prompt this is wins over the keyword guess
  const intent: PromptIntent = answers
    ? answers.kind === 'question'
      ? 'question'
      : answers.kind === 'conversation'
        ? 'follow-up'
        : heuristicIntent === 'question' || heuristicIntent === 'follow-up' || heuristicIntent === 'general'
          ? hasActionIntent(text) && BUGFIX_PATTERN.test(text) ? 'bugfix' : 'feature'
          : heuristicIntent
    : heuristicIntent;
  const hasEditIntent = hasActionIntent(text);
  const namesKnownSymbol = Boolean(input.workspaceHints?.symbols?.some(symbol => symbol.found));
  const hasScopeAnchor = FILE_OR_PATH_ANCHOR_PATTERN.test(text) || TICKET_ANCHOR_PATTERN.test(text) || namesKnownSymbol;
  const hasVerificationClause = VERIFICATION_PATTERN.test(text);
  const inheritsContext = hasPriorTurns && (intent === 'follow-up' || answers?.kind === 'conversation');
  const isQuestionLike = intent === 'question' || intent === 'review';

  const effectiveToolMode: AgentToolMode = input.toolMode ?? 'full';
  const effectiveSessionMode: SessionMode = input.sessionMode ?? 'chat';

  // 1. Clarity checklist (model-read, code-scored)
  if (answers) {
    const fileCandidates = rankFileCandidates(text, input.workspaceHints);
    const testCommand = pickTestCommand(text, input.workspaceHints, fileCandidates.map(c => c.path));
    const pin = (filePath: string): FeedbackRemediation => ({
      kind: 'pin-file',
      label: `Pin @${filePath.split('/').pop()}`,
      description: `Anchor the prompt to \`${filePath}\` so the agent starts in the right file.`,
      targetId: filePath,
      suggestedPromptSnippet: `in @${filePath}`
    });
    const scored = scoreClarityAnswers(answers, {
      ...(fileCandidates[0] ? { targetFix: { ...pin(fileCandidates[0].path), alternatives: fileCandidates.slice(1).map(c => pin(c.path)) } } : {}),
      ...(testCommand && answers.checks.target.answer !== 'no' && answers.checks.outcome.answer !== 'no'
        ? {
            doneFix: {
              kind: 'add-test-command' as const,
              label: `Test: ${testCommand.label}`,
              description: `Ask the agent to run \`${testCommand.command}\` before finishing.`,
              targetId: testCommand.command,
              suggestedPromptSnippet: `and verify with \`${testCommand.command}\``
            }
          }
        : {})
    });
    earnedPoints -= scored.deduction;
    findings.push(...scored.findings);
  }

  // 2. Identifiers the code index has never heard of — a typo or a name the agent will chase in vain
  const unknownNames = unknownIdentifiers(input.workspaceHints, text);
  if (unknownNames.length > 0) {
    const deduction = 4;
    earnedPoints -= deduction;
    const list = unknownNames.map(name => `\`${name}\``).join(', ');
    findings.push({
      id: 'prompt-unknown-symbol',
      dimension: 'prompt-clarity',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `${list} ${unknownNames.length === 1 ? "isn't" : "aren't"} in the code index`,
      evidence: `The code index has no symbol or file named ${list}, so the agent will search for something that doesn't exist.`,
      remediation: {
        kind: 'refine-prompt',
        label: 'Check the name',
        description: `Check the spelling of ${list}, or name the file it lives in.`
      }
    });
  }

  // 3. Edit request against restricted tool access — a hard blocker for any intent
  if (hasEditIntent && !isQuestionLike && effectiveSessionMode === 'chat' && effectiveToolMode !== 'full') {
    const deduction = 6;
    earnedPoints -= deduction;
    findings.push({
      id: 'prompt-tool-mode-conflict',
      dimension: 'prompt-clarity',
      severity: 'critical',
      deltaPoints: -deduction,
      title: `Session is \`${effectiveToolMode}\` but the prompt asks for edits`,
      evidence: `Prompt requests file changes while tool access is \`${effectiveToolMode}\`, so the agent cannot write.`,
      remediation: {
        kind: 'change-tool-mode',
        label: 'Switch to Full Access',
        description: 'Switch tool access to Full so the agent can write files and run verification commands.',
        targetId: 'full'
      }
    });
  }

  // 4. Context window pressure
  if (typeof input.contextTokens === 'number' && typeof input.contextLimit === 'number' && input.contextLimit > 0) {
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
        title: `Context window is ${pct}% full`,
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

  const signals: FeedbackSignal[] = [{ label: `Intent: ${promptIntentLabel(intent)}`, tone: 'neutral' }];
  if (answers) {
    for (const item of CLARITY_CHECKLIST) {
      const check = answers.checks[item.id];
      if (item.instructionOnly && answers.kind !== 'instruction') continue;
      const good = item.badAnswer === 'no' ? check.answer === 'yes' : check.answer === 'no';
      signals.push({ label: `${good ? '✓' : '!'} ${item.id}`, tone: good ? 'good' : check.answer === 'partial' ? 'warn' : 'bad' });
    }
  } else {
    signals.push({ label: input.clarity?.status === 'pending' ? 'Clarity: checking…' : 'Clarity: not checked', tone: 'neutral' });
  }
  for (const symbol of (input.workspaceHints?.symbols ?? []).filter(symbol => symbol.found).slice(0, 2)) {
    signals.push({ label: `✓ ${symbol.name} found`, tone: 'good' });
  }

  const summary =
    !answers
      ? 'Clarity not checked — facts only.'
      : earnedPoints === maxPoints
        ? 'Clear target, outcome, and finish line.'
        : findings.map(f => f.title).join('; ');

  return {
    dimension: {
      dimension: 'prompt-clarity',
      label: 'Prompt Clarity & Context',
      earnedPoints,
      maxPoints,
      normalizedScore,
      summary,
      signals
    },
    findings,
    intent,
    hasEditIntent,
    hasScopeAnchor,
    hasVerificationClause,
    wordCount,
    inheritsContext
  };
}
