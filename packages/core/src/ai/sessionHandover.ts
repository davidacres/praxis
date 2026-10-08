import type { AiProvider } from '../types';
import { formatContextSnapshot, type ContextSnapshot } from './contextSnapshot';
import type { TokenUsage } from './gateway';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AgentTaskDefinition,
  AgentTaskState,
  HandoverBrief,
  RuntimeEpochReason,
  SessionPurpose,
  SessionRuntimeEpoch
} from './agentTypes';

export const HANDOVER_BRIEF_SCHEMA_VERSION = 1;

export const RUNTIME_BUSY_STATES: ReadonlySet<AgentTaskState> = new Set([
  'planning',
  'executing'
]);

export class StaleHandoverBriefRevisionError extends Error {
  constructor() {
    super('The handover brief changed while you were editing. Reload and try again.');
    this.name = 'StaleHandoverBriefRevisionError';
  }
}

export class SessionRuntimeBusyError extends Error {
  constructor(state: AgentTaskState) {
    super(`Wait until this turn finishes before changing provider or model (session is ${state}).`);
    this.name = 'SessionRuntimeBusyError';
  }
}

export function purposeFromTask(
  task: AgentTaskDefinition,
  issueKey: string,
  title?: string
): SessionPurpose {
  return {
    issueKey,
    title: title?.trim() || undefined,
    goal: task.goal?.trim() || '',
    scope: task.scope?.trim() || '',
    definitionOfDone: task.definitionOfDone?.trim() || ''
  };
}

export function resolveSessionPurpose(record: AgentSessionRecord): SessionPurpose {
  if (record.purpose) return record.purpose;
  return purposeFromTask(record.taskDefinition, record.issueKey, record.title);
}

export function emptyHandoverBrief(now = new Date().toISOString()): HandoverBrief {
  return {
    schemaVersion: HANDOVER_BRIEF_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    sourceEventCount: 0,
    freshness: 'fresh',
    progress: 'Session has not produced work yet.',
    changes: '',
    decisions: '',
    risks: '',
    openQuestions: '',
    nextSteps: '',
    userNotes: '',
    touchedFiles: []
  };
}

