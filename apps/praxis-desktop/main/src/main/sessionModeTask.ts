import type { AgentTaskDefinition } from '@praxis/core';

/**
 * The task contract of a read-only session mode — shared by the desktop's
 * New Session composer (`ai:delegate`) and sessions started from the phone,
 * so "Analysis" and "Review" mean the same thing on both.
 */
export function buildReadOnlyModeTask(
  mode: 'analysis' | 'review',
  issue: { key: string; summary: string },
  analysisPrompt: string,
  goal?: string,
): AgentTaskDefinition {
  if (mode === 'analysis') {
    return {
      kind: 'analysis',
      sessionMode: 'analysis',
      goal: [analysisPrompt, goal ?? `Analyze ${issue.key} — ${issue.summary}.`, 'This is a read-only analysis; do not implement anything yet.'].join('\n\n'),
      scope: 'Read-only analysis of the supplied goal and relevant workspace context.',
      definitionOfDone: 'A clear analysis and ordered implementation plan is presented for review.',
      nonGoals: ['Do not edit files or change external state during analysis.'],
      completionContract: 'Stop after presenting the analysis and wait for confirmation.'
    };
  }
  return {
    kind: 'review',
    sessionMode: 'review',
    goal: goal ?? `Review ${issue.key} — ${issue.summary}.`,
    scope: 'Read-only review of the supplied goal, implementation, tests, and relevant workspace context.',
    definitionOfDone: 'A concise review identifies strengths, risks, and actionable findings.',
    nonGoals: ['Do not edit files or implement fixes during review.'],
    completionContract: 'Stop after presenting review findings and wait for the user.'
  };
}
