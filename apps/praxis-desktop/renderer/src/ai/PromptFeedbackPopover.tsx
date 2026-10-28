import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentToolMode,
  DeterministicFeedbackReport,
  FeedbackFinding,
  FeedbackGrade,
  SessionMode
} from '@praxis/core';
import { Icon } from '../ui/Icon';

export interface PromptFeedbackPopoverProps {
  promptText: string;
  toolMode: AgentToolMode;
  sessionMode: SessionMode;
  profileId?: string;
  activeSkills: string[];
  workingDirectory?: string;
  issueKey?: string;
  contextTokens?: number;
  contextLimit?: number;
  disabled?: boolean;
  onChangePrompt: (nextPrompt: string) => void;
  onChangeToolMode?: (nextMode: AgentToolMode) => void;
  onAttachSkill?: (skillName: string) => void;
  onSelectAgent?: (profileId: string) => void;
}

function gradeToneClass(grade: FeedbackGrade): string {
  switch (grade) {
    case 'A':
    case 'B':
      return 'is-good';
    case 'C':
      return 'is-warn';
    default:
      return 'is-bad';
  }
}

export function PromptFeedbackPopover({
  promptText,
  toolMode,
  sessionMode,
  profileId,
  activeSkills,
  workingDirectory,
  issueKey,
  contextTokens,
  contextLimit,
  disabled,
  onChangePrompt,
  onChangeToolMode,
  onAttachSkill,
  onSelectAgent
}: PromptFeedbackPopoverProps) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | undefined>();
  const [report, setReport] = useState<DeterministicFeedbackReport | undefined>();
  const [loading, setLoading] = useState(false);
  const [rewriting, setRewriting] = useState(false);

  const activeSkillsKey = activeSkills.join(',');

  const runEvaluation = useCallback(async () => {
    if (!promptText.trim()) {
      setReport(undefined);
      return;
    }
    setLoading(true);
    try {
      const evaluated = await window.praxis.ai.evaluatePrompt({
        promptText,
        toolMode,
        sessionMode,
        profileId,
        activeSkills,
        workingDirectory,
        issueKey,
        contextTokens,
        contextLimit
      });
      setReport(evaluated);
    } catch {
      // Ignore transient IPC errors while typing
    } finally {
      setLoading(false);
    }
  }, [
    promptText,
    toolMode,
    sessionMode,
    profileId,
    activeSkillsKey,
    workingDirectory,
    issueKey,
    contextTokens,
    contextLimit
  ]);

  // Evaluate when opened or when composer state changes while open (or after a short debounce when closed with text)
  useEffect(() => {
    if (!promptText.trim()) {
      setReport(undefined);
      return;
    }
    if (open) {
      void runEvaluation();
      return;
    }
    const timer = window.setTimeout(() => {
      void runEvaluation();
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, promptText, toolMode, sessionMode, profileId, activeSkillsKey, runEvaluation]);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(580, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width + 48, window.innerWidth - width - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    setPos({ bottom, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('resize', updatePosition);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, updatePosition]);

  const applyFindingRemediation = (finding: FeedbackFinding) => {
    const { remediation } = finding;
    if (remediation.kind === 'change-tool-mode' && onChangeToolMode) {
      onChangeToolMode((remediation.targetId as AgentToolMode) || 'full');
      return;
    }
    if (remediation.kind === 'attach-skill' && remediation.targetId && onAttachSkill) {
      onAttachSkill(remediation.targetId);
      return;
    }
    if (remediation.kind === 'select-agent' && remediation.targetId && onSelectAgent) {
      onSelectAgent(remediation.targetId);
      return;
    }
    if (remediation.suggestedPromptSnippet) {
      const trimmed = promptText.trim();
      if (!trimmed.toLowerCase().includes(remediation.suggestedPromptSnippet.toLowerCase())) {
        onChangePrompt(`${trimmed}\n\n${remediation.suggestedPromptSnippet}`);
      }
    }
  };

  const handleDraftImprovedPrompt = async () => {
    if (!promptText.trim() || rewriting) return;
    setRewriting(true);
    try {
      const rewritten = await window.praxis.ai.rewritePromptFromFeedback({
        promptText,
        issueKey,
        toolMode,
        sessionMode,
        profileId,
        activeSkills
      });
      setReport(rewritten);
    } finally {
      setRewriting(false);
    }
  };

  const applyAllFixes = () => {
    if (!report) return;
    for (const finding of report.findings) {
      if (finding.remediation.kind === 'change-tool-mode' && onChangeToolMode) {
        onChangeToolMode((finding.remediation.targetId as AgentToolMode) || 'full');
      } else if (finding.remediation.kind === 'attach-skill' && finding.remediation.targetId && onAttachSkill) {
        onAttachSkill(finding.remediation.targetId);
      } else if (finding.remediation.kind === 'select-agent' && finding.remediation.targetId && onSelectAgent) {
        onSelectAgent(finding.remediation.targetId);
      }
    }
    const candidatePrompt =
      report.aiRewrite?.rewrittenPrompt?.trim() || report.suggestedPrompt?.trim();
    if (candidatePrompt && candidatePrompt !== promptText.trim()) {
      onChangePrompt(candidatePrompt);
    }
  };

  const preSendDimensions = report
    ? report.dimensions.filter(
        d =>
          d.dimension === 'prompt-clarity' ||
          d.dimension === 'skill-agent-alignment' ||
          d.dimension === 'mcp-leverage'
      )
    : [];

  const suggestedText =
    report?.aiRewrite?.rewrittenPrompt?.trim() || report?.suggestedPrompt?.trim() || '';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-chip session-runtime-chip composer-score-prompt-btn${open ? ' active' : ''}${report ? ` ${gradeToneClass(report.grade)}` : ''}`}
        data-testid="composer-score-prompt-btn"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled || !promptText.trim()}
        title="Deterministically score this prompt and check skills, tools, and MCP readiness before sending"
        onClick={() => {
          setOpen(prev => !prev);
        }}
      >
        <Icon name="sparkles" size={13} />
        <span className="session-runtime-chip-label">
          {report ? `Score Prompt · ${report.overallScore} ${report.grade}` : 'Score Prompt'}
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            id={popoverId}
            ref={popoverRef}
            role="dialog"
            aria-label="Prompt Readiness Check"
            data-testid="prompt-feedback-popover"
            className="prompt-feedback-popover"
            style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
          >
            <div className="prompt-feedback-header">
              <div className="prompt-feedback-title-group">
                <div className="prompt-feedback-title">
                  <span>Prompt Readiness Check</span>
                  {report && (
                    <span className="feedback-digest-chip" data-testid="prompt-feedback-digest">
                      Rubric v{report.rubricVersion} · #{report.inputDigest.slice(0, 6)}
                    </span>
                  )}
                </div>
                <div className="prompt-feedback-sub">
                  Evaluates clarity, file/ticket scope, attached skills, tool access, and MCP readiness before spending tokens
                </div>
              </div>
              {report && (
                <div className="prompt-feedback-score-transition">
                  <div
                    className={`feedback-score-pill ${gradeToneClass(report.grade)}`}
                    data-testid="prompt-feedback-score"
                  >
                    <span className="feedback-score-num">{report.overallScore}</span>
                    <span className="feedback-score-max">/ 100</span>
                    <span className="feedback-grade-letter" data-testid="prompt-feedback-grade">
                      {report.grade}
                    </span>
                  </div>
                  {report.findings.length > 0 && report.projectedScore > report.overallScore && (
                    <>
                      <span className="prompt-feedback-arrow" aria-hidden="true">→</span>
                      <div
                        className={`feedback-score-pill ${gradeToneClass(report.projectedGrade)}`}
                        title="Projected score after applying recommended fixes"
                        data-testid="prompt-feedback-projected-score"
                      >
                        <span className="feedback-score-num">{report.projectedScore}</span>
                        <span className="feedback-score-max">/ 100</span>
                        <span className="feedback-grade-letter">{report.projectedGrade}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {loading && !report && (
              <div className="prompt-feedback-body">
                <span className="placeholder-text">Scoring prompt deterministically…</span>
              </div>
            )}

            {report && (
              <div className="prompt-feedback-body">
                <div className="prompt-feedback-dims" data-testid="prompt-feedback-dimensions">
                  {preSendDimensions.map(dim => {
                    const pct = Math.round((dim.earnedPoints / dim.maxPoints) * 100);
                    const tone = pct >= 80 ? 'is-good' : pct >= 60 ? 'is-warn' : 'is-bad';
                    return (
                      <div
                        key={dim.dimension}
                        className="prompt-feedback-dim-card"
                        data-testid={`prompt-dim-${dim.dimension}`}
                      >
                        <div className="prompt-feedback-dim-top">
                          <span>{dim.label}</span>
                          <span className={`prompt-feedback-dim-pts ${tone}`}>
                            {dim.earnedPoints} / {dim.maxPoints}
                          </span>
                        </div>
                        <div className="feedback-progress-track">
                          <div
                            className={`feedback-progress-fill ${tone}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="prompt-feedback-dim-note">{dim.summary}</div>
                      </div>
                    );
                  })}
                </div>

                {activeSkills.length > 0 && (
                  <div className="prompt-feedback-attached-skills" data-testid="prompt-feedback-attached-skills">
                    <span className="rail-sub">Attached skills:</span>
                    {activeSkills.map(skill => (
                      <span key={skill} className="feedback-cap-pill is-good">
                        ✓ {skill}
                      </span>
                    ))}
                  </div>
                )}

                {report.findings.length === 0 ? (
                  <div className="prompt-feedback-clean" data-testid="prompt-feedback-clean">
                    <Icon name="check" size={14} />
                    <span>Prompt is well-scoped, skills and tool access are aligned, and verification is specified.</span>
                  </div>
                ) : (
                  <div className="prompt-feedback-findings" data-testid="prompt-feedback-findings">
                    <div className="feedback-section-label">
                      <span>How This Prompt Can Do Better ({report.findings.length})</span>
                      <span>One-click deterministic fixes</span>
                    </div>
                    {report.findings.map(finding => (
                      <div
                        key={finding.id}
                        className={`feedback-finding-row is-${finding.severity}`}
                        data-testid={`prompt-finding-${finding.id}`}
                      >
                        <span className={`feedback-delta-badge is-${finding.severity}`}>
                          {finding.deltaPoints} pts
                        </span>
                        <div className="feedback-finding-body">
                          <div className="feedback-finding-title">{finding.title}</div>
                          <div className="feedback-finding-evidence">{finding.evidence}</div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-compact feedback-remediation-btn"
                          data-testid={`prompt-remediation-${finding.id}`}
                          onClick={() => applyFindingRemediation(finding)}
                        >
                          {finding.remediation.label}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {suggestedText && suggestedText !== promptText.trim() && (
                  <div className="prompt-feedback-rewrite-box" data-testid="prompt-feedback-rewrite-box">
                    <div className="prompt-feedback-rewrite-header">
                      <span>✨ Suggested Improved Prompt (Deterministic Upgrade)</span>
                      <button
                        type="button"
                        className="btn btn-compact"
                        data-testid="prompt-feedback-draft-rewrite-btn"
                        disabled={rewriting}
                        onClick={() => void handleDraftImprovedPrompt()}
                      >
                        {rewriting ? 'Refining…' : 'Refresh Rewrite'}
                      </button>
                    </div>
                    <div className="prompt-feedback-rewrite-text" data-testid="prompt-feedback-rewrite-text">
                      {suggestedText}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="prompt-feedback-footer">
              <span className="rail-sub">
                {report && report.findings.length > 0
                  ? `Applying all fixes attaches ${report.inventory.skillsRecommended.length > 0 ? report.inventory.skillsRecommended.join(', ') : 'recommended settings'} and updates prompt`
                  : 'Deterministic rubric v1'}
              </span>
              <div className="prompt-feedback-footer-actions">
                <button
                  type="button"
                  className="btn btn-compact"
                  data-testid="prompt-feedback-close-btn"
                  onClick={() => setOpen(false)}
                >
                  Close
                </button>
                {report && report.findings.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary btn-compact"
                    data-testid="prompt-feedback-apply-all-btn"
                    onClick={applyAllFixes}
                  >
                    Apply All Fixes ({report.overallScore} {report.grade} → {report.projectedScore} {report.projectedGrade})
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
