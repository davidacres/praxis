import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSessionRecord,
  AgentToolMode,
  DeterministicFeedbackReport,
  FeedbackFinding,
  FeedbackFrictionTag,
  FeedbackGrade,
  FeedbackStepRef,
  FeedbackVerdict
} from '@praxis/core';
import { FindingReviewControls, useFindingReviews } from './FindingReviewControls';
import { Icon, type IconName } from '../ui/Icon';
import { renderInlineCode } from './inlineCode';

export interface SessionFeedbackPanelProps {
  session: AgentSessionRecord;
  turnIndex?: number;
  onClearTurnScope?: () => void;
  onOpenAgent?: (profileId: string) => void;
  onOpenSkill?: (skillName: string) => void;
}

/** Detail for `praxis:feedback-jump-to-steps`, which the chat thread answers by scrolling to the steps. */
export interface FeedbackJumpDetail {
  issueKey: string;
  findingId: string;
  title: string;
  steps: FeedbackStepRef[];
}

const FRICTION_TAG_OPTIONS: Array<{ id: FeedbackFrictionTag; label: string }> = [
  { id: 'wasted-steps', label: 'Blind Edits / Loops' },
  { id: 'missed-skill', label: 'Missed Skill' },
  { id: 'missed-mcp', label: 'Missed MCP' },
  { id: 'unverified-changes', label: 'Unverified Changes' },
  { id: 'wrong-scope', label: 'Wrong Scope' },
  { id: 'ignored-instructions', label: 'Ignored Instructions' }
];

const VERDICTS: Array<{ value: FeedbackVerdict; label: string; icon: string }> = [
  { value: 'helpful', label: 'Helpful', icon: '👍' },
  { value: 'needs-work', label: 'Needs Work', icon: '⚠' },
  { value: 'failed-goal', label: 'Failed', icon: '✕' }
];

function gradeToneClass(grade: FeedbackGrade): string {
  if (grade === 'A' || grade === 'B') return 'is-good';
  return grade === 'C' ? 'is-warn' : 'is-bad';
}

function stepRangeLabel(steps: readonly FeedbackStepRef[]): string {
  const numbers = steps.map(step => step.step);
  if (numbers.length === 1) return `Step #${numbers[0]}`;
  const contiguous = numbers.every((n, i) => i === 0 || n > numbers[i - 1]);
  return contiguous && numbers.length >= 2
    ? `Steps #${numbers[0]}–#${numbers[numbers.length - 1]}`
    : `Steps ${numbers.map(n => `#${n}`).join(', ')}`;
}

/** Whether a finding's fix can be carried into the next turn. */
function isStageable(finding: FeedbackFinding): boolean {
  const { remediation } = finding;
  // User verdicts restate feedback, and prompt-clarity findings are advice for the next
  // fresh prompt — neither is an action the follow-up turn itself can take.
  if (finding.id.startsWith('user-') || finding.dimension === 'prompt-clarity') return false;
  if (remediation.kind === 'attach-skill') return Boolean(remediation.targetId);
  if (remediation.kind === 'change-tool-mode') return Boolean(remediation.targetId);
  return Boolean(remediation.suggestedPromptSnippet);
}

function stagedChipLabel(finding: FeedbackFinding): { icon: IconName; label: string } {
  const { remediation } = finding;
  switch (remediation.kind) {
    case 'attach-skill':
      return { icon: 'sparkles', label: `Skill: ${remediation.targetId}` };
    case 'change-tool-mode':
      return { icon: 'tools', label: 'Full Access' };
    case 'pin-file':
      return { icon: 'pin', label: `Pin @${(remediation.targetId ?? '').split('/').pop()}` };
    case 'add-test-command':
      return { icon: 'check', label: `Run ${remediation.targetId ?? remediation.label}` };
    default:
      return { icon: 'link', label: remediation.label };
  }
}

function fixButtonLabel(finding: FeedbackFinding): string {
  const { remediation } = finding;
  if (remediation.kind === 'attach-skill') return `Attach ${remediation.targetId}`;
  if (remediation.kind === 'pin-file') return `Pin @${(remediation.targetId ?? '').split('/').pop()}`;
  return remediation.label;
}

