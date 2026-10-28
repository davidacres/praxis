import { useCallback, useEffect, useState } from 'react';
import type {
  AgentSessionRecord,
  AgentToolMode,
  DeterministicFeedbackReport,
  FeedbackFinding,
  FeedbackFrictionTag,
  FeedbackGrade,
  FeedbackVerdict
} from '@praxis/core';
import { Icon } from '../ui/Icon';

export interface SessionFeedbackPanelProps {
  session: AgentSessionRecord;
  turnIndex?: number;
  onClearTurnScope?: () => void;
  onOpenAgent?: (profileId: string) => void;
  onOpenSkill?: (skillName: string) => void;
}

const FRICTION_TAG_OPTIONS: Array<{ id: FeedbackFrictionTag; label: string }> = [
  { id: 'missed-skill', label: 'Missed Skill' },
  { id: 'missed-mcp', label: 'Missed MCP' },
  { id: 'wasted-steps', label: 'Wasted Tool Steps' },
  { id: 'wrong-scope', label: 'Wrong Scope' },
  { id: 'ignored-instructions', label: 'Ignored Instructions' },
  { id: 'unverified-changes', label: 'Unverified Changes' }
];

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

export function SessionFeedbackPanel({
  session,
  turnIndex,
  onClearTurnScope,
  onOpenAgent,
  onOpenSkill
}: SessionFeedbackPanelProps) {
  const [report, setReport] = useState<DeterministicFeedbackReport | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [expandedDims, setExpandedDims] = useState<Record<string, boolean>>({});

  // Human feedback form state
  const [verdict, setVerdict] = useState<FeedbackVerdict>('helpful');
  const [frictionTags, setFrictionTags] = useState<FeedbackFrictionTag[]>([]);
  const [notes, setNotes] = useState('');

  const loadEvaluation = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const evaluated = await window.praxis.ai.evaluateSession(
        { issueKey: session.issueKey, turnIndex },
        turnIndex
      );
      setReport(evaluated);
      if (evaluated.userFeedback) {
        setVerdict(evaluated.userFeedback.verdict ?? 'helpful');
        setFrictionTags(evaluated.userFeedback.frictionTags ?? []);
        setNotes(evaluated.userFeedback.notes ?? '');
      } else {
        setVerdict(session.state === 'failed' ? 'failed-goal' : 'helpful');
        setFrictionTags([]);
        setNotes('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [session.issueKey, session.stepCount, session.state, turnIndex]);

  useEffect(() => {
    void loadEvaluation();
  }, [loadEvaluation]);

  const toggleFrictionTag = (tag: FeedbackFrictionTag) => {
    setFrictionTags(prev =>
      prev.includes(tag) ? prev.filter(item => item !== tag) : [...prev, tag]
    );
    setSavedBanner(false);
  };

  const handleSaveFeedback = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    setSavedBanner(false);
    try {
      const updated = await window.praxis.ai.submitSessionFeedback({
        issueKey: session.issueKey,
        sessionId: session.sessionId,
        turnIndex,
        promptText: report?.promptText ?? session.taskDefinition?.goal ?? '',
        verdict,
        frictionTags,
        notes
      });
      setReport(updated);
      setSavedBanner(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const applyToFollowUp = (finding?: FeedbackFinding) => {
    if (!report) return;
    const skillsToAttach = finding?.remediation.kind === 'attach-skill' && finding.remediation.targetId
      ? [finding.remediation.targetId]
      : report.inventory.skillsRecommended;

    const toolModeFix = finding?.remediation.kind === 'change-tool-mode'
      ? (finding.remediation.targetId as AgentToolMode)
      : report.findings.find(f => f.remediation.kind === 'change-tool-mode')?.remediation.targetId as AgentToolMode | undefined;

    const followUpPrompt = finding?.remediation.suggestedPromptSnippet
      ? finding.remediation.suggestedPromptSnippet
      : report.aiRewrite?.rewrittenPrompt?.trim() || report.suggestedPrompt?.trim() || '';

    window.dispatchEvent(
      new CustomEvent('praxis:apply-feedback-followup', {
        detail: {
          issueKey: session.issueKey,
          promptText: followUpPrompt,
          skillsToAttach,
          toolMode: toolModeFix,
          recommendedAgentProfileId: report.inventory.recommendedAgentProfileId
        }
      })
    );
  };

  if (loading && !report) {
    return (
      <div className="session-feedback-panel" data-testid="session-feedback-panel">
        <span className="placeholder-text">Computing deterministic session scorecard…</span>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="session-feedback-panel" data-testid="session-feedback-panel">
        {error ? (
          <p className="hint is-danger">{error}</p>
        ) : (
          <span className="placeholder-text">No evaluation available for this session.</span>
        )}
      </div>
    );
  }

  const allSkillsUsed = [
    ...new Set([...report.inventory.skillsAttached, ...report.inventory.skillsDetected])
  ];

  return (
    <div className="session-feedback-panel" data-testid="session-feedback-panel">
      {turnIndex !== undefined && (
        <div className="feedback-turn-scope-banner" data-testid="feedback-turn-scope-banner">
          <span>Scoped to Turn #{turnIndex + 1}</span>
          {onClearTurnScope && (
            <button
              type="button"
              className="btn btn-compact"
              onClick={onClearTurnScope}
            >
              Show Full Session
            </button>
          )}
        </div>
      )}

      {/* 1. DETERMINISTIC SCORECARD */}
      <section className="feedback-card-section" data-testid="session-scorecard-summary">
        <div className="feedback-score-hero">
          <div className="feedback-score-hero-meta">
            <div className="feedback-section-title">Deterministic Scorecard</div>
            <div className="feedback-digest-row">
              <span className="feedback-digest-chip" data-testid="session-feedback-rubric">
                Rubric v{report.rubricVersion}
              </span>
              <span className="feedback-digest-chip" data-testid="session-feedback-digest">
                #{report.inputDigest.slice(0, 8)}
              </span>
              <span className="rail-sub">Reproducible</span>
            </div>
          </div>
          <div
            className={`feedback-score-pill ${gradeToneClass(report.grade)}`}
            data-testid="session-feedback-overall-score"
          >
            <span className="feedback-score-num">{report.overallScore}</span>
            <span className="feedback-score-max">/ 100</span>
            <span className="feedback-grade-letter" data-testid="session-feedback-grade">
              {report.grade}
            </span>
          </div>
        </div>

        <div className="feedback-dimension-list" data-testid="session-feedback-dimensions">
          {report.dimensions.map(dim => {
            const pct = Math.round((dim.earnedPoints / dim.maxPoints) * 100);
            const tone = pct >= 80 ? 'is-good' : pct >= 60 ? 'is-warn' : 'is-bad';
            const expanded = Boolean(expandedDims[dim.dimension]);
            return (
              <div
                key={dim.dimension}
                className="feedback-dimension-row"
                data-testid={`session-dim-${dim.dimension}`}
              >
                <button
                  type="button"
                  className="feedback-dimension-toggle"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedDims(prev => ({ ...prev, [dim.dimension]: !prev[dim.dimension] }))
                  }
                >
                  <span className="feedback-dimension-label">{dim.label}</span>
                  <span className={`feedback-dimension-pts ${tone}`}>
                    {dim.earnedPoints} / {dim.maxPoints}
                  </span>
                </button>
                <div className="feedback-progress-track">
                  <div
                    className={`feedback-progress-fill ${tone}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {expanded && (
                  <div className="feedback-dimension-summary">{dim.summary}</div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. CAPABILITY AUDIT */}
      <section className="feedback-card-section" data-testid="session-capability-audit">
        <div className="feedback-section-title">Capability Audit (Used vs. Missed)</div>
        <div className="feedback-audit-grid">
          <div className="feedback-audit-key">Agent Profile</div>
          <div className="feedback-audit-val" data-testid="audit-agent-profile">
            {report.inventory.agentProfileId ? (
              <span
                className="feedback-cap-pill is-good"
                onClick={() => onOpenAgent?.(report.inventory.agentProfileId!)}
                style={onOpenAgent ? { cursor: 'pointer' } : undefined}
              >
                ✓ {report.inventory.agentProfileId}
              </span>
            ) : (
              <span className="rail-sub">Default runtime agent</span>
            )}
            {report.inventory.recommendedAgentProfileId && (
              <span className="feedback-cap-pill is-warn">
                ! Prefer {report.inventory.recommendedAgentProfileId}
              </span>
            )}
          </div>

          <div className="feedback-audit-key">Skills Used</div>
          <div className="feedback-audit-val" data-testid="audit-skills-used">
            {allSkillsUsed.length > 0 ? (
              allSkillsUsed.map(skill => (
                <span
                  key={skill}
                  className="feedback-cap-pill is-good"
                  onClick={() => onOpenSkill?.(skill)}
                  style={onOpenSkill ? { cursor: 'pointer' } : undefined}
                >
                  ✓ {skill}
                </span>
              ))
            ) : (
              <span className="rail-sub">None attached or loaded</span>
            )}
          </div>

          <div className="feedback-audit-key">Skills Missed</div>
          <div className="feedback-audit-val" data-testid="audit-skills-missed">
            {report.inventory.skillsRecommended.length > 0 ? (
              report.inventory.skillsRecommended.map(skill => (
                <span key={skill} className="feedback-cap-pill is-bad">
                  ! {skill}
                </span>
              ))
            ) : (
              <span className="feedback-cap-pill is-good">0 missed</span>
            )}
          </div>

          <div className="feedback-audit-key">Tools Called</div>
          <div className="feedback-audit-val" data-testid="audit-tools-called">
            <span className="feedback-cap-pill">
              {report.inventory.totalToolCalls} total · {report.inventory.successfulToolCalls} ok
            </span>
            {report.inventory.failedToolCalls > 0 && (
              <span className="feedback-cap-pill is-bad">
                {report.inventory.failedToolCalls} failed · {report.inventory.retryLoopCount} {report.inventory.retryLoopCount === 1 ? 'loop' : 'loops'}
              </span>
            )}
          </div>

          <div className="feedback-audit-key">MCP Leverage</div>
          <div className="feedback-audit-val" data-testid="audit-mcp-leverage">
            <span className="feedback-cap-pill">
              {report.inventory.mcpToolsUsed.length} MCP {report.inventory.mcpToolsUsed.length === 1 ? 'tool' : 'tools'}
            </span>
            {report.inventory.shellSearchFallbackCount > 0 && (
              <span className="feedback-cap-pill is-warn">
                {report.inventory.shellSearchFallbackCount} raw shell grep
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 3. HOW IT SHOULD HAVE DONE BETTER */}
      <section className="feedback-card-section" data-testid="session-feedback-findings">
        <div className="feedback-section-title">
          How It Should Have Done Better ({report.findings.length})
        </div>
        {report.findings.length === 0 ? (
          <p className="rail-sub" data-testid="session-feedback-no-findings">
            No deductions recorded. Prompt clarity, tool efficiency, skill alignment, MCP leverage, and verification all scored full marks.
          </p>
        ) : (
          <div className="feedback-findings-stack">
            {report.findings.map(finding => (
              <div
                key={finding.id}
                className={`feedback-finding-card is-${finding.severity}`}
                data-testid={`session-finding-${finding.id}`}
              >
                <div className="feedback-finding-card-top">
                  <span className={`feedback-delta-badge is-${finding.severity}`}>
                    {finding.deltaPoints} pts
                  </span>
                  <strong className="feedback-finding-title">{finding.title}</strong>
                </div>
                <p className="feedback-finding-evidence">{finding.evidence}</p>
                <div className="feedback-finding-card-actions">
                  {finding.stepIndices && finding.stepIndices.length > 0 && (
                    <span className="feedback-step-badge">
                      Steps {finding.stepIndices.map(s => `#${s}`).join(', ')}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-compact feedback-remediation-btn"
                    data-testid={`session-remediation-${finding.id}`}
                    onClick={() => applyToFollowUp(finding)}
                  >
                    {finding.remediation.label}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. HUMAN FEEDBACK FORM */}
      <section className="feedback-card-section" data-testid="session-human-feedback-form">
        <div className="feedback-section-title">Your Feedback</div>
        <div className="feedback-verdict-group" role="group" aria-label="Session verdict">
          {(
            [
              { value: 'helpful', label: '👍 Helpful' },
              { value: 'needs-work', label: '⚠ Needs Work' },
              { value: 'failed-goal', label: '✕ Failed Goal' }
            ] as const
          ).map(option => (
            <button
              key={option.value}
              type="button"
              className={`feedback-verdict-btn is-${option.value}${verdict === option.value ? ' active' : ''}`}
              data-testid={`feedback-verdict-${option.value}`}
              aria-pressed={verdict === option.value}
              onClick={() => {
                setVerdict(option.value);
                setSavedBanner(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="feedback-friction-chips" role="group" aria-label="Friction tags">
          {FRICTION_TAG_OPTIONS.map(tag => {
            const active = frictionTags.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                className={`feedback-friction-chip${active ? ' active' : ''}`}
                data-testid={`feedback-tag-${tag.id}`}
                aria-pressed={active}
                onClick={() => toggleFrictionTag(tag.id)}
              >
                {active ? `✓ ${tag.label}` : tag.label}
              </button>
            );
          })}
        </div>

        <textarea
          className="textarea feedback-notes-input"
          data-testid="session-feedback-notes"
          rows={2}
          placeholder="Add notes on what the session or prompt should have done differently…"
          value={notes}
          onChange={e => {
            setNotes(e.target.value);
            setSavedBanner(false);
          }}
        />

        {savedBanner && (
          <p className="hint" data-testid="session-feedback-saved-notice">
            ✓ Feedback saved and deterministic score updated ({report.overallScore} · {report.grade}).
          </p>
        )}
        {error && <p className="hint is-danger">{error}</p>}

        <div className="feedback-form-actions">
          <button
            type="button"
            className="btn btn-compact"
            data-testid="session-feedback-save-btn"
            disabled={saving}
            onClick={() => void handleSaveFeedback()}
          >
            {saving ? 'Saving…' : 'Save Feedback'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-compact"
            data-testid="session-feedback-apply-followup-btn"
            onClick={() => applyToFollowUp()}
          >
            Apply Improvements to Follow-Up →
          </button>
        </div>
      </section>
    </div>
  );
}