export function newRuntimeEpochId(now = Date.now()): string {
  return `epoch-${now.toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
}

export function initialRuntimeEpoch(
  provider: AiProvider | undefined,
  model: string | undefined,
  startedAt: string,
  runtimeSessionId?: string
): SessionRuntimeEpoch {
  return {
    id: newRuntimeEpochId(),
    provider,
    model: model?.trim() || undefined,
    runtimeSessionId,
    startedAt,
    reason: 'started'
  };
}

export function canChangeSessionRuntime(state: AgentTaskState | undefined): boolean {
  return !state || !RUNTIME_BUSY_STATES.has(state);
}

export function assertCanChangeSessionRuntime(record: AgentSessionRecord): void {
  if (!canChangeSessionRuntime(record.state)) {
    throw new SessionRuntimeBusyError(record.state);
  }
}

function clip(text: string, max = 800): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/** First prose block, without markdown tables — the inspector must not become a second transcript. */
export function summariseForBrief(text: string, max = 240): string {
  const withoutTables = text
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const firstBlock = withoutTables.split(/\n\n+/)[0] ?? withoutTables;
  return clip(firstBlock, max);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** Strip obvious secret-shaped values from portable handover prose. */
export function redactHandoverSecrets(text: string): string {
  return text
    .replace(/(token|secret|password|apikey|api_key|\bpat\b)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/\b(ghp|gho|github_pat|glpat|sk-)[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

export function collectTouchedFiles(events: AgentEventSummary[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    for (const change of event.data?.fileChanges ?? []) {
      if (change.path) paths.push(change.path);
    }
  }
  return unique(paths).slice(0, 40);
}

export interface HandoverBriefContent {
  progress: string;
  changes: string;
  decisions: string;
  risks: string;
  openQuestions: string;
  nextSteps: string;
  touchedFiles: string[];
}

export function buildDeterministicHandoverBrief(record: AgentSessionRecord): HandoverBriefContent {
  const events = record.events ?? [];
  const messages = events.filter(event => event.type === 'message' && (event.detail || event.summary).trim());
  const lastMessage = messages.at(-1);
  const errors = events.filter(event => event.type === 'error').map(event => event.summary);
  const files = collectTouchedFiles(events);
  const completedTasks = (record.taskList ?? []).filter(item => item.status === 'completed').map(item => item.content);
  const pendingTasks = (record.taskList ?? []).filter(item => item.status !== 'completed').map(item => item.content);
  const progress = lastMessage
    ? summariseForBrief(lastMessage.detail || lastMessage.summary)
    : events.some(event => event.type === 'session_start')
      ? 'Session started; no assistant reply has been recorded yet.'
      : 'Session has not produced work yet.';
  const changes = files.length
    ? `Touched ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 12).join(', ')}${files.length > 12 ? '…' : ''}.`
    : 'No file changes have been recorded.';
  const decisions = completedTasks.length ? completedTasks.slice(0, 8).join('; ') : '';
  const risks = errors.length ? unique(errors).slice(0, 6).join('; ') : '';
  const openQuestions = events.some(event => event.type === 'permission_requested')
    ? 'A permission request was raised during this session.'
    : '';
  const nextSteps = pendingTasks.length
    ? pendingTasks.slice(0, 8).join('; ')
    : record.state === 'completed' || record.state === 'paused' || record.state === 'not_started'
      ? 'Await the next user instruction.'
      : 'Continue the current task.';
  return {
    progress: redactHandoverSecrets(progress),
    changes: redactHandoverSecrets(changes),
    decisions: redactHandoverSecrets(decisions),
    risks: redactHandoverSecrets(risks),
    openQuestions: redactHandoverSecrets(openQuestions),
    nextSteps: redactHandoverSecrets(nextSteps),
    touchedFiles: files
  };
}

export interface HandoverBriefRefreshInput {
  purpose: SessionPurpose;
  previous: HandoverBrief;
  content: HandoverBriefContent;
  newEventCount: number;
}

export function applyHandoverBriefContent(
  previous: HandoverBrief,
  content: HandoverBriefContent,
  sourceEventCount: number,
  now = new Date().toISOString()
): HandoverBrief {
  return {
    ...previous,
    schemaVersion: HANDOVER_BRIEF_SCHEMA_VERSION,
    revision: previous.revision + 1,
    updatedAt: now,
    sourceEventCount,
    freshness: 'fresh',
    lastError: undefined,
    progress: content.progress,
    changes: content.changes,
    decisions: content.decisions,
    risks: content.risks,
    openQuestions: content.openQuestions,
    nextSteps: content.nextSteps,
    touchedFiles: content.touchedFiles,
    userNotes: previous.userNotes
  };
}

export function applyHandoverBriefUserEdits(
  previous: HandoverBrief,
  expectedRevision: number,
  edits: Partial<Pick<HandoverBrief, 'progress' | 'changes' | 'decisions' | 'risks' | 'openQuestions' | 'nextSteps' | 'userNotes'>>,
  now = new Date().toISOString()
): HandoverBrief {
  if (previous.revision !== expectedRevision) {
    throw new StaleHandoverBriefRevisionError();
  }
  return {
    ...previous,
    revision: previous.revision + 1,
    updatedAt: now,
    freshness: previous.freshness === 'updating' ? 'updating' : 'fresh',
    progress: edits.progress !== undefined ? edits.progress : previous.progress,
    changes: edits.changes !== undefined ? edits.changes : previous.changes,
    decisions: edits.decisions !== undefined ? edits.decisions : previous.decisions,
    risks: edits.risks !== undefined ? edits.risks : previous.risks,
    openQuestions: edits.openQuestions !== undefined ? edits.openQuestions : previous.openQuestions,
    nextSteps: edits.nextSteps !== undefined ? edits.nextSteps : previous.nextSteps,
    userNotes: edits.userNotes !== undefined ? edits.userNotes : previous.userNotes
  };
}

export function closeRuntimeEpochs(
  epochs: SessionRuntimeEpoch[],
  endedAt: string,
  usage?: TokenUsage
): SessionRuntimeEpoch[] {
  return epochs.map((epoch, index) => {
    if (index !== epochs.length - 1 || epoch.endedAt) return epoch;
    return {
      ...epoch,
      endedAt,
      tokenUsage: usage ?? epoch.tokenUsage
    };
  });
}

export function appendRuntimeEpoch(
  epochs: SessionRuntimeEpoch[],
  next: Omit<SessionRuntimeEpoch, 'id' | 'startedAt'> & { startedAt?: string; id?: string }
): SessionRuntimeEpoch[] {
  const startedAt = next.startedAt ?? new Date().toISOString();
  const closed = closeRuntimeEpochs(epochs, startedAt);
  return [
    ...closed,
    {
      id: next.id ?? newRuntimeEpochId(),
      provider: next.provider,
      model: next.model,
      runtimeSessionId: next.runtimeSessionId,
      startedAt,
      reason: next.reason,
      tokenUsage: next.tokenUsage
    }
  ];
}

export function currentRuntimeEpoch(record: AgentSessionRecord): SessionRuntimeEpoch | undefined {
  return record.runtimeEpochs?.find(epoch => !epoch.endedAt) ?? record.runtimeEpochs?.at(-1);
}

export interface HandoverEnvelope {
  /** What the work stood on (FX-BE-092): source commit, files handed over and left out, dependencies. */
  snapshot?: ContextSnapshot;
  fromProvider?: AiProvider;
  toProvider?: AiProvider;
  fromModel?: string;
  toModel?: string;
  purpose: SessionPurpose;
  brief: HandoverBrief;
  workingDirectory?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  transcript: string;
  text: string;
}

function compactTranscript(events: AgentEventSummary[], maxChars = 6000): string {
  const turns: string[] = [];
  for (const event of events) {
    if (event.type === 'message' && (event.detail || event.summary).trim()) {
      turns.push(`Assistant:\n${clip(event.detail || event.summary, 1200)}`);
    } else if (event.type === 'user_input_completed' && (event.detail || event.summary).trim()) {
      turns.push(`User:\n${clip(event.detail || event.summary, 800)}`);
    } else if (event.type === 'model_change' || event.type === 'provider_handover') {
      turns.push(`${event.type}: ${event.summary}`);
    }
  }
  let text = turns.join('\n\n');
  if (text.length > maxChars) {
    text = `…\n${text.slice(text.length - maxChars)}`;
  }
  return redactHandoverSecrets(text);
}

export function buildHandoverEnvelope(
  record: AgentSessionRecord,
  target: { provider?: AiProvider; model?: string; snapshot?: ContextSnapshot }
): HandoverEnvelope {
  const purpose = resolveSessionPurpose(record);
  const brief = record.handoverBrief ?? emptyHandoverBrief();
  const transcript = compactTranscript(record.events ?? []);
  const workspace = [
    record.workingDirectory ? `Working directory: ${record.workingDirectory}` : '',
    record.worktreePath ? `Worktree: ${record.worktreePath}` : '',
    record.worktreeBranch ? `Branch: ${record.worktreeBranch}` : ''
  ].filter(Boolean).join('\n');
  const text = redactHandoverSecrets(
    [
      '# Session handover',
      '',
      `You are taking over this Praxis session from ${record.provider ?? 'the previous provider'}${record.model ? ` (${record.model})` : ''}.`,
      'Inspect the current files rather than treating this summary as complete.',
      '',
      '## Purpose',
      purpose.title ? `Title: ${purpose.title}` : '',
      `Issue: ${purpose.issueKey}`,
      `Goal: ${purpose.goal}`,
      purpose.scope ? `Scope: ${purpose.scope}` : '',
      purpose.definitionOfDone ? `Definition of done: ${purpose.definitionOfDone}` : '',
      '',
      '## Current brief',
      `Progress: ${brief.progress}`,
      `Changes: ${brief.changes}`,
      brief.decisions ? `Decisions: ${brief.decisions}` : '',
      brief.risks ? `Risks: ${brief.risks}` : '',
      brief.openQuestions ? `Open questions: ${brief.openQuestions}` : '',
      `Next steps: ${brief.nextSteps}`,
      brief.userNotes ? `User notes: ${brief.userNotes}` : '',
      brief.touchedFiles.length ? `Files: ${brief.touchedFiles.join(', ')}` : '',
      '',
      workspace ? `## Workspace\n${workspace}` : '',
      target.snapshot ? formatContextSnapshot(target.snapshot) : '',
      transcript ? `## Conversation\n${transcript}` : '',
      '',
      'Continue the work described in Next steps.'
    ]
      .filter(line => line !== undefined)
      .join('\n')
  );
  return {
    ...(target.snapshot ? { snapshot: target.snapshot } : {}),
    fromProvider: record.provider,
    toProvider: target.provider,
    fromModel: record.model,
    toModel: target.model,
    purpose,
    brief,
    workingDirectory: record.workingDirectory,
    worktreePath: record.worktreePath,
    worktreeBranch: record.worktreeBranch,
    transcript,
    text
  };
}