export function SessionFeedbackPanel({
  session,
  turnIndex,
  onClearTurnScope,
  onOpenSkill
}: SessionFeedbackPanelProps) {
  const [report, setReport] = useState<DeterministicFeedbackReport | undefined>();
  const findingReviews = useFindingReviews(report);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [verdict, setVerdict] = useState<FeedbackVerdict | undefined>();
  const [frictionTags, setFrictionTags] = useState<FeedbackFrictionTag[]>([]);
  const [notes, setNotes] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [unstaged, setUnstaged] = useState<string[]>([]);
  const [viewingFindingId, setViewingFindingId] = useState<string | undefined>();

  const loadGeneration = useRef(0);
  const loadEvaluation = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const evaluated = await window.praxis.ai.evaluateSession({ issueKey: session.issueKey, turnIndex }, turnIndex);
      if (generation !== loadGeneration.current) return;
      setReport(evaluated);
      setVerdict(evaluated.userFeedback?.verdict);
      setFrictionTags(evaluated.userFeedback?.frictionTags ?? []);
      setNotes(evaluated.userFeedback?.notes ?? '');
      setNoteOpen(Boolean(evaluated.userFeedback?.notes));
    } catch (err) {
      if (generation === loadGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [session.issueKey, session.stepCount, session.state, turnIndex]);

  useEffect(() => {
    void loadEvaluation();
    setSaving(false);
    setUnstaged([]);
    setViewingFindingId(undefined);
    return () => { loadGeneration.current++; };
  }, [loadEvaluation]);

  /** Every verdict, tag, and note change saves at once — there is no separate Save step. */
  const saveFeedback = async (next: { verdict: FeedbackVerdict; frictionTags: FeedbackFrictionTag[]; notes: string }) => {
    const generation = loadGeneration.current;
    setSaving(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const updated = await window.praxis.ai.submitSessionFeedback({
        issueKey: session.issueKey,
        sessionId: session.sessionId,
        turnIndex,
        promptText: report?.promptText ?? session.taskDefinition?.goal ?? '',
        verdict: next.verdict,
        frictionTags: next.frictionTags,
        notes: next.notes
      });
      if (generation !== loadGeneration.current) return;
      setReport(updated);
      setSavedNotice(true);
    } catch (err) {
      if (generation === loadGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGeneration.current) setSaving(false);
    }
  };

  const chooseVerdict = (value: FeedbackVerdict) => {
    setVerdict(value);
    void saveFeedback({ verdict: value, frictionTags, notes });
  };

  const toggleFrictionTag = (tag: FeedbackFrictionTag) => {
    if (!verdict) return;
    const nextTags = frictionTags.includes(tag) ? frictionTags.filter(item => item !== tag) : [...frictionTags, tag];
    setFrictionTags(nextTags);
    void saveFeedback({ verdict, frictionTags: nextTags, notes });
  };

  const jumpToSteps = (finding: FeedbackFinding) => {
    if (!finding.steps?.length) return;
    setViewingFindingId(finding.id);
    const detail: FeedbackJumpDetail = { issueKey: session.issueKey, findingId: finding.id, title: finding.title, steps: finding.steps };
    window.dispatchEvent(new CustomEvent('praxis:feedback-jump-to-steps', { detail }));
  };

  // One chip per distinct action: two findings can share a fix (e.g. the same file to pin)
  const stageable = useMemo(() => {
    const seen = new Set<string>();
    return (report?.findings ?? []).filter(finding => {
      if (!isStageable(finding) || findingReviews.isMuted(finding)) return false;
      const key = stagedChipLabel(finding).label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [report, findingReviews.state.rules]);
  const staged = stageable.filter(finding => !unstaged.includes(finding.id));

  const toggleStaged = (findingId: string) => {
    setUnstaged(prev => (prev.includes(findingId) ? prev.filter(id => id !== findingId) : [...prev, findingId]));
  };

  const populateFollowUp = () => {
    const lines: string[] = [];
    for (const finding of staged) {
      const snippet = finding.remediation.suggestedPromptSnippet?.trim();
      if (snippet && finding.remediation.kind !== 'attach-skill' && !lines.includes(snippet)) lines.push(snippet);
    }
    if (notes.trim()) lines.push(`Address my feedback: ${notes.trim()}`);
    const promptText = lines.length > 0 ? `Follow up on the previous turn:\n${lines.map(line => `- ${line}`).join('\n')}` : '';
    const skillsToAttach = staged
      .filter(f => f.remediation.kind === 'attach-skill' && f.remediation.targetId)
      .map(f => f.remediation.targetId!);
    const toolMode = staged.find(f => f.remediation.kind === 'change-tool-mode')?.remediation.targetId as AgentToolMode | undefined;
    window.dispatchEvent(
      new CustomEvent('praxis:apply-feedback-followup', {
        detail: { issueKey: session.issueKey, promptText, skillsToAttach, toolMode }
      })
    );
  };

  if (loading && !report) {
    return (
      <div className="session-feedback-panel" data-testid="session-feedback-panel">
        <span className="placeholder-text">Scoring this session…</span>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="session-feedback-panel" data-testid="session-feedback-panel">
        {error ? <p className="hint is-danger">{error}</p> : <span className="placeholder-text">No evaluation available for this session.</span>}
      </div>
    );
  }

  const tone = gradeToneClass(report.grade);
  const diagnosis = report.diagnosis ?? { headline: `${report.findings.length} findings`, detail: '' };
  const findings = report.findings.filter(finding => !findingReviews.isMuted(finding));

  return (
    <div className="session-feedback-panel is-v2" data-testid="session-feedback-panel" data-evaluation-scope={report.turnIndex ?? 'session'}>
      <div className="feedback-v2-scroll">
        {findingReviews.error && <p role="alert">{findingReviews.error}</p>}
        {report.findings.some(f => findingReviews.isMuted(f)) && <details className="prompt-review-quality"><summary>Muted checks · score still includes their evidence</summary>
          {report.findings.filter(f => findingReviews.isMuted(f)).map(f => <div key={f.id}>{f.title}<FindingReviewControls finding={f} reviews={findingReviews} /></div>)}
        </details>}
        {turnIndex !== undefined && (
          <div className="feedback-turn-scope-banner" data-testid="feedback-turn-scope-banner">
            <span>Scoped to Turn #{turnIndex + 1}</span>
            {onClearTurnScope && (
              <button type="button" className="btn btn-compact" onClick={onClearTurnScope}>
                Show Full Session
              </button>
            )}
          </div>
        )}

        <section className="feedback-exec-card" data-testid="session-scorecard-summary">
          <div className="feedback-exec-top">
            <div className={`feedback-score-ring ${tone}`} data-testid="session-feedback-overall-score" aria-label={`Score ${report.overallScore} of 100, grade ${report.grade}`}>
              <span className="feedback-score-ring-num">{report.overallScore}</span>
              <span className="feedback-score-ring-sub">
                <span data-testid="session-feedback-grade">{report.grade}</span> · 100
              </span>
            </div>
            <div className="feedback-exec-copy">
              <div className="feedback-exec-headline" data-testid="session-feedback-diagnosis">{diagnosis.headline}</div>
              {diagnosis.detail && <p className="feedback-exec-detail">{renderInlineCode(diagnosis.detail)}</p>}
            </div>
          </div>

          <div className="feedback-verdict-row">
            <span className="feedback-verdict-label">Your verdict:</span>
            <div className="feedback-verdict-group" role="group" aria-label="Session verdict">
              {VERDICTS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={`feedback-verdict-btn is-${option.value}${verdict === option.value ? ' active' : ''}`}
                  data-testid={`feedback-verdict-${option.value}`}
                  aria-pressed={verdict === option.value}
                  disabled={saving}
                  onClick={() => chooseVerdict(option.value)}
                >
                  <span aria-hidden="true">{option.icon}</span> {option.label}
                  {verdict === option.value && <Icon name="check" size={10} />}
                </button>
              ))}
            </div>
          </div>

          {verdict && (
            <div className="feedback-friction-chips" role="group" aria-label="What went wrong">
              {FRICTION_TAG_OPTIONS.filter(tag => verdict !== 'helpful' || frictionTags.includes(tag.id)).map(tag => {
                const active = frictionTags.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`feedback-friction-chip${active ? ' active' : ''}`}
                    data-testid={`feedback-tag-${tag.id}`}
                    aria-pressed={active}
                    disabled={saving}
                    onClick={() => toggleFrictionTag(tag.id)}
                  >
                    {active ? `✓ ${tag.label}` : tag.label}
                  </button>
                );
              })}
              {!noteOpen && (
                <button type="button" className="feedback-friction-chip is-add-note" data-testid="session-feedback-add-note-btn" onClick={() => setNoteOpen(true)}>
                  + Add note…
                </button>
              )}
            </div>
          )}

          {verdict && noteOpen && (
            <div className="feedback-note-row">
              <textarea
                className="textarea feedback-notes-input"
                data-testid="session-feedback-notes"
                rows={2}
                placeholder="What should it have done differently?"
                value={notes}
                onChange={e => {
                  setNotes(e.target.value);
                  setSavedNotice(false);
                }}
              />
              <button
                type="button"
                className="btn btn-compact"
                data-testid="session-feedback-save-btn"
                disabled={saving}
                onClick={() => void saveFeedback({ verdict, frictionTags, notes })}
              >
                {saving ? 'Saving…' : 'Save note'}
              </button>
            </div>
          )}

          {savedNotice && (
            <p className="hint feedback-saved-hint" data-testid="session-feedback-saved-notice">
              ✓ Saved — score now {report.overallScore} · {report.grade}
            </p>
          )}
          {error && <p className="hint is-danger">{error}</p>}
        </section>

        {report.turningPoint && <details className="feedback-turning-point" data-testid="feedback-turning-point">
          <summary><strong>Potential turning point</strong> · {renderInlineCode(report.turningPoint.title)}</summary>
          <small>Evidence-backed hypothesis, not a proven cause or a measured saving.</small>
          <div className="feedback-autopsy-columns"><div><strong>What happened</strong><ol>{report.turningPoint.actual.map(step => <li key={step.step}>
            <button type="button" className="btn btn-compact" onClick={() => {
              const finding = report.findings.find(f => f.id === report.turningPoint?.findingId); if (finding) jumpToSteps(finding);
            }}>Step {step.step} · {step.toolName}</button> {step.detail ? renderInlineCode(step.detail) : null} {step.ok === false ? '— failed' : ''}
          </li>)}</ol></div><div><strong>A better sequence · proposed</strong><ol>{report.turningPoint.proposed.map((step, index) => <li key={index}>{renderInlineCode(step)}</li>)}</ol></div></div>
        </details>}
        <section className="feedback-v2-section" data-testid="session-feedback-findings">
          <div className="feedback-v2-section-head">
            <span>Root-cause findings ({findings.length})</span>
            {findings.some(f => f.steps?.length) && <span className="feedback-v2-section-aside">Steps jump to the thread</span>}
          </div>
          {findings.length === 0 ? (
            <p className="rail-sub" data-testid="session-feedback-no-findings">
              {report.findings.length ? 'Suggestions are muted. The score and recorded evidence are unchanged.' : 'No issues were identified in the available evidence.'}
            </p>
          ) : (
            <div className="feedback-findings-stack">
              {findings.map(finding => {
                const canStage = stageable.includes(finding);
                const isStaged = canStage && !unstaged.includes(finding.id);
                const isViewing = viewingFindingId === finding.id;
                return (
                  <div key={finding.id} className={`feedback-finding-card is-${finding.severity}`} data-testid={`session-finding-${finding.id}`}>
                    <div className="feedback-finding-card-top">
                      <strong className="feedback-finding-title">{renderInlineCode(finding.title)}</strong>
                      <span className={`feedback-delta-badge is-${finding.severity}`}>{finding.deltaPoints} pts</span>
                    </div>
                    <FindingReviewControls finding={finding} reviews={findingReviews} />
                    <p className="feedback-finding-evidence">{renderInlineCode(finding.evidence)}</p>
                    <div className="feedback-finding-card-actions">
                      {finding.steps && finding.steps.length > 0 ? (
                        <button
                          type="button"
                          className={`feedback-jump-btn${isViewing ? ' is-active' : ''}`}
                          data-testid={`session-finding-jump-${finding.id}`}
                          onClick={() => jumpToSteps(finding)}
                        >
                          <Icon name="external-link" size={10} />
                          {isViewing ? 'Viewing' : 'Jump to'} {stepRangeLabel(finding.steps)}
                        </button>
                      ) : <span />}
                      {canStage && (
                        <button
                          type="button"
                          className={`feedback-stage-btn${isStaged ? ' is-staged' : ''}`}
                          data-testid={`session-remediation-${finding.id}`}
                          aria-pressed={isStaged}
                          title={isStaged ? 'Included in the follow-up — click to leave it out' : finding.remediation.description}
                          onClick={() => toggleStaged(finding.id)}
                        >
                          {isStaged ? '✓ In follow-up' : `+ ${fixButtonLabel(finding)}`}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="feedback-v2-section" data-testid="session-feedback-dimensions">
          <div className="feedback-v2-section-head">
            <span>5-dimension breakdown &amp; capability audit</span>
            <span className="feedback-v2-section-aside" data-testid="session-feedback-rubric">
              Rubric v{report.rubricVersion} · <span data-testid="session-feedback-digest">#{report.inputDigest.slice(0, 6)}</span>
            </span>
          </div>
          <div className="feedback-dim-card">
            {report.dimensions.map(dim => {
              const pct = Math.round((dim.earnedPoints / dim.maxPoints) * 100);
              const dimTone = pct >= 80 ? 'is-good' : pct >= 60 ? 'is-warn' : 'is-bad';
              return (
                <div key={dim.dimension} className="feedback-dim-row" data-testid={`session-dim-${dim.dimension}`} title={dim.summary}>
                  <div className="feedback-dim-head">
                    <span className="feedback-dimension-label">{dim.label}</span>
                    <span className="feedback-progress-track is-inline">
                      <span className={`feedback-progress-fill ${dimTone}`} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="feedback-dimension-pts">{dim.earnedPoints} / {dim.maxPoints}</span>
                  </div>
                  {dim.signals && dim.signals.length > 0 && (
                    <div className="feedback-dim-signals" data-testid={`session-dim-signals-${dim.dimension}`}>
                      {dim.signals.map(signal => {
                        const skill = signal.label.match(/^(?:✓ |! Missed skill: )([\w-]+)$/)?.[1];
                        return (
                          <span
                            key={signal.label}
                            className={`feedback-signal-pill is-${signal.tone}${skill && onOpenSkill ? ' is-clickable' : ''}`}
                            onClick={skill && onOpenSkill ? () => onOpenSkill(skill) : undefined}
                          >
                            {signal.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <footer className="feedback-followup-drawer" data-testid="session-feedback-followup-drawer">
        <div className="feedback-v2-section-head">
          <span>Staged follow-up ({staged.length})</span>
        </div>
        {staged.length > 0 ? (
          <div className="feedback-staged-chips" data-testid="session-feedback-staged-chips">
            {staged.map(finding => {
              const chip = stagedChipLabel(finding);
              return (
                <button
                  key={finding.id}
                  type="button"
                  className="feedback-staged-chip"
                  data-testid={`session-feedback-staged-${finding.id}`}
                  aria-label={`Remove ${chip.label} from the follow-up`}
                  title="Remove from the follow-up"
                  onClick={() => toggleStaged(finding.id)}
                >
                  <Icon name={chip.icon} size={11} />
                  <span>+ {chip.label}</span>
                  <Icon name="close" size={9} />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="rail-sub">Nothing staged. Add a finding&rsquo;s fix to carry it into the next turn.</p>
        )}
        <button
          type="button"
          className="btn btn-primary feedback-populate-btn"
          data-testid="session-feedback-apply-followup-btn"
          disabled={staged.length === 0 && !notes.trim()}
          onClick={populateFollowUp}
        >
          Populate composer with follow-up <span aria-hidden="true">→</span>
        </button>
      </footer>
    </div>
  );
}
