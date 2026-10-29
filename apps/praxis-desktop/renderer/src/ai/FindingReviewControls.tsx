import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeterministicFeedbackReport, FeedbackFinding, FindingFeedbackState, FindingReviewVerdict } from '@praxis/core';

// Browser-safe mirror of core's identity; human labels never enter the scoring inputs.
function ruleKey(report: DeterministicFeedbackReport, finding: FeedbackFinding): string {
  return `${report.rubricVersion}/${report.clarity?.checklistVersion ?? 'facts'}/${report.clarity?.model ?? 'facts'}/${finding.id.split(':')[0]}`;
}
export function useFindingReviews(report?: DeterministicFeedbackReport) {
  const [state, setState] = useState<FindingFeedbackState>({ reviews: [], rules: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const digest = report?.inputDigest;
  const sequence = useRef(0);
  const current = useRef(digest);
  current.current = digest;
  useEffect(() => {
    let active = true;
    const generation = ++sequence.current;
    setSaving(false);
    setState({ reviews: [], rules: [] }); setError('');
    if (digest) void window.praxis.ai.getFindingFeedback(digest).then(next => { if (active && generation === sequence.current) setState(next); }).catch(() => { if (active && generation === sequence.current) setError('Could not load suggestion reviews.'); });
    return () => { active = false; };
  }, [digest]);
  const rate = useCallback(async (finding: FeedbackFinding, verdict?: FindingReviewVerdict, muted?: boolean) => {
    if (!digest || saving) return;
    const generation = ++sequence.current;
    setSaving(true); setError('');
    try {
      const next = await window.praxis.ai.reviewFinding({ inputDigest: digest, findingId: finding.id, verdict, muted });
      if (current.current === digest && generation === sequence.current) setState(next);
    } catch { if (current.current === digest && generation === sequence.current) setError('Could not save the review. Please retry.'); }
    finally { if (current.current === digest && generation === sequence.current) setSaving(false); }
  }, [digest, saving]);
  return { state, error, saving, rate, ruleFor: (finding: FeedbackFinding) => report ? state.rules.find(rule => rule.ruleKey === ruleKey(report, finding)) : undefined, isMuted: (finding: FeedbackFinding) => Boolean(report && state.rules.find(rule => rule.ruleKey === ruleKey(report, finding))?.muted) };
}
export function FindingReviewControls({ finding, reviews }: { finding: FeedbackFinding; reviews: ReturnType<typeof useFindingReviews> }) {
  const selected = reviews.state.reviews.find(review => review.findingId === finding.id);
  const rule = reviews.ruleFor(finding);
  const total = rule ? rule.useful + rule.contextClear + rule.wrong : 0;
  return <div className="finding-review" data-testid={`finding-review-${finding.id}`}>
    <span>Was this useful?</span>
    {([['useful', 'Useful'], ['context-clear', 'Already clear from context'], ['wrong', 'Wrong suggestion']] as const).map(([value, label]) =>
      <button key={value} type="button" className="btn btn-compact" disabled={reviews.saving} aria-pressed={selected?.verdict === value}
        data-testid={`finding-review-${finding.id}-${value}`} onClick={() => void reviews.rate(finding, value)}>{label}</button>)}
    {(selected || rule) && <span className="finding-review-status" role="status">{selected ? 'Saved locally · ' : ''}{total} reviewed · {rule?.wrong ?? 0} wrong · {rule?.contextClear ?? 0} already clear{total >= 5 ? ` · ${Math.round((rule!.useful / total) * 100)}% marked useful` : ' · Too few reviews to judge reliability'}</span>}
    {(reviews.isMuted(finding) || (selected && selected.verdict !== 'useful')) && <button type="button" className="btn btn-compact" disabled={reviews.saving}
      data-testid={`finding-mute-${finding.id}`} title="Change this check’s visibility for the current model/checklist across this profile. Scores and review labels stay unchanged." onClick={() => void reviews.rate(finding, undefined, !reviews.isMuted(finding))}>
      {reviews.isMuted(finding) ? 'Restore this check' : 'Mute this check'}</button>}
  </div>;
}
