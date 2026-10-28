import type { AgentSessionRecord, SessionMode } from '../agentTypes';
import { detectSkillUses } from '../skillUsage';
import type {
  FeedbackAgentCandidate,
  FeedbackDimensionScore,
  FeedbackFinding,
  FeedbackSkillCandidate,
  UserFeedbackInput
} from './feedbackTypes';

export interface CapabilityAlignmentAnalysis {
  dimension: FeedbackDimensionScore;
  findings: FeedbackFinding[];
  skillsAttached: string[];
  skillsDetected: string[];
  skillsRecommended: string[];
  agentProfileId?: string;
  recommendedAgentProfileId?: string;
}

interface BuiltInSkillHeuristic {
  name: string;
  description: string;
  promptPattern: RegExp;
  pathPattern?: RegExp;
}

const BUILTIN_SKILL_HEURISTICS: readonly BuiltInSkillHeuristic[] = [
  {
    name: 'plan-authoring',
    description: 'Write markdown plan items (features, stories, tasks, bugs) that a folder-backed Praxis board can parse.',
    promptPattern: /\b(feature\s+plan|story\s+plan|plan\s+file|plan\s+items?|docs\/plans|plan-authoring|create\s+a\s+plan|board\s+items?|task-\d+|fx-bf-\d+|fx-be-\d+)\b/i,
    pathPattern: /(?:^|\/)docs\/plans\//i
  },
  {
    name: 'praxis-addon-builder',
    description: 'Build, validate, package, and publish Praxis add-ons for themes, surface packs, agents, and workflow templates.',
    promptPattern: /\b(add-?on|marketplace\s+package|surface\s+pack\s+add-?on|praxis-addon-builder|addon\.praxis\.json)\b/i,
    pathPattern: /addon\.praxis\.json|packages\/core\/src\/marketplace/i
  },
  {
    name: 'human-review',
    description: 'Conduct an interactive human review of completed work.',
    promptPattern: /\b(human\s+review|interactive\s+review\s+walkthrough|human-review)\b/i
  },
  {
    name: 'praxis-scheduled-runs',
    description: 'Author or update scheduled workflow run request files under .praxis/scheduled-runs/.',
    promptPattern: /\b(scheduled\s+run|schedule\s+workflow|\.praxis\/scheduled-runs)\b/i,
    pathPattern: /\.praxis\/scheduled-runs\//i
  }
];

function recommendAgentProfileForMode(
  mode: SessionMode,
  promptText: string,
  currentProfileId: string | undefined,
  availableAgents: readonly FeedbackAgentCandidate[]
): { recommendedId?: string; mismatchReason?: string } {
  const lowerPrompt = promptText.toLowerCase();
  const isPlanningGoal =
    mode === 'analysis' ||
    /\b(create\s+a\s+plan|feature\s+plan|decompose|architecture\s+plan)\b/i.test(lowerPrompt);
  const isReviewGoal =
    mode === 'review' ||
    /\b(code\s+review|security\s+review|audit\s+changes)\b/i.test(lowerPrompt);

  if (!currentProfileId) {
    return {};
  }

  const currentLower = currentProfileId.toLowerCase();
  if (isReviewGoal && /implementer|coder|builder/.test(currentLower)) {
    const candidate = availableAgents.find(a => /review/i.test(a.id))?.id ?? 'praxis-reviewer';
    return {
      recommendedId: candidate,
      mismatchReason: `Agent profile \`${currentProfileId}\` is tuned for implementation, while this session is in \`${mode}\` / review mode.`
    };
  }
  if (isPlanningGoal && mode === 'analysis' && /implementer/.test(currentLower)) {
    const candidate = availableAgents.find(a => /plan|architect/i.test(a.id))?.id ?? 'praxis-planner';
    return {
      recommendedId: candidate,
      mismatchReason: `Agent profile \`${currentProfileId}\` is tuned for code edits, while this session is in \`analysis\` mode.`
    };
  }
  if (mode === 'chat' && !isPlanningGoal && !isReviewGoal && /reviewer/.test(currentLower) && /\b(implement|build|write|fix)\b/i.test(lowerPrompt)) {
    const candidate = availableAgents.find(a => /implement/i.test(a.id))?.id ?? 'praxis-implementer';
    return {
      recommendedId: candidate,
      mismatchReason: `Agent profile \`${currentProfileId}\` is a read-only reviewer, while the prompt asks to implement changes.`
    };
  }
  return {};
}

