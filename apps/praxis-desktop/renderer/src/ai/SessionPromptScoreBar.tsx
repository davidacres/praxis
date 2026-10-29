import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentToolMode,
  DeterministicFeedbackReport,
  FeedbackFinding,
  FeedbackGrade,
  PromptIntent,
  SessionMode
} from '@praxis/core';
import { PromptCoachDetails, promptPhraseMarkers } from './PromptCoachDetails';
import { usePromptAnalysis, type PromptHighlight } from './SessionComposerFrame';
import { useFindingReviews } from './FindingReviewControls';
import { Icon } from '../ui/Icon';
import { renderInlineCode } from './inlineCode';
import {
  answerSuggestion, buildCoachSuggestions, ghostTextFor, insertPromptClause, optionLabel, type CoachSuggestion
} from './promptCoachSuggestions';

export interface SessionPromptScoreBarProps {
  promptText: string;
  toolMode: AgentToolMode;
  sessionMode: SessionMode;
  profileId?: string;
  activeSkills: string[];
  workingDirectory?: string;
  issueKey?: string;
  /** The running session this draft is a follow-up turn for. */
  followUpOfIssueKey?: string;
  contextTokens?: number;
  contextLimit?: number;
  disabled?: boolean;
  onChangePrompt: (nextPrompt: string) => void;
  onChangeToolMode?: (nextMode: AgentToolMode) => void;
  onAttachSkill?: (skillName: string) => void;
  onSelectAgent?: (profileId: string) => void;
}

/** Evaluate shortly after each keystroke so the score is fresh when the coach appears. */
const EVALUATE_DEBOUNCE_MS = 250;
/** Only interrupt once the user pauses — unless the draft hits a hard blocker. */
const TYPING_PAUSE_MS = 1200;
const READY_CELEBRATION_MS = 700;
const CLOSE_ANIMATION_MS = 240;
/** Beyond this the dots stop meaning anything; the "n of N" count still does. */
const MAX_DOTS = 8;

const INTENT_LABELS: Record<PromptIntent, string> = {
  question: 'Question',
  'follow-up': 'Follow-up',
  bugfix: 'Bugfix / Edit',
  feature: 'Feature / Edit',
  plan: 'Plan',
  review: 'Review',
  general: 'General'
};

function gradeToneClass(grade: FeedbackGrade): string {
  if (grade === 'A' || grade === 'B') return 'is-good';
  return grade === 'C' ? 'is-warn' : 'is-bad';
}

function isHardBlocker(finding: FeedbackFinding): boolean {
  return finding.id === 'prompt-tool-mode-conflict';
}

const ACCEPT_LABELS: Partial<Record<CoachSuggestion['kind'], string>> = { phrase: 'Replace', question: 'Add' };

