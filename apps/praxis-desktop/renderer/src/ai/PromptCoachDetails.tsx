import { useEffect, useState, type ReactNode } from 'react';
import type { DeterministicFeedbackReport, ClarityCheckId, FeedbackFinding } from '@praxis/core';
import { FindingReviewControls, type useFindingReviews } from './FindingReviewControls';

const QUESTIONS: Record<ClarityCheckId, string> = {
  target: 'Which object, component or feature should change?', outcome: 'What should be different afterwards?',
  done: 'How will you tell the result is correct?', 'context-gap': 'What missing context should the agent know?', ambiguity: 'Which meaning do you intend?'
};
export interface PhraseMarker { id: ClarityCheckId; phrase: string; start: number; text: string }

/** Where each open clarity question sits in the draft; `start` is -1 when it names no phrase. */
export function promptPhraseMarkers(report: DeterministicFeedbackReport, draft: string, isMuted: (finding: FeedbackFinding) => boolean): PhraseMarker[] {
  const answers = report.clarity?.answers;
  if (report.clarity?.status !== 'checked' || !answers) return [];
  return report.findings.filter(f => !isMuted(f)).flatMap(finding => {
    const id = finding.id.replace('clarity-', '') as ClarityCheckId;
    const check = answers.checks[id];
    if (!check) return [];
    const start = check.evidence ? draft.toLowerCase().indexOf(check.evidence.toLowerCase()) : -1;
    if (start < 0 && ['pin-file', 'add-test-command'].includes(finding.remediation.kind)) return [];
    return [{ id, phrase: start >= 0 ? draft.slice(start, start + check.evidence.length) : check.evidence, start, text: check.question || QUESTIONS[id] }];
  });
}

/** Everything behind the strip's "details": what the coach understood, a dry-run, and coach review. */
export function PromptCoachDetails({ report, reviews, manageMuted = false, initialPreview = false, intent }: {
  report: DeterministicFeedbackReport; reviews: ReturnType<typeof useFindingReviews>; manageMuted?: boolean; initialPreview?: boolean; intent?: ReactNode;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => { setPreview(initialPreview); }, [report.inputDigest, initialPreview]);
  const answers = report.clarity?.answers;
  if (report.clarity?.status !== 'checked' || !answers) return null;
  const hidden = report.findings.filter(f => reviews.isMuted(f));
  return <section onMouseDown={event => { if ((event.target as HTMLElement).closest('button, summary')) event.preventDefault(); }} className="prompt-coach-details" aria-label="Understand and refine this draft" data-testid="prompt-coach-details">
    <div className="prompt-understanding" data-testid="prompt-understanding">
      <div className="prompt-understanding-head"><strong>Here’s what I think you mean</strong>{intent}</div>
      <div className="prompt-understanding-slots">{(['target', 'change', 'result'] as const).map(key => {
        const slot = answers.interpretation?.[key];
        return <div key={key} data-testid={`prompt-understanding-${key}`} className={slot?.text ? '' : 'is-unresolved'}>
          <span>{key === 'result' ? 'Expected result' : key === 'target' ? 'Target' : 'Change'}</span>
          <strong>{slot?.text || 'Not identified'}</strong>
          {slot?.evidence && <small>{slot.source === 'context' ? `Earlier excerpt ${(slot.messageIndex ?? 0) + 1}` : 'Your prompt'}: “{slot.evidence}”</small>}
        </div>;
      })}</div>
    </div>
    <div className="prompt-coach-detail-actions">
      <button type="button" className="btn btn-compact" aria-expanded={preview} data-testid="prompt-rehearsal-toggle" onClick={() => setPreview(value => !value)}>{preview ? 'Hide the approach' : 'Preview the approach'}</button>
    </div>
    {preview && <div className="prompt-rehearsal" data-testid="prompt-rehearsal">
      <strong>Proposed approach · nothing executed</strong>
      <ol>{report.rehearsal?.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      {!!report.rehearsal?.files.length && <p>Candidate files: {report.rehearsal.files.join(', ')}</p>}
      {!!report.rehearsal?.checks.length && <p>Proposed verification: {report.rehearsal.checks.join('; ')}</p>}
      {!!report.rehearsal?.capabilities?.length && <p>Available capabilities: {report.rehearsal.capabilities.join('; ')}</p>}
      {!!report.rehearsal?.skills?.length && <p>Attached skills: {report.rehearsal.skills.join(', ')}</p>}
      <small>Proposal based on the current interpretation. Files and commands have not been executed or verified.</small>
    </div>}
    {report.findings.length > 0 && <details open={manageMuted || undefined} className="prompt-review-quality" data-testid="prompt-review-quality"><summary>Review the coach · {report.findings.length} suggestions</summary>
      <p>These labels build a local review set. They do not change this score or train a model automatically.</p>
      {hidden.length > 0 && <button type="button" className="btn btn-compact" onClick={() => setShowHidden(value => !value)}>{showHidden ? 'Hide muted checks' : `Show ${hidden.length} muted checks`}</button>}
      {report.findings.filter(f => showHidden || manageMuted || !reviews.isMuted(f)).map(finding => <div className="prompt-review-item" key={finding.id}>
        <span>{finding.title}</span><FindingReviewControls finding={finding} reviews={reviews} />
      </div>)}
      {reviews.error && <p role="alert">{reviews.error}</p>}
    </details>}
  </section>;
}
