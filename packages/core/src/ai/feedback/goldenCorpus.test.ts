import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AgentSessionRecord } from '../agentTypes';
import type { FeedbackEvaluationInput } from './feedbackTypes';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';

const CANONICAL_SKILLS = [
  {
    name: 'plan-authoring',
    description: 'Write markdown plan items (features, stories, tasks, bugs) that a folder-backed Praxis board can parse.',
    triggers: ['plan', 'feature', 'story', 'task']
  },
  {
    name: 'praxis-addon-builder',
    description: 'Build, validate, package, and publish Praxis add-ons.',
    triggers: ['addon', 'surface-pack', 'marketplace']
  },
  {
    name: 'human-review',
    description: 'Conduct an interactive human review of completed work.',
    triggers: ['human-review', 'walkthrough']
  }
];

const CANONICAL_AGENTS = [
  { id: 'praxis-planner', name: 'Praxis Planner', description: 'Plans features and architecture' },
  { id: 'praxis-implementer', name: 'Praxis Implementer', description: 'Implements and verifies code changes' },
  { id: 'praxis-reviewer', name: 'Praxis Reviewer', description: 'Reviews code and tickets' }
];

function buildCorpusSession(id: string, overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    issueKey: `CORPUS-${id}`,
    sessionId: `sess-corpus-${id}`,
    state: 'completed',
    toolMode: 'full',
    mode: 'chat',
    profileId: 'praxis-implementer',
    activeSkills: [],
    taskDefinition: {
      kind: 'general',
      goal: 'Implement feature in packages/core/src/index.ts and verify with npm run test:core',
      scope: 'packages/core',
      definitionOfDone: 'Tests pass'
    },
    events: [],
    stepCount: 2,
    startedAt: '2026-10-28T10:00:00Z',
    completedAt: '2026-10-28T10:01:00Z',
    ...overrides
  };
}