export function SessionPromptScoreBar({
  promptText,
  toolMode,
  sessionMode,
  profileId,
  activeSkills,
  workingDirectory,
  issueKey,
  followUpOfIssueKey,
  contextTokens,
  contextLimit,
  disabled,
  onChangePrompt,
  onChangeToolMode,
  onAttachSkill,
  onSelectAgent
}: SessionPromptScoreBarProps) {
  const [report, setReport] = useState<DeterministicFeedbackReport | undefined>();
  const [displayedReport, setDisplayedReport] = useState<DeterministicFeedbackReport | undefined>();
  const [manualReview, setManualReview] = useState(false);
  const [manageMuted, setManageMuted] = useState(false);
  const [typingSettled, setTypingSettled] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [readyCelebration, setReadyCelebration] = useState(false);
  const [snoozedKey, setSnoozedKey] = useState<string | undefined>();
  const [undoPromptSnapshot, setUndoPromptSnapshot] = useState<string | undefined>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [focusKey, setFocusKey] = useState<string>();
  const [option, setOption] = useState<{ key: string; index: number }>();
  const [answer, setAnswer] = useState<{ key: string; text: string }>();
  // While the coach's own edit is re-checked, keep stepping through what is left of the last check
  const [carryReport, setCarryReport] = useState<DeterministicFeedbackReport>();
  const [acceptedKeys, setAcceptedKeys] = useState<readonly string[]>([]);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const readyTimerRef = useRef<number | undefined>(undefined);
  const hadOpenFindingsRef = useRef(false);
  const insertedPromptRef = useRef<string | undefined>(undefined);
  const coachChangeRef = useRef(false);
  const answerRef = useRef<HTMLInputElement | null>(null);
  const handledRequest = useRef<number | undefined>(undefined);
  const { setHighlights, setGhost, setStatus, requested, keyHandler, inputRef } = usePromptAnalysis();
  const activeSkillsKey = activeSkills.join(',');
  const trimmedPrompt = promptText.trim();

  const clearTimers = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
    window.clearTimeout(readyTimerRef.current);
    closeTimerRef.current = undefined;
    readyTimerRef.current = undefined;
  }, []);

  // Ignore responses for drafts/settings that have since changed. A model call can
  // outlive several keystrokes; cancellation of timers alone is not enough.
  useEffect(() => {
    let current = true;
    // An edit the coach just made keeps the strip open: the user is mid-way through it
    const fromCoach = coachChangeRef.current;
    coachChangeRef.current = false;
    setTypingSettled(false);
    setManageMuted(false);
    setManualReview(false);
    setReport(undefined);
    clearTimers();
    if (!trimmedPrompt || disabled) {
      setUndoPromptSnapshot(undefined);
      setCarryReport(undefined);
      return;
    }
    if (!fromCoach) {
      setDisplayedReport(undefined);
      setMounted(false);
      setCarryReport(undefined);
      setAcceptedKeys([]);
      setAcceptedCount(0);
    }
    let request = 0;
    const evaluate = async (checkClarity: boolean) => {
      const sequence = ++request;
      try {
        const next = await window.praxis.ai.evaluatePrompt({
          promptText, toolMode, sessionMode, profileId, activeSkills,
          workingDirectory, issueKey, followUpOfIssueKey, contextTokens,
          contextLimit, checkClarity
        });
        if (current && sequence === request) setReport(next);
      } catch {
        // Preserve the cached/factual result if the IPC channel closes.
      }
    };
    const evaluateTimer = window.setTimeout(() => void evaluate(false), EVALUATE_DEBOUNCE_MS);
    const settleTimer = window.setTimeout(() => {
      setTypingSettled(true);
      void evaluate(true);
    }, fromCoach ? EVALUATE_DEBOUNCE_MS : TYPING_PAUSE_MS);
    return () => {
      current = false;
      window.clearTimeout(evaluateTimer);
      window.clearTimeout(settleTimer);
    };
  }, [promptText, disabled, toolMode, sessionMode, profileId, activeSkillsKey,
    workingDirectory, issueKey, followUpOfIssueKey, contextTokens, contextLimit, retryVersion, clearTimers]);

  // A finished check replaces whatever was carried over from before the coach's edit
  useEffect(() => {
    if (report && report.clarity?.status !== 'pending') {
      setCarryReport(undefined);
      setAcceptedKeys([]);
    }
  }, [report]);

  const findingKey = trimmedPrompt;
  const isSnoozed = Boolean(report && snoozedKey !== undefined && findingKey === snoozedKey);
  const hasBlocker = Boolean(report?.findings.some(isHardBlocker));
  const clarityWaiting = Boolean(report?.clarity && report.clarity.status !== 'checked');
  const wantsCoach = Boolean(
    trimmedPrompt && !disabled && report && (report.findings.length > 0 || clarityWaiting || manualReview) && !isSnoozed &&
    (typingSettled || hasBlocker || mounted || manualReview)
  );

  useEffect(() => {
    const close = () => {
      clearTimers();
      hadOpenFindingsRef.current = false;
      setReadyCelebration(false);
      setClosing(true);
      closeTimerRef.current = window.setTimeout(() => {
        setMounted(false);
        setClosing(false);
        setDisplayedReport(undefined);
        setDetailsOpen(false);
      }, CLOSE_ANIMATION_MS);
    };

    if (!trimmedPrompt || disabled || isSnoozed) {
      if (mounted && !closing) close();
      return;
    }
    if (wantsCoach && report) {
      clearTimers();
      hadOpenFindingsRef.current = hadOpenFindingsRef.current || report.findings.length > 0;
      setReadyCelebration(false);
      setDisplayedReport(report);
      setClosing(false);
      setMounted(true);
      return;
    }
    // Every suggestion resolved while open: brief "Prompt Ready" + Undo, then close
    if (mounted && !closing && report && report.findings.length === 0 && !clarityWaiting && hadOpenFindingsRef.current) {
      clearTimers();
      hadOpenFindingsRef.current = false;
      setDisplayedReport(report);
      setReadyCelebration(true);
      readyTimerRef.current = window.setTimeout(close, READY_CELEBRATION_MS);
      return;
    }
    if (mounted && !closing && !readyCelebration && report && report.findings.length === 0 && !clarityWaiting) close();
  }, [trimmedPrompt, disabled, isSnoozed, wantsCoach, report, mounted, closing, readyCelebration, clarityWaiting, manualReview, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // Undo restores the draft from before the coach edited it — once the user edits the text
  // themselves, that snapshot is stale and restoring it would throw their words away.
  useEffect(() => {
    if (undoPromptSnapshot !== undefined && promptText !== insertedPromptRef.current) {
      setUndoPromptSnapshot(undefined);
      insertedPromptRef.current = undefined;
    }
  }, [promptText]);

  const activeReport = report && (report.findings.length > 0 || clarityWaiting || readyCelebration || manualReview) ? report : displayedReport;
  const stripVisible = Boolean(mounted && !closing && !readyCelebration && activeReport);
  const sourceReport = activeReport?.clarity?.status === 'pending' && carryReport ? carryReport : activeReport;
  // Reviews belong to the assessment on screen: while an edit is re-checked that is the previous one
  const reviews = useFindingReviews(sourceReport);
  const markers = sourceReport ? promptPhraseMarkers(sourceReport, promptText, reviews.isMuted) : [];
  const suggestions = stripVisible && sourceReport
    ? buildCoachSuggestions(sourceReport.findings.filter(f => !reviews.isMuted(f) && !acceptedKeys.includes(f.id)), markers, toolMode)
      // A carried phrase the edit removed has nothing left to point at
      .filter(s => sourceReport !== carryReport || s.kind !== 'question' || s.marker?.start === -1 && !s.marker.phrase)
    : [];
  const focusIndex = Math.max(0, suggestions.findIndex(s => s.key === focusKey));
  const current = suggestions[focusIndex] as CoachSuggestion | undefined;
  const optionIndex = current && option?.key === current.key ? option.index : 0;
  const currentOption = current?.options[optionIndex];
  const answerText = current && answer?.key === current.key ? answer.text : '';

  // A phrase clicked in the composer's own text becomes the suggestion in focus
  useEffect(() => {
    if (!requested || requested.nonce === handledRequest.current) return;
    handledRequest.current = requested.nonce;
    const target = suggestions.find(s => s.marker?.id === requested.id);
    if (target) setFocusKey(target.key);
  }, [requested?.nonce]);

  // Underline uncertain phrases in the composer's own text; the one in focus is drawn strongest
  const highlights: PromptHighlight[] = stripVisible
    ? markers.filter(marker => marker.start >= 0 && suggestions.some(s => s.marker?.id === marker.id))
      .map(marker => ({ id: marker.id, start: marker.start, end: marker.start + marker.phrase.length, question: marker.text,
        active: current?.marker?.id === marker.id }))
    : [];
  useEffect(() => setHighlights(highlights));
  const ghostSnippet = stripVisible && current?.kind === 'insert' ? currentOption?.suggestedPromptSnippet : undefined;
  useEffect(() => setGhost(ghostSnippet ? {
    text: ghostTextFor(promptText, ghostSnippet),
    hint: current!.options.length > 1 ? `⇥ accept · ⌥] ${optionIndex + 1}/${current!.options.length}` : '⇥ accept'
  } : undefined));
  // Only a completed clarity check of this exact draft with nothing to say counts as "ok"
  const analysisStatus = !trimmedPrompt || disabled || report?.clarity?.status !== 'checked'
    ? 'idle' : report.findings.length > 0 ? 'issues' : 'ok';
  useEffect(() => setStatus(analysisStatus), [analysisStatus, setStatus]);
  useEffect(() => () => { setHighlights([]); setGhost(undefined); setStatus('idle'); }, [setHighlights, setGhost, setStatus]);

  const updatePrompt = (next: string) => {
    coachChangeRef.current = true;
    setUndoPromptSnapshot(previous => previous ?? promptText);
    insertedPromptRef.current = next;
    onChangePrompt(next);
  };

  const move = (step: number) => {
    if (!suggestions.length) return;
    const next = suggestions[(focusIndex + step + suggestions.length) % suggestions.length];
    setFocusKey(next.key);
  };

  const cycleOption = (step: number) => {
    if (!current || current.options.length < 2) return;
    setOption({ key: current.key, index: (optionIndex + step + current.options.length) % current.options.length });
  };

  const accept = () => {
    if (!current) return;
    const typed = answerText.trim();
    if ((current.kind === 'phrase' || current.kind === 'question') && !typed) {
      answerRef.current?.focus();
      return;
    }
    if (current.kind === 'advice') {
      move(1);
      return;
    }
    // Step on to whatever follows, and keep the rest of this check while the edit is re-checked
    setFocusKey(suggestions[(focusIndex + 1) % suggestions.length]?.key);
    setCarryReport(sourceReport);
    setAcceptedKeys(keys => [...keys, current.key]);
    setAcceptedCount(count => count + 1);
    setAnswer(undefined);
    if (current.kind === 'setting' && currentOption) {
      coachChangeRef.current = true;
      if (currentOption.kind === 'change-tool-mode') onChangeToolMode?.((currentOption.targetId as AgentToolMode) || 'full');
      else if (currentOption.kind === 'attach-skill' && currentOption.targetId) onAttachSkill?.(currentOption.targetId);
      else if (currentOption.kind === 'select-agent' && currentOption.targetId) onSelectAgent?.(currentOption.targetId);
    } else if (current.kind === 'insert' && currentOption?.suggestedPromptSnippet) {
      updatePrompt(insertPromptClause(promptText, currentOption.suggestedPromptSnippet));
    } else {
      updatePrompt(answerSuggestion(promptText, current, typed));
      inputRef.current?.focus();
    }
  };

  // Keys in the composer act on the suggestion in focus. Enter is never taken: it still sends.
  keyHandler.current = stripVisible && current ? event => {
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    if (event.key === 'Tab' && plain) {
      if (current.kind === 'phrase' || current.kind === 'question') answerRef.current?.focus();
      else accept();
      return true;
    }
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      move(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (event.altKey && (event.code === 'BracketRight' || event.code === 'BracketLeft') && current.options.length > 1) {
      cycleOption(event.code === 'BracketRight' ? 1 : -1);
      return true;
    }
    if (event.key === 'Escape' && plain && suggestions.length > 1) {
      move(1);
      return true;
    }
    return false;
  } : undefined;
  useEffect(() => () => { keyHandler.current = undefined; }, [keyHandler]);

  if (!mounted || !activeReport) {
    if (trimmedPrompt && !disabled && report?.clarity?.status === 'checked' && report.findings.length === 0) {
      return <button type="button" className="btn btn-compact prompt-coach-open" data-testid="prompt-coach-open"
        onMouseDown={event => event.preventDefault()} onClick={() => { setSnoozedKey(undefined); setManualReview(true); setDetailsOpen(true); }}>Preview approach</button>;
    }
    return null;
  }

  const handleUndoTextEdit = () => {
    if (undoPromptSnapshot === undefined) return;
    clearTimers();
    setReadyCelebration(false);
    setClosing(false);
    coachChangeRef.current = true;
    onChangePrompt(undoPromptSnapshot);
    setUndoPromptSnapshot(undefined);
  };

  const checked = activeReport.clarity?.status === 'checked';
  const wrapperState = closing ? 'closing' : readyCelebration ? 'ready' : 'open';
  const intentPill = activeReport.intent && activeReport.intent !== 'general'
    ? <span className="session-prompt-intent-pill" data-testid="session-prompt-intent"><Icon name="target" size={11} />Intent: {INTENT_LABELS[activeReport.intent]}</span>
    : undefined;
  const undoButton = undoPromptSnapshot !== undefined && (
    <button type="button" className="btn btn-compact session-prompt-undo-btn" data-testid="session-prompt-undo-btn" onClick={handleUndoTextEdit}>
      ↶ {readyCelebration ? 'Undo text edit' : 'Undo'}
    </button>
  );

  if (checked && activeReport.findings.length > 0 && activeReport.findings.every(f => reviews.isMuted(f)) && !manageMuted) {
    return <div className="session-prompt-score-wrapper is-docked-cap" data-testid="session-prompt-score-wrapper" data-state="open" data-input-digest={(sourceReport ?? activeReport).inputDigest}>
      <div className="session-prompt-score-summary"><span>{activeReport.findings.length} checks muted · score evidence retained</span>
        <button type="button" className="btn btn-compact" onMouseDown={event => event.preventDefault()} onClick={() => { setManageMuted(true); setDetailsOpen(true); }}>Review muted checks</button></div>
    </div>;
  }

  const dots = Math.min(MAX_DOTS, acceptedCount + suggestions.length);
  const accepted = Math.min(acceptedCount, dots);

  return (
    <div
      className={`session-prompt-score-wrapper is-docked-cap${closing ? ' is-closing' : ''}${readyCelebration ? ' is-ready' : ''}`}
      data-testid="session-prompt-score-wrapper"
      data-input-digest={(sourceReport ?? activeReport).inputDigest}
      data-state={wrapperState}
    >
      <div className={`session-prompt-score-panel${readyCelebration ? ' is-ready' : ''}`} data-testid="session-prompt-score-panel">
        {readyCelebration ? (
          <div className="session-prompt-strip is-ready" data-testid="session-prompt-ready-banner">
            <span className="feedback-score-pill is-compact is-good" data-testid="session-prompt-score-pill">
              <Icon name="check" size={11} />
              <span className="feedback-score-num" data-testid="session-prompt-score-value">{activeReport.overallScore}</span>
            </span>
            <span className="prompt-strip-text">{acceptedCount > 0 ? `All ${acceptedCount} handled — prompt is ready` : 'No suggestions — prompt is ready'}</span>
            {undoButton}
          </div>
        ) : (
          <>
            <div
              className="session-prompt-strip"
              data-testid="session-prompt-strip"
              data-suggestion={current?.key}
              data-kind={current?.kind}
              // Keep the caret in the draft: taking focus reflows the composer mid-click
              onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}
            >
              {checked ? (
                <span className={`feedback-score-pill is-compact ${gradeToneClass(activeReport.grade)}`}
                  data-testid="session-prompt-score-pill"
                  title={`Checklist v${activeReport.clarity?.checklistVersion} · ${activeReport.clarity?.model} · ${activeReport.clarity?.cached ? 'Cached answers' : 'Model answers'} · Code-calculated score`}>
                  <span className="feedback-score-num" data-testid="session-prompt-score-value">{activeReport.overallScore}</span>
                  <span>/ 100</span>
                </span>
              ) : (
                <span className="session-prompt-intent-pill" data-testid="session-prompt-check-status" role="status">
                  {activeReport.clarity?.status === 'pending' ? 'Checking clarity…' : 'Clarity unavailable · facts only'}
                </span>
              )}
              {suggestions.length > 0 && (
                <span className="prompt-strip-nav">
                  <button type="button" aria-label="Previous suggestion" data-testid="prompt-strip-prev" disabled={suggestions.length < 2} onClick={() => move(-1)}>◂</button>
                  <span data-testid="prompt-strip-position">{focusIndex + 1} of {suggestions.length}</span>
                  <button type="button" aria-label="Next suggestion" data-testid="prompt-strip-next" disabled={suggestions.length < 2} onClick={() => move(1)}>▸</button>
                </span>
              )}
              {dots > 1 && (
                <span className="prompt-strip-dots" aria-hidden="true">
                  {Array.from({ length: dots }, (_, index) => (
                    <i key={index} className={index < accepted ? 'is-done' : index === accepted + focusIndex ? 'is-on' : ''} />
                  ))}
                </span>
              )}
              <span className="prompt-strip-text" data-testid="session-prompt-score-headline" aria-live="polite">
                {current ? (
                  <>
                    {current.kind === 'phrase' && current.marker && <q className="prompt-question-phrase">{current.marker.phrase}</q>}
                    {renderInlineCode(current.text)}
                  </>
                ) : checked ? 'No suggestions for this draft' : null}
              </span>
              <span className="prompt-strip-actions">
              {current && (current.kind === 'phrase' || current.kind === 'question') && (
                <input
                  ref={answerRef}
                  className="input prompt-strip-answer"
                  data-testid="prompt-strip-answer"
                  aria-label={current.text}
                  placeholder={current.kind === 'phrase' ? 'Replace with…' : 'Your answer…'}
                  value={answerText}
                  maxLength={1200}
                  onChange={event => setAnswer({ key: current.key, text: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); accept(); }
                    else if (event.key === 'Escape') { event.preventDefault(); inputRef.current?.focus(); }
                    else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
                  }}
                />
              )}
              {current && current.options.length > 1 && (
                <button type="button" className="btn btn-compact prompt-strip-cycle prompt-strip-quiet" data-testid="prompt-strip-cycle"
                  title="Next option (⌥])" onClick={() => cycleOption(1)}>{optionIndex + 1}/{current.options.length} <kbd>⌥]</kbd></button>
              )}
              {current && current.kind !== 'advice' && (
                <button type="button" className="btn btn-compact btn-primary prompt-strip-accept" data-testid="prompt-strip-accept"
                  disabled={(current.kind === 'phrase' || current.kind === 'question') && !answerText.trim()}
                  title={currentOption?.description} onClick={accept}>
                  {ACCEPT_LABELS[current.kind] ?? renderInlineCode(optionLabel(currentOption!))}
                  {checked && current.points !== undefined && current.points > 0 && <span className="prompt-strip-points">+{current.points}</span>}
                  <kbd>⇥</kbd>
                </button>
              )}
              {suggestions.length > 1 && (
                <button type="button" className="btn btn-compact" data-testid="prompt-strip-skip" title="Next suggestion (⌥↓)" onClick={() => move(1)}>
                  Skip <kbd>⌥↓</kbd>
                </button>
              )}
              {undoButton}
              <button type="button" className="btn btn-compact prompt-strip-quiet prompt-strip-details" data-testid="prompt-strip-details-toggle"
                aria-expanded={detailsOpen} onClick={() => setDetailsOpen(open => !open)}>
                <Icon name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={11} /> details
              </button>
              <button
                type="button"
                className="session-prompt-snooze-btn"
                data-testid="session-prompt-dismiss-btn"
                aria-label={manualReview ? 'Close preview' : 'Snooze suggestions for this draft'}
                onClick={() => { setManualReview(false); setSnoozedKey(findingKey); }}
              >
                <Icon name="close" size={10} />
              </button>
              </span>
            </div>

            {activeReport.clarity?.status === 'unavailable' && (
              <p className="session-prompt-fix-label" data-testid="session-prompt-check-unavailable">
                Could not check clarity. Your prompt can still be sent. Check your AI provider connection.
                {' '}<button type="button" className="btn btn-compact" data-testid="session-prompt-retry" onClick={() => setRetryVersion(value => value + 1)}>Retry clarity check</button>
              </p>
            )}
            {detailsOpen && (
              <PromptCoachDetails initialPreview={manualReview} manageMuted={manageMuted} report={sourceReport ?? activeReport} reviews={reviews} intent={intentPill} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
