import type { FeedbackEvaluationInput, FeedbackFinding, FeedbackStepRef, DeterministicFeedbackReport } from './feedbackTypes';
import { rankFileCandidates, pickTestCommand } from './workspaceGrounding';

export interface FeedbackRehearsal { steps: string[]; files: string[]; checks: string[]; unresolved: string[]; capabilities: string[]; skills: string[]; }
export interface FeedbackTurningPoint { findingId: string; title: string; actual: FeedbackStepRef[]; proposed: string[]; }
export type FindingReviewVerdict = 'useful' | 'context-clear' | 'wrong';
export interface FindingReview { inputDigest: string; findingId: string; ruleKey: string; verdict: FindingReviewVerdict; promptText: string; title: string; evidence: string; model?: string; checklistVersion?: number; rubricVersion: number; updatedAt: string; assessment?: DeterministicFeedbackReport['clarity']; context?: DeterministicFeedbackReport['reviewContext']; }
export interface FindingFeedbackState { reviews: FindingReview[]; rules: Array<{ ruleKey: string; useful: number; contextClear: number; wrong: number; muted: boolean }>; }
export interface ReviewFindingRequest { inputDigest: string; findingId: string; verdict?: FindingReviewVerdict; muted?: boolean; }
export function findingRuleKey(report: DeterministicFeedbackReport, findingId: string): string {
  return `${report.rubricVersion}/${report.clarity?.checklistVersion ?? 'facts'}/${report.clarity?.model ?? 'facts'}/${findingId.split(':')[0]}`;
}
export function buildFeedbackRehearsal(input: FeedbackEvaluationInput): FeedbackRehearsal {
  const interpretation = input.clarity?.answers?.interpretation;
  const unresolved = (['target', 'change', 'result'] as const).filter(key => !interpretation?.[key].text || (key === 'target' && input.clarity?.answers?.checks.target.answer === 'no') || (key === 'change' && input.clarity?.answers?.checks.outcome.answer === 'no'));
  const toolMode = input.toolMode ?? input.session?.toolMode ?? 'full';
  const capabilities = [input.codeIntelligenceAvailable ? 'code_intelligence: symbol lookup and source reading' : 'Repository file reading', ...(input.trackerToolsAvailable ? ['Tracker context'] : [])];
  if (toolMode === 'project-only') capabilities.splice(0, capabilities.length, 'Project context only; file access is unavailable');
  const skills = [...new Set(input.activeSkills ?? [])].sort();
  const files = rankFileCandidates(input.promptText, input.workspaceHints).slice(0, 3).map(file => file.path);
  const test = pickTestCommand(input.promptText, input.workspaceHints, files);
  if (unresolved.length) return { files, capabilities, skills, checks: [], unresolved, steps: [`Clarify ${unresolved.join(', ')} before choosing an execution plan.`] };
  if (toolMode !== 'full') return { files, capabilities, skills, checks: [], unresolved: ['tool-access'], steps: [toolMode === 'project-only' ? 'Choose a working folder and explicitly enable file access before inspecting files or proposing edits.' : 'Full access would be required before applying edits or running verification. This preview does not change permissions.'] };
  return { files, capabilities, skills, checks: test ? [test.command] : [], unresolved, steps: [
    `Inspect ${files.length ? files.join(', ') : interpretation!.target.text} and relevant workspace instructions.`,
    `Confirm the current behaviour, then ${interpretation!.change.text.charAt(0).toLowerCase()}${interpretation!.change.text.slice(1)}.`,
    `Check the result: ${interpretation!.result.text}${test ? ` Run ${test.command}.` : ' Agree on a verification method first.'}`
  ] };
}
export function buildFeedbackTurningPoint(findings: FeedbackFinding[]): FeedbackTurningPoint | undefined {
  const candidate = findings.filter(f => f.steps?.length && /loop|unresolved|thrash|blind/.test(f.id))
    .sort((a, b) => a.steps![0].step - b.steps![0].step || a.id.localeCompare(b.id))[0];
  if (!candidate) return undefined;
  return { findingId: candidate.id, title: candidate.title, actual: candidate.steps!.slice(0, 5), proposed: [
    'Pause before another attempt and inspect the current state and any error.', candidate.remediation.description,
    'Make one targeted change, then rerun the relevant verification before continuing.'
  ] };
}
