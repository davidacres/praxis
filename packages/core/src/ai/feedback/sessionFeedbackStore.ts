import { findingRuleKey, type FindingReview, type FindingFeedbackState, type ReviewFindingRequest } from './feedbackCoaching';
import type { KeyValueStore } from '../../host/stateStore';
import type {
  DeterministicFeedbackReport,
  SessionFeedbackSummary,
  UserFeedbackInput
} from './feedbackTypes';

const FEEDBACK_STORAGE_KEY = 'praxis.sessionFeedback.v1';

interface StoredSessionFeedbackState {
  schemaVersion: 1;
  reviews?: Record<string, FindingReview>;
  mutedRules?: string[];
  reportsByKey: Record<string, DeterministicFeedbackReport>;
  userFeedbackByKey: Record<string, UserFeedbackInput>;
}

/**
 * Builds the canonical lookup key for a session or turn feedback record.
 */
export function feedbackRecordKey(issueOrSessionKey: string, turnIndex?: number): string {
  const base = issueOrSessionKey.trim();
  return turnIndex !== undefined && turnIndex >= 0 ? `${base}#turn:${turnIndex}` : base;
}

/**
 * Profile-local store (`session-feedback.json` via `KeyValueStore`) for persisted
 * user feedback submissions and deterministic feedback reports.
 */
export class SessionFeedbackStore {
  private state: StoredSessionFeedbackState;

  public constructor(private readonly store: KeyValueStore) {
    this.state = this.load();
  }

  public getReport(issueOrSessionKey: string, turnIndex?: number): DeterministicFeedbackReport | undefined {
    const key = feedbackRecordKey(issueOrSessionKey, turnIndex);
    return this.state.reportsByKey[key];
  }

  public getUserFeedback(issueOrSessionKey: string, turnIndex?: number): UserFeedbackInput | undefined {
    const key = feedbackRecordKey(issueOrSessionKey, turnIndex);
    return this.state.userFeedbackByKey[key];
  }

  public async saveReport(
    issueOrSessionKey: string,
    report: DeterministicFeedbackReport,
    turnIndex?: number
  ): Promise<DeterministicFeedbackReport> {
    const key = feedbackRecordKey(issueOrSessionKey, turnIndex);
    this.state.reportsByKey[key] = report;
    if (report.userFeedback) {
      this.state.userFeedbackByKey[key] = report.userFeedback;
    }
    await this.persist();
    return report;
  }

  public async saveUserFeedback(
    issueOrSessionKey: string,
    feedback: UserFeedbackInput,
    turnIndex?: number
  ): Promise<void> {
    const key = feedbackRecordKey(issueOrSessionKey, turnIndex);
    this.state.userFeedbackByKey[key] = feedback;
    await this.persist();
  }

  public listReports(): DeterministicFeedbackReport[] {
    return Object.values(this.state.reportsByKey);
  }

  public getFindingFeedback(inputDigest: string): FindingFeedbackState {
    const all = Object.values(this.state.reviews ?? {});
    const rules = new Map<string, FindingFeedbackState['rules'][number]>();
    for (const review of all) {
      const rule = rules.get(review.ruleKey) ?? { ruleKey: review.ruleKey, useful: 0, contextClear: 0, wrong: 0, muted: false };
      if (review.verdict === 'useful') rule.useful++; else if (review.verdict === 'wrong') rule.wrong++; else rule.contextClear++;
      rule.muted = (this.state.mutedRules ?? []).includes(review.ruleKey);
      rules.set(review.ruleKey, rule);
    }
    return { reviews: all.filter(review => review.inputDigest === inputDigest), rules: [...rules.values()] };
  }

  public async reviewFinding(report: DeterministicFeedbackReport, input: ReviewFindingRequest): Promise<FindingFeedbackState> {
    const finding = report.findings.find(f => f.id === input.findingId);
    if (report.inputDigest !== input.inputDigest || !finding || (input.verdict !== undefined && !['useful', 'context-clear', 'wrong'].includes(input.verdict)) || (input.verdict === undefined && typeof input.muted !== 'boolean')) throw new Error('Invalid finding review.');
    const ruleKey = findingRuleKey(report, finding.id);
    const reviews = { ...this.state.reviews };
    if (input.verdict !== undefined) reviews[`${report.inputDigest}/${finding.id}`] = { inputDigest: report.inputDigest, findingId: finding.id, ruleKey, verdict: input.verdict,
      promptText: report.promptText, title: finding.title, evidence: finding.evidence, model: report.clarity?.model,
      assessment: report.clarity, context: report.reviewContext,
      checklistVersion: report.clarity?.checklistVersion, rubricVersion: report.rubricVersion, updatedAt: new Date().toISOString() };
    const previous = this.state;
    const muted = new Set(this.state.mutedRules ?? []);
    if (input.muted === true) muted.add(ruleKey); else if (input.muted === false) muted.delete(ruleKey);
    this.state = { ...this.state, reviews, mutedRules: [...muted] };
    try { await this.persist(); } catch (error) { this.state = previous; throw error; }
    return this.getFindingFeedback(report.inputDigest);
  }

  public static toSessionSummary(report: DeterministicFeedbackReport): SessionFeedbackSummary {
    return {
      overallScore: report.overallScore,
      grade: report.grade,
      ...(report.userFeedback?.verdict ? { verdict: report.userFeedback.verdict } : {}),
      findingCount: report.findings.length,
      updatedAt: report.evaluatedAt
    };
  }

  private load(): StoredSessionFeedbackState {
    const raw = this.store.get<StoredSessionFeedbackState>(FEEDBACK_STORAGE_KEY);
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) {
      return {
        schemaVersion: 1,
        reportsByKey: {},
        userFeedbackByKey: {}
      };
    }
    return {
      schemaVersion: 1,
      reviews: raw.reviews ?? {},
      mutedRules: Array.isArray(raw.mutedRules) ? raw.mutedRules : [],
      reportsByKey: raw.reportsByKey && typeof raw.reportsByKey === 'object' ? { ...raw.reportsByKey } : {},
      userFeedbackByKey:
        raw.userFeedbackByKey && typeof raw.userFeedbackByKey === 'object' ? { ...raw.userFeedbackByKey } : {}
    };
  }

  private async persist(): Promise<void> {
    await this.store.update(FEEDBACK_STORAGE_KEY, this.state);
  }
}