describe('Golden Deterministic Scoring Corpus (TASK-494)', () => {
  const archetypes: Array<{
    name: string;
    input: FeedbackEvaluationInput;
    expectedScore: number;
    expectedGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    expectedDimensions: [number, number, number, number, number];
    expectedFindingIds: string[];
  }> = [
    {
      name: '1. Exemplary prompt-readiness (clear scope, full tools, attached skill, verification)',
      input: {
        kind: 'prompt-readiness',
        promptText: 'Create feature plan FX-BF-112 under apps/praxis-desktop/docs/plans/features/ and verify with markdownPlanParser.test.js.',
        toolMode: 'full',
        sessionMode: 'chat',
        profileId: 'praxis-planner',
        activeSkills: ['plan-authoring'],
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z'
      },
      expectedScore: 100,
      expectedGrade: 'A',
      expectedDimensions: [20, 25, 20, 15, 20],
      expectedFindingIds: []
    },
    {
      name: '2. Vague read-only edit prompt missing plan-authoring skill and verification',
      input: {
        kind: 'prompt-readiness',
        promptText: 'Create a feature plan with stories and tasks for session feedback',
        toolMode: 'read-only',
        sessionMode: 'chat',
        activeSkills: [],
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z'
      },
      // Prompt Clarity: 20 - 3 (low-specificity) - 4 (no anchor) - 4 (no verify) - 6 (toolMode conflict) = 3/20
      // Skill Alignment: 20 - 6 (missed plan-authoring) = 14/20
      // MCP Readiness: 15/15
      // Normalized pre-send: round((3 + 14 + 15) / 55 * 100) = round(32 / 55 * 100) = 58 F
      expectedScore: 58,
      expectedGrade: 'F',
      expectedDimensions: [3, 25, 14, 15, 20],
      expectedFindingIds: [
        'prompt-tool-mode-conflict',
        'skill-missed-plan-authoring',
        'prompt-missing-scope-anchor',
        'prompt-missing-verification',
        'prompt-low-specificity'
      ]
    },
    {
      name: '3. Ultra-terse prompt ("fix bug")',
      input: {
        kind: 'prompt-readiness',
        promptText: 'fix bug',
        toolMode: 'full',
        sessionMode: 'chat',
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z'
      },
      // Prompt Clarity: 20 - 6 (too terse) - 4 (missing anchor) - 4 (missing verification) = 6/20
      // Skill: 20/20, MCP: 15/15 -> round(41/55*100) = 75 C
      expectedScore: 75,
      expectedGrade: 'C',
      expectedDimensions: [6, 25, 20, 15, 20],
      expectedFindingIds: [
        'prompt-too-terse',
        'prompt-missing-scope-anchor',
        'prompt-missing-verification'
      ]
    },
    {
      name: '4. Exemplary session execution (code_intelligence + clean write + test verification)',
      input: {
        kind: 'session-execution',
        promptText: 'Implement scorer in packages/core/src/ai/feedback/sessionFeedbackScorer.ts and run npm run test:core',
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z',
        session: buildCorpusSession('4', {
          events: [
            {
              timestamp: '2026-10-28T10:00:01Z',
              type: 'tool_complete',
              summary: 'Searched symbols',
              data: { toolName: 'code_intelligence', kind: 'search', ok: true }
            },
            {
              timestamp: '2026-10-28T10:00:05Z',
              type: 'tool_complete',
              summary: 'Wrote file',
              data: {
                toolName: 'write_file',
                kind: 'write',
                ok: true,
                fileChanges: [{ path: 'packages/core/src/ai/feedback/sessionFeedbackScorer.ts' }]
              }
            },
            {
              timestamp: '2026-10-28T10:00:10Z',
              type: 'tool_complete',
              summary: 'Ran tests',
              data: {
                toolName: 'run_shell',
                kind: 'shell',
                ok: true,
                args: { command: 'npm run test:core' }
              }
            }
          ]
        })
      },
      expectedScore: 100,
      expectedGrade: 'A',
      expectedDimensions: [20, 25, 20, 15, 20],
      expectedFindingIds: []
    },
    {
      name: '5. Session with shell grep workaround instead of code_intelligence and missed plan-authoring on touched path',
      input: {
        kind: 'session-execution',
        promptText: 'Update apps/praxis-desktop/docs/plans/features/fx-bf-112/feature.md and run npm run test:core',
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z',
        session: buildCorpusSession('5', {
          activeSkills: [],
          events: [
            {
              timestamp: '2026-10-28T10:00:01Z',
              type: 'tool_complete',
              summary: 'grep 1',
              data: { toolName: 'run_shell', kind: 'shell', ok: true, args: { command: 'grep -rn "FX-BF" apps/' } }
            },
            {
              timestamp: '2026-10-28T10:00:02Z',
              type: 'tool_complete',
              summary: 'grep 2',
              data: { toolName: 'run_shell', kind: 'shell', ok: true, args: { command: 'grep -rn "Status" apps/' } }
            },
            {
              timestamp: '2026-10-28T10:00:05Z',
              type: 'tool_complete',
              summary: 'Wrote plan',
              data: {
                toolName: 'write_file',
                kind: 'write',
                ok: true,
                fileChanges: [{ path: 'apps/praxis-desktop/docs/plans/features/fx-bf-112/feature.md' }]
              }
            },
            {
              timestamp: '2026-10-28T10:00:10Z',
              type: 'tool_complete',
              summary: 'Verified parser',
              data: { toolName: 'run_shell', kind: 'shell', ok: true, args: { command: 'npm run test:core' } }
            }
          ]
        })
      },
      // Prompt: 20, Tool: 25, Skill: 20 - 8 (matched path) = 12, MCP: 15 - 6 (4+2 grep) = 9, Outcome: 20 -> 86 B
      expectedScore: 86,
      expectedGrade: 'B',
      expectedDimensions: [20, 25, 12, 9, 20],
      expectedFindingIds: ['skill-missed-plan-authoring', 'mcp-shell-grep-workaround']
    },
    {
      name: '6. Session with consecutive failed edit retry loop and unverified writes',
      input: {
        kind: 'session-execution',
        promptText: 'Update packages/core/src/index.ts and verify with npm run check-types',
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z',
        session: buildCorpusSession('6', {
          events: [
            {
              timestamp: '2026-10-28T10:00:01Z',
              type: 'tool_complete',
              summary: 'Failed edit 1',
              data: { toolName: 'edit_file', kind: 'write', ok: false, argsSummary: 'packages/core/src/index.ts' }
            },
            {
              timestamp: '2026-10-28T10:00:02Z',
              type: 'tool_complete',
              summary: 'Failed edit 2',
              data: { toolName: 'edit_file', kind: 'write', ok: false, argsSummary: 'packages/core/src/index.ts' }
            },
            {
              timestamp: '2026-10-28T10:00:03Z',
              type: 'tool_complete',
              summary: 'Failed edit 3',
              data: { toolName: 'edit_file', kind: 'write', ok: false, argsSummary: 'packages/core/src/index.ts' }
            },
            {
              timestamp: '2026-10-28T10:00:04Z',
              type: 'tool_complete',
              summary: 'Wrote index.ts',
              data: {
                toolName: 'write_file',
                kind: 'write',
                ok: true,
                fileChanges: [{ path: 'packages/core/src/index.ts' }]
              }
            }
          ]
        })
      },
      // Prompt: 20
      // Tool: 3/4 failed (75% * 15 = 11 + 2 = 13 capped at 10) -> -10; retryLoopCount=2 -> -(3 + 4) = -7 => 25 - 17 = 8
      // Skill: 20, MCP: 15, Outcome: 20 - 6 (unverified write) = 14 -> total = 77 C
      expectedScore: 77,
      expectedGrade: 'C',
      expectedDimensions: [20, 8, 20, 15, 14],
      expectedFindingIds: ['tool-failed-calls', 'tool-retry-loop', 'outcome-unverified-writes']
    },
    {
      name: '7. Session with Agent Hub profile mismatch (praxis-implementer in review mode) and high context occupancy',
      input: {
        kind: 'session-execution',
        promptText: 'Perform a security review of packages/core/src/ai/aiSessionManager.ts',
        sessionMode: 'review',
        toolMode: 'read-only',
        profileId: 'praxis-implementer',
        contextTokens: 180_000,
        contextLimit: 200_000,
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z',
        session: buildCorpusSession('7', {
          mode: 'review',
          toolMode: 'read-only',
          profileId: 'praxis-implementer',
          contextTokens: 180_000,
          contextLimit: 200_000,
          events: [
            {
              timestamp: '2026-10-28T10:00:01Z',
              type: 'tool_complete',
              summary: 'Read file',
              data: { toolName: 'read_file', kind: 'read', ok: true, args: { path: 'packages/core/src/ai/aiSessionManager.ts' } }
            }
          ]
        })
      },
      // Prompt: 20 - 4 (context 90%) = 16; Tool: 25; Skill: 20 - 5 (agent mismatch) = 15; MCP: 15; Outcome: 20 -> 91 A
      expectedScore: 91,
      expectedGrade: 'A',
      expectedDimensions: [16, 25, 15, 15, 20],
      expectedFindingIds: ['agent-profile-mode-mismatch', 'prompt-context-pressure']
    },
    {
      name: '8. Failed session with negative user feedback verdict and friction tags',
      input: {
        kind: 'session-execution',
        promptText: 'Implement marketplace installer in packages/core/src/marketplace/marketplaceService.ts and run tests',
        availableSkills: CANONICAL_SKILLS,
        availableAgents: CANONICAL_AGENTS,
        codeIntelligenceAvailable: true,
        evaluatedAt: '2026-10-28T12:00:00Z',
        userFeedback: {
          targetKind: 'session',
          issueKey: 'CORPUS-8',
          promptText: 'Implement marketplace installer',
          verdict: 'failed-goal',
          frictionTags: ['wrong-scope', 'ignored-instructions'],
          notes: 'Modified unrelated files and broke build.',
          createdAt: '2026-10-28T12:05:00Z'
        },
        session: buildCorpusSession('8', {
          state: 'failed',
          lastError: 'Build failed with exit code 1',
          events: [
            {
              timestamp: '2026-10-28T10:00:01Z',
              type: 'tool_complete',
              summary: 'Wrote marketplaceService.ts',
              data: {
                toolName: 'write_file',
                kind: 'write',
                ok: true,
                fileChanges: [{ path: 'packages/core/src/marketplace/marketplaceService.ts' }]
              }
            }
          ]
        })
      },
      // Prompt: 20; Tool: 25; Skill: 20 - 8 (missed praxis-addon-builder on marketplace path) = 12; MCP: 15;
      // Outcome: max(0, 20 - 10 (failed) - 6 (unverified) - 10 (user failed-goal) - 4 (2 friction tags)) = 0
      // Total: 20 + 25 + 12 + 15 + 0 = 72 C
      expectedScore: 72,
      expectedGrade: 'C',
      expectedDimensions: [20, 25, 12, 15, 0],
      expectedFindingIds: [
        'outcome-session-failed',
        'user-verdict-failed-goal',
        'skill-missed-plan-authoring'.replace('plan-authoring', 'praxis-addon-builder'),
        'outcome-unverified-writes',
        'user-friction-tags'
      ]
    }
  ];

  for (const archetype of archetypes) {
    it(`scores archetype deterministically: ${archetype.name}`, () => {
      const report1 = evaluateSessionOrPrompt(archetype.input);
      const report2 = evaluateSessionOrPrompt({
        ...archetype.input,
        availableSkills: [...(archetype.input.availableSkills ?? [])].reverse(),
        availableAgents: [...(archetype.input.availableAgents ?? [])].reverse()
      });

      assert.equal(report1.overallScore, archetype.expectedScore);
      assert.equal(report1.grade, archetype.expectedGrade);
      assert.deepEqual(
        report1.dimensions.map(d => d.earnedPoints),
        archetype.expectedDimensions
      );
      assert.deepEqual(
        report1.findings.map(f => f.id),
        archetype.expectedFindingIds
      );

      // Reproducibility & catalog-order invariance
      assert.equal(report1.inputDigest, report2.inputDigest);
      assert.deepEqual(report1, report2);
    });
  }
});
