/** Fixed model answers for deterministic scoring tests; these do not validate model judgement. */
import { CLARITY_CHECKLIST_VERSION, type ClarityAnswer, type ClarityAssessment, type ClarityCheckId, type ClarityChecklistAnswers } from './promptClarity';
export function checkedClarity(overrides: Partial<Record<ClarityCheckId, ClarityAnswer>> = {}): ClarityAssessment {
  const checks = {} as ClarityChecklistAnswers['checks'];
  for (const id of ['target', 'outcome', 'done', 'context-gap', 'ambiguity'] as const) {
    checks[id] = { answer: overrides[id] ?? (id === 'context-gap' || id === 'ambiguity' ? 'no' : 'yes'), evidence: '', fix: `Clarify ${id}.` };
  }
  return { status: 'checked', checklistVersion: CLARITY_CHECKLIST_VERSION, model: 'fixture/pinned-v1', answers: { checklistVersion: CLARITY_CHECKLIST_VERSION, kind: 'instruction', checks } };
}