/**
 * Evaluates Dimension 3: Skill & Agent Alignment (max 20 points).
 *
 * Compares `activeSkills` and `detectedSkills` against available workspace/user skills
 * and built-in domain heuristics, plus checks whether `profileId` aligns with `sessionMode`.
 */
export function analyzeCapabilityAlignment(input: {
  promptText: string;
  sessionMode?: SessionMode;
  profileId?: string;
  activeSkills?: readonly string[];
  session?: AgentSessionRecord;
  touchedPaths?: readonly string[];
  availableSkills?: readonly FeedbackSkillCandidate[];
  availableAgents?: readonly FeedbackAgentCandidate[];
  userFeedback?: UserFeedbackInput;
}): CapabilityAlignmentAnalysis {
  const maxPoints = 20;
  let earnedPoints = maxPoints;
  const findings: FeedbackFinding[] = [];

  const attachedSet = new Set<string>(
    [...(input.activeSkills ?? []), ...(input.session?.activeSkills ?? [])]
      .map(s => s.trim())
      .filter(Boolean)
  );

  const detectedFromEvents = input.session?.events
    ? detectSkillUses(input.session.events).map(s => s.skillId)
    : [];
  const detectedSet = new Set<string>(
    [
      ...(input.session?.detectedSkills?.map(d => d.skillId) ?? []),
      ...detectedFromEvents
    ]
      .map(s => s.trim())
      .filter(Boolean)
  );

  const usedSkills = new Set<string>([...attachedSet, ...detectedSet]);
  const touchedPaths = input.touchedPaths ?? [];
  const promptText = input.promptText.trim();
  const catalogSkills = input.availableSkills ?? [];

  const recommendedMap = new Map<string, { reason: string; matchedByPath: boolean }>();

  // 1. Check built-in domain skill heuristics (only if present in catalog or no catalog filter restricts it)
  const catalogNames = new Set(catalogSkills.map(s => s.name));
  for (const heuristic of BUILTIN_SKILL_HEURISTICS) {
    const isAvailable = catalogSkills.length === 0 || catalogNames.has(heuristic.name);
    if (!isAvailable || usedSkills.has(heuristic.name)) continue;

    const matchedByPath = Boolean(
      heuristic.pathPattern && touchedPaths.some(p => heuristic.pathPattern!.test(p))
    );
    const matchedByPrompt = heuristic.promptPattern.test(promptText);

    if (matchedByPath) {
      const matchingPath = touchedPaths.find(p => heuristic.pathPattern!.test(p))!;
      recommendedMap.set(heuristic.name, {
        reason: `Session touched \`${matchingPath}\`, which matches the \`${heuristic.name}\` skill.`,
        matchedByPath: true
      });
    } else if (matchedByPrompt) {
      recommendedMap.set(heuristic.name, {
        reason: `Prompt goals match the \`${heuristic.name}\` skill (${heuristic.description})`,
        matchedByPath: false
      });
    }
  }

  // 2. Check discovered catalog skills by trigger keywords
  for (const skill of catalogSkills) {
    const skillName = skill.name.trim();
    if (!skillName || usedSkills.has(skillName) || recommendedMap.has(skillName)) continue;

    const matchedTrigger = (skill.triggers ?? []).find(trigger => {
      const clean = trigger.trim().toLowerCase();
      if (clean.length < 3) return false;
      const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(promptText);
    });

    if (matchedTrigger) {
      recommendedMap.set(skillName, {
        reason: `Prompt matched trigger "${matchedTrigger}" for skill \`${skillName}\` (${skill.description}).`,
        matchedByPath: false
      });
    }
  }

  for (const [skillName, info] of recommendedMap.entries()) {
    const deduction = info.matchedByPath ? 8 : 6;
    earnedPoints -= deduction;
    findings.push({
      id: `skill-missed-${skillName}`,
      dimension: 'skill-agent-alignment',
      severity: info.matchedByPath ? 'critical' : 'warning',
      deltaPoints: -deduction,
      title: `Missed trigger-matched skill: \`${skillName}\``,
      evidence: info.reason,
      remediation: {
        kind: 'attach-skill',
        label: `+ Attach ${skillName}`,
        description: `Attach the \`${skillName}\` skill so the agent follows its specialized instructions.`,
        targetId: skillName,
        suggestedPromptSnippet: `Follow the \`${skillName}\` skill guidelines.`
      }
    });
  }

  // 3. Check Agent Hub profile alignment
  const effectiveMode: SessionMode =
    input.sessionMode ?? input.session?.mode ?? input.session?.taskDefinition?.sessionMode ?? 'chat';
  const currentProfileId =
    input.profileId ?? input.session?.profileId ?? input.session?.agentId;
  const agentCheck = recommendAgentProfileForMode(
    effectiveMode,
    promptText,
    currentProfileId,
    input.availableAgents ?? []
  );

  if (agentCheck.recommendedId && agentCheck.mismatchReason) {
    const deduction = 5;
    earnedPoints -= deduction;
    findings.push({
      id: 'agent-profile-mode-mismatch',
      dimension: 'skill-agent-alignment',
      severity: 'warning',
      deltaPoints: -deduction,
      title: `Agent profile \`${currentProfileId}\` mismatches session mode/intent`,
      evidence: agentCheck.mismatchReason,
      remediation: {
        kind: 'select-agent',
        label: `Switch to ${agentCheck.recommendedId}`,
        description: `Select \`${agentCheck.recommendedId}\` to match the session's ${effectiveMode} workflow.`,
        targetId: agentCheck.recommendedId
      }
    });
  }

  // 4. User feedback friction tags for skills/agents
  if (input.userFeedback?.frictionTags?.includes('missed-skill') && recommendedMap.size === 0) {
    const deduction = 5;
    earnedPoints -= deduction;
    findings.push({
      id: 'user-flagged-missed-skill',
      dimension: 'skill-agent-alignment',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'User feedback flagged a missed skill',
      evidence: input.userFeedback.notes?.trim()
        ? `User note: "${input.userFeedback.notes.trim()}"`
        : 'User marked `missed-skill` in session feedback.',
      remediation: {
        kind: 'attach-skill',
        label: 'Attach Relevant Workspace Skill',
        description: 'Attach the domain skill from the Agent Hub before running the next turn.'
      }
    });
  }

  if (input.userFeedback?.frictionTags?.includes('wrong-agent-or-mode') && !agentCheck.recommendedId) {
    const deduction = 4;
    earnedPoints -= deduction;
    findings.push({
      id: 'user-flagged-wrong-agent-mode',
      dimension: 'skill-agent-alignment',
      severity: 'warning',
      deltaPoints: -deduction,
      title: 'User feedback flagged agent profile or mode selection',
      evidence: 'User marked `wrong-agent-or-mode` in session feedback.',
      remediation: {
        kind: 'select-agent',
        label: 'Review Agent Profile & Mode',
        description: 'Align the composer mode (Chat / Analysis / Review) and selected Agent Hub profile.'
      }
    });
  }

  earnedPoints = Math.max(0, Math.min(maxPoints, earnedPoints));
  const normalizedScore = Math.round((earnedPoints / maxPoints) * 100);

  const skillsAttached = [...attachedSet].sort();
  const skillsDetected = [...detectedSet].sort();
  const skillsRecommended = [...recommendedMap.keys()].sort();

  const summary =
    earnedPoints === maxPoints
      ? usedSkills.size > 0
        ? `Aligned (${[...usedSkills].join(', ')}).`
        : 'Agent profile and skills are aligned with the prompt.'
      : findings.map(f => f.title).join('; ');

  return {
    dimension: {
      dimension: 'skill-agent-alignment',
      label: 'Skill & Agent Alignment',
      earnedPoints,
      maxPoints,
      normalizedScore,
      summary
    },
    findings,
    skillsAttached,
    skillsDetected,
    skillsRecommended,
    ...(currentProfileId ? { agentProfileId: currentProfileId } : {}),
    ...(agentCheck.recommendedId ? { recommendedAgentProfileId: agentCheck.recommendedId } : {})
  };
}
