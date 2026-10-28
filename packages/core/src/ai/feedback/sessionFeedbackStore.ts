import type { KeyValueStore } from '../../host/stateStore';
import type {
  DeterministicFeedbackReport,
  SessionFeedbackSummary,
  UserFeedbackInput
} from './feedbackTypes';

const FEEDBACK_STORAGE_KEY = 'praxis.sessionFeedback.v1';

interface StoredSessionFeedbackState {
  schemaVersion: 1;
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
      reportsByKey: raw.reportsByKey && typeof raw.reportsByKey === 'object' ? { ...raw.reportsByKey } : {},
      userFeedbackByKey:
        raw.userFeedbackByKey && typeof raw.userFeedbackByKey === 'object' ? { ...raw.userFeedbackByKey } : {}
    };
  }

  private async persist(): Promise<void> {
    await this.store.update(FEEDBACK_STORAGE_KEY, this.state);
  }
}