export function nativeRuntimeClearedPatch(): Pick<
  AgentSessionRecord,
  'runtimeSessionId' | 'acpAvailableCommands' | 'acpCurrentModeId' | 'acpAvailableModes' | 'contextTokens' | 'contextLimit'
> {
  return {
    runtimeSessionId: undefined,
    acpAvailableCommands: undefined,
    acpCurrentModeId: undefined,
    acpAvailableModes: undefined,
    contextTokens: undefined,
    contextLimit: undefined
  };
}

export function hydrateSessionHandoverFields(record: AgentSessionRecord, interrupted = false): AgentSessionRecord {
  const purpose = record.purpose ?? purposeFromTask(record.taskDefinition, record.issueKey, record.title);
  let handoverBrief = record.handoverBrief ?? emptyHandoverBrief(record.startedAt);
  if (interrupted && handoverBrief.freshness === 'updating') {
    handoverBrief = {
      ...handoverBrief,
      freshness: 'stale',
      lastError: 'Session interrupted by an app restart'
    };
  }
  const runtimeEpochs =
    record.runtimeEpochs && record.runtimeEpochs.length > 0
      ? interrupted
        ? closeRuntimeEpochs(record.runtimeEpochs, record.completedAt ?? new Date().toISOString())
        : record.runtimeEpochs
      : [initialRuntimeEpoch(record.provider, record.model, record.startedAt, record.runtimeSessionId)];
  return { ...record, purpose, handoverBrief, runtimeEpochs };
}

export function epochTransitionReason(fromProvider?: AiProvider, toProvider?: AiProvider): RuntimeEpochReason {
  if (fromProvider && toProvider && fromProvider !== toProvider) return 'provider_handover';
  return 'model_change';
}
