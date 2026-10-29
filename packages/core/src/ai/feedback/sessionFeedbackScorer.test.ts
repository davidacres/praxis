import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AgentSessionRecord } from '../agentTypes';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';

function makeBaseSession(overrides?: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    issueKey: 'FX-BF-112',
    sessionId: 'sess-112',
    state: 'completed',
    toolMode: 'full',
    mode: 'chat',
    profileId: 'praxis-implementer',
    activeSkills: ['plan-authoring'],
    taskDefinition: {
      kind: 'general',
      goal: 'Implement deterministic scoring in packages/core/src/ai/feedback/sessionFeedbackScorer.ts and verify with npm run test:core.',
      scope: 'packages/core/src/ai/feedback',
      definitionOfDone: 'Unit tests pass'
    },
    events: [
      {
        timestamp: '2026-10-28T10:00:01Z',
        type: 'tool_complete',
        summary: 'Found symbol evaluateSessionOrPrompt',
        data: {
          toolName: 'code_intelligence',
          kind: 'search',
          ok: true,
          args: { tool: 'find_symbol' }
        }
      },
      {
        timestamp: '2026-10-28T10:00:05Z',
        type: 'tool_complete',
        summary: 'Wrote sessionFeedbackScorer.ts',
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
        summary: 'Ran unit tests',
        data: {
          toolName: 'run_shell',
          kind: 'shell',
          ok: true,
          args: { command: 'npm run test:core' }
        }
      }
    ],
    stepCount: 3,
    startedAt: '2026-10-28T10:00:00Z',
    completedAt: '2026-10-28T10:00:15Z',
    ...overrides
  };
}

