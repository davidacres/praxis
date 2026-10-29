/** Fixed model answers for deterministic scoring tests; these do not validate model judgement. */
import type { ClarityAnswer, ClarityAssessment, ClarityCheckId, ClarityChecklistAnswers } from './promptClarity';
export function checkedClarity(overrides: Partial<Record<ClarityCheckId, ClarityAnswer>> = {}): ClarityAssessment {
  const checks = {} as ClarityChecklistAnswers['checks'];
  for (const id of ['target', 'outcome', 'done', 'context-gap', 'ambiguity'] as const) {
    checks[id] = { answer: overrides[id] ?? (id === 'context-gap' || id === 'ambiguity' ? 'no' : 'yes'), evidence: '', fix: `Clarify ${id}.` };
  }
  return { status: 'checked', checklistVersion: 2, model: 'fixture/pinned-v1', answers: { checklistVersion: 2, kind: 'instruction', checks } };
}