describe('sessionFeedbackScorer (TASK-489)', () => {
  it('scores a clean, well-scoped, verified session at 100 A', () => {
    const session = makeBaseSession();
    const report = evaluateSessionOrPrompt({
      kind: 'session-execution',
      promptText: session.taskDefinition.goal,
      session,
      codeIntelligenceAvailable: true
    });

    assert.equal(report.overallScore, 100);
    assert.equal(report.grade, 'A');
    assert.equal(report.findings.length, 0);
    assert.equal(report.dimensions.length, 5);
    assert.deepEqual(
      report.dimensions.map(d => [d.dimension, d.earnedPoints, d.maxPoints]),
      [
        ['prompt-clarity', 20, 20],
        ['tool-efficiency', 25, 25],
        ['skill-agent-alignment', 20, 20],
        ['mcp-leverage', 15, 15],
        ['outcome-verification', 20, 20]
      ]
    );
  });

  it('detects pre-send read-only contradiction, missing scope, and missed plan-authoring skill', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'Create a feature plan with stories and tasks for session feedback',
      toolMode: 'read-only',
      sessionMode: 'chat',
      activeSkills: [],
      codeIntelligenceAvailable: true
    });

    assert.equal(report.kind, 'prompt-readiness');
    assert.equal(report.intent, 'plan');
    assert.ok(report.overallScore < 80, `Expected < 80, got ${report.overallScore}`);
    const findingIds = report.findings.map(f => f.id);
    assert.ok(findingIds.includes('prompt-tool-mode-conflict'));
    assert.ok(findingIds.includes('skill-missed-plan-authoring'));
    // A planning prompt is not asked for a test command
    assert.ok(!findingIds.includes('prompt-missing-verification'));
    assert.ok(report.inventory.skillsRecommended.includes('plan-authoring'));
  });

  it('penalizes consecutive failed tool retries, raw shell grep workarounds, and unverified writes', () => {
    const session = makeBaseSession({
      activeSkills: [],
      events: [
        {
          timestamp: '2026-10-28T10:00:01Z',
          type: 'tool_complete',
          summary: 'grep search 1',
          data: { toolName: 'run_shell', kind: 'shell', ok: true, args: { command: 'grep -rn "scorer" packages/' } }
        },
        {
          timestamp: '2026-10-28T10:00:02Z',
          type: 'tool_complete',
          summary: 'grep search 2',
          data: { toolName: 'run_shell', kind: 'shell', ok: true, args: { command: 'grep -rn "feedback" packages/' } }
        },
        {
          timestamp: '2026-10-28T10:00:03Z',
          type: 'tool_complete',
          summary: 'Failed edit 1',
          data: { toolName: 'edit_file', kind: 'write', ok: false, argsSummary: 'apps/praxis-desktop/docs/plans/features/fx-bf-112/feature.md' }
        },
        {
          timestamp: '2026-10-28T10:00:04Z',
          type: 'tool_complete',
          summary: 'Failed edit 2',
          data: { toolName: 'edit_file', kind: 'write', ok: false, argsSummary: 'apps/praxis-desktop/docs/plans/features/fx-bf-112/feature.md' }
        },
        {
          timestamp: '2026-10-28T10:00:05Z',
          type: 'tool_complete',
          summary: 'Wrote plan file',
          data: {
            toolName: 'write_file',
            kind: 'write',
            ok: true,
            fileChanges: [{ path: 'apps/praxis-desktop/docs/plans/features/fx-bf-112/feature.md' }]
          }
        }
      ]
    });

    const report = evaluateSessionOrPrompt({
      kind: 'session-execution',
      promptText: session.taskDefinition.goal,
      session,
      codeIntelligenceAvailable: true
    });

    const findingIds = report.findings.map(f => f.id);
    // Two failed in-place edits before any read are one root cause, not generic failures
    assert.ok(findingIds.includes('tool-blind-edit-loop:feature.md'));
    assert.ok(!findingIds.includes('tool-failed-calls'));
    assert.ok(findingIds.includes('mcp-shell-grep-workaround'));
    const blind = report.findings.find(f => f.id === 'tool-blind-edit-loop:feature.md')!;
    assert.deepEqual(blind.stepIndices, [3, 4]);
    assert.equal(blind.steps?.[0].timestamp, '2026-10-28T10:00:03Z');
    assert.match(blind.evidence, /only succeeded|finally applied/);
    // The path-matched skill miss cites the step that wrote the plan file
    assert.deepEqual(report.findings.find(f => f.id === 'skill-missed-plan-authoring')?.stepIndices, [5]);
    assert.match(report.diagnosis?.headline ?? '', /^Completed with .*avoidable tool thrashing/);
    assert.ok(findingIds.includes('skill-missed-plan-authoring'));
    assert.ok(findingIds.includes('outcome-unverified-writes'));
    assert.equal(report.inventory.retryLoopCount, 1);
    assert.equal(report.inventory.shellSearchFallbackCount, 2);
  });

  it('incorporates explicit user feedback verdict and friction tags into the score', () => {
    const session = makeBaseSession();
    const baseline = evaluateSessionOrPrompt({
      kind: 'session-execution',
      promptText: session.taskDefinition.goal,
      session
    });

    const withFeedback = evaluateSessionOrPrompt({
      kind: 'session-execution',
      promptText: session.taskDefinition.goal,
      session,
      userFeedback: {
        targetKind: 'session',
        sessionId: session.sessionId,
        issueKey: session.issueKey,
        promptText: session.taskDefinition.goal,
        verdict: 'needs-work',
        frictionTags: ['missed-mcp', 'wasted-steps'],
        notes: 'Should have used code_intelligence find_symbol first.',
        createdAt: '2026-10-28T11:00:00Z'
      }
    });

    assert.ok(withFeedback.overallScore < baseline.overallScore);
    assert.ok(withFeedback.findings.some(f => f.id === 'user-verdict-needs-work'));
    assert.ok(withFeedback.findings.some(f => f.id === 'user-flagged-missed-mcp'));
    assert.ok(withFeedback.findings.some(f => f.id === 'user-friction-tags'));
  });
});
