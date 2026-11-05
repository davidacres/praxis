import { createHash } from 'node:crypto';
import type { ConversationAttempt, ConversationMessage, ConversationTurn, DurableConversation } from './assistantTypes';

/** Stable JSON encoding: object key order must not change command identity. */
export function conversationPayloadDigest(payload: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new Error('Command payload must contain only JSON values; sparse arrays are invalid.');
      }
      return `[${value.map(canonical).join(',')}]`;
    }
    if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    throw new Error('Command payload must contain only JSON values.');
  };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}
function revision(current: DurableConversation, expected: number): void {
  if (current.revision !== expected) throw new Error('Conversation revision conflict.');
}
function changed(current: DurableConversation, expected: number): DurableConversation {
  revision(current, expected);
  const next = structuredClone(current);
  next.revision++;
  return next;
}
export function submitConversationTurn(current: DurableConversation, expected: number, payload: unknown, turn: ConversationTurn, message: ConversationMessage): DurableConversation {
  const digest = conversationPayloadDigest(payload);
  const receipt = current.commandReceipts.find(item => item.commandId === turn.commandId);
  if (receipt) {
    if (receipt.payloadDigest !== digest) throw new Error('Command payload conflict.');
    return structuredClone(current);
  }
  const next = changed(current, expected);
  if (turn.state !== 'queued' || turn.attempts.length || turn.completedParticipantIds.length || turn.payloadDigest !== digest ||
      turn.userMessageId !== message.id || message.turnId !== turn.id || message.role !== 'user' || message.participantId ||
      message.sequence !== (current.messages.at(-1)?.sequence ?? 0) + 1 || turn.acceptedSequence !== message.sequence ||
      current.turns.some(item => item.id === turn.id) || current.messages.some(item => item.id === message.id) ||
      !turn.plan.participants.length || new Set(turn.plan.participants.map(item => item.id)).size !== turn.plan.participants.length ||
      new Set(turn.plan.participants.map(item => item.role)).size !== turn.plan.participants.length) throw new Error('Invalid accepted turn.');
  next.turns.push(structuredClone(turn));
  next.messages.push(structuredClone(message));
  next.commandReceipts.push({ commandId: turn.commandId, payloadDigest: digest, turnId: turn.id, revision: next.revision, outcome: 'accepted' });
  return next;
}
export function startConversationTurn(current: DurableConversation, expected: number, turnId: string): DurableConversation {
  const next = changed(current, expected);
  if (next.turns.some(turn => !['queued', 'completed', 'cancelled'].includes(turn.state))) throw new Error('Conversation already has an active or paused turn.');
  const turn = next.turns.find(item => item.state === 'queued');
  if (!turn || turn.id !== turnId) throw new Error('Turn is not the next queued turn.');
  turn.state = 'running';
  return next;
}
const terminal = new Set(['completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled']);
export function reserveConversationAttempt(current: DurableConversation, expected: number, attempt: ConversationAttempt): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === attempt.turnId);
  const participant = turn?.plan.participants.find(item => !turn.completedParticipantIds.includes(item.id));
  if (!turn || turn.state !== 'running' || participant?.id !== attempt.participantId || attempt.coordinatorEpoch !== current.coordinatorEpoch ||
      attempt.state !== 'prepared' || attempt.ordinal !== turn.attempts.filter(item => item.participantId === attempt.participantId).length + 1 ||
      next.turns.some(item => item.attempts.some(existing => existing.id === attempt.id)) || turn.attempts.some(item => !terminal.has(item.state))) throw new Error('Invalid or fenced attempt.');
  turn.attempts.push(structuredClone(attempt));
  return next;
}
/** Advance dispatch evidence without changing the immutable accepted plan. */
export function advanceConversationAttempt(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, state: 'dispatching' | 'running' | 'awaiting_approval', timestamp: string): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  const allowed: Record<string, string[]> = { prepared: ['dispatching'], dispatching: ['running'], running: ['awaiting_approval'], awaiting_approval: ['running'] };
  if (!turn || turn.state !== 'running' || !attempt || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch || !allowed[attempt.state]?.includes(state)) {
    throw new Error('Invalid or fenced attempt transition.');
  }
  attempt.state = state;
  if (state === 'dispatching') attempt.dispatchIntent = timestamp;
  return next;
}
/** Record the runtime request an attempt is blocked on. Fenced by epoch and attempt; moves running -> awaiting_approval. */
export function recordAttemptApproval(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, runtimeRequestId: string, timestamp: string): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  if (!runtimeRequestId?.trim() || !turn || !attempt || !['running', 'cancelling'].includes(turn.state) || epoch !== current.coordinatorEpoch ||
      epoch !== attempt.coordinatorEpoch || attempt.state !== 'running' || turn.attempts.at(-1)?.id !== attemptId) throw new Error('Invalid or fenced approval request.');
  attempt.state = 'awaiting_approval';
  attempt.pendingApproval = { runtimeRequestId, requestedAt: timestamp, coordinatorEpoch: epoch, status: 'pending' };
  return next;
}
/** Resolve the pending approval of a live attempt and let it continue. */
export function resolveAttemptApproval(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, runtimeRequestId: string): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  if (!turn || !attempt || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch || attempt.state !== 'awaiting_approval' ||
      attempt.pendingApproval?.status !== 'pending' || attempt.pendingApproval.runtimeRequestId !== runtimeRequestId) throw new Error('Invalid or fenced approval resolution.');
  attempt.pendingApproval.status = 'resolved';
  attempt.state = 'running';
  return next;
}
/** Invalidate unresolved approval callbacks; the request is never carried to another attempt. */
export function invalidateAttemptApproval(attempt: ConversationAttempt): boolean {
  if (attempt.pendingApproval?.status !== 'pending') return false;
  attempt.pendingApproval.status = 'invalidated';
  return true;
}
/**
 * Re-request an invalidated approval only when a live runtime request with the same identity
 * is observed for the same attempt. The attempt keeps its conservative interrupted/unknown state.
 */
export function restoreAttemptApproval(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, liveRequestId: string, timestamp: string): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  if (!turn || !attempt || epoch !== current.coordinatorEpoch || attempt.pendingApproval?.status !== 'invalidated' ||
      attempt.pendingApproval.runtimeRequestId !== liveRequestId || !['interrupted', 'outcome_unknown'].includes(attempt.state) ||
      turn.attempts.at(-1)?.id !== attemptId) throw new Error('Approval cannot be restored.');
  attempt.pendingApproval.status = 'restored';
  attempt.pendingApproval.restoredEpoch = epoch;
  (attempt.recoveryEvidence ??= []).push({ id: `approval-restored:${epoch}:${attempt.id}`, conversationId: current.id, turnId, participantId: attempt.participantId,
    attemptId, coordinatorEpoch: attempt.coordinatorEpoch, observingEpoch: epoch, kind: 'reconciliation', observedAt: timestamp,
    provenance: 'runtime-live-approval', data: { approvalRequestId: liveRequestId, restored: true } });
  return next;
}
const ACTIVE_ATTEMPT_STATES = new Set(['dispatching', 'running', 'awaiting_approval']);
const RECOVERABLE_TURN_STATES = new Set(['running', 'cancelling', 'interrupted', 'outcome_unknown', 'failed']);
const RECOVERABLE_ATTEMPT_STATES = new Set(['prepared', 'dispatching', 'running', 'awaiting_approval', 'interrupted', 'outcome_unknown', 'failed']);
export function completeConversationAttempt(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, message: ConversationMessage, receipt: ConversationAttempt['contextReceipt'], evidence?: { reportedCost?: { currency: string; amount: number }; providerSessionId?: string; usage?: import('../gateway/wire').TokenUsage; usageReferences?: string[]; toolEvidenceReferences?: string[] }, recoveredResultId?: string): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  const recovered = recoveredResultId !== undefined && Boolean(attempt?.recoveryEvidence?.some(item =>
    item.id === recoveredResultId && item.kind === 'final_result' && item.conversationId === current.id &&
    item.turnId === turnId && item.attemptId === attemptId && item.participantId === attempt.participantId &&
    item.coordinatorEpoch === attempt.coordinatorEpoch && (item.result?.text ?? item.data?.text) === message.text));
  // Recovery uses the immutable originating epoch, even after startup advances the coordinator.
  // A durable result is sufficient without dispatch intent; ordinary callbacks still require it.
  if (!turn || !attempt || epoch !== attempt.coordinatorEpoch || (recoveredResultId !== undefined && !recovered) ||
      (recovered ? !RECOVERABLE_TURN_STATES.has(turn.state) || !RECOVERABLE_ATTEMPT_STATES.has(attempt.state)
        : turn.state !== 'running' || epoch !== current.coordinatorEpoch || !ACTIVE_ATTEMPT_STATES.has(attempt.state) || !attempt.dispatchIntent) ||
      turn.attempts.filter(item => item.participantId === attempt.participantId).at(-1)?.id !== attemptId ||
      turn.completedParticipantIds.includes(attempt.participantId) || message.turnId !== turnId || message.participantId !== attempt.participantId ||
      message.role !== turn.plan.participants.find(item => item.id === attempt.participantId)?.role || next.messages.some(item => item.id === message.id) ||
      message.sequence !== (current.messages.at(-1)?.sequence ?? 0) + 1 ||
      ![attempt.contextReceipt, attempt.nativeContextReceipt].some(candidate => candidate && JSON.stringify(receipt) === JSON.stringify(candidate))) throw new Error('Invalid, duplicate or fenced completion.');
  attempt.contextReceipt = structuredClone(receipt);
  if (evidence?.reportedCost) attempt.reportedCost = structuredClone(evidence.reportedCost);
  if (evidence?.usage) attempt.usage = structuredClone(evidence.usage);
  attempt.usageReferences = [...new Set(evidence?.usageReferences ?? [])];
  attempt.toolEvidenceReferences = [...new Set(evidence?.toolEvidenceReferences ?? [])];
  const binding = next.bindings.find(b => b.id === attempt.bindingId && b.status === 'valid');
  if (evidence?.providerSessionId) attempt.providerSessionId = evidence.providerSessionId;
  if (binding) {
    if (evidence?.providerSessionId) binding.providerSessionId = evidence.providerSessionId;
    binding.deliveredMessageIds = [...new Set([...binding.deliveredMessageIds, ...receipt.messageIds])];
    binding.nativeOutputMessageIds.push(message.id);
    if (receipt.summaryId) {
      const summary = next.summaries.find(s => s.id === receipt.summaryId);
      if (!summary) throw new Error('Missing delivered summary provenance.');
      binding.summaryId = summary.id;
      binding.summarizedMessageIds = [...new Set([...(binding.summarizedMessageIds ?? []), ...(summary.sourceMessageIds ?? next.messages.filter(m => m.sequence >= summary.sourceStart && m.sequence <= summary.sourceEnd).map(m => m.id))])];
    }
  }
  attempt.state = 'completed';
  attempt.resultMessageId = message.id;
  attempt.completedAt = message.createdAt;
  turn.completedParticipantIds.push(attempt.participantId);
  if (turn.completedParticipantIds.length + (turn.skippedParticipantIds?.length ?? 0) === turn.plan.participants.length) turn.state = 'completed';
  if (turn.state !== 'completed') turn.state = 'running';
  next.messages.push(structuredClone(message));
  return next;
}

/** Start a new durable coordinator generation and classify attempts conservatively. */
export function beginConversationEpoch(current: DurableConversation, expected: number, epoch: string, timestamp: string): DurableConversation {
  const next = changed(current, expected);
  if (!epoch || epoch === current.coordinatorEpoch) throw new Error('A fresh coordinator epoch is required.');
  next.coordinatorEpoch = epoch;
  for (const turn of next.turns) {
    for (const attempt of turn.attempts) {
      if (['prepared', 'dispatching', 'running', 'awaiting_approval'].includes(attempt.state)) {
        invalidateAttemptApproval(attempt);
        const wasDispatched = Boolean(attempt.dispatchIntent);
        const toolCapable = !attempt.recoveryEvidence?.some(item => item.kind === 'runtime_identity' && item.data?.toolCapable === false);
        attempt.state = wasDispatched && toolCapable ? 'outcome_unknown' : 'interrupted';
        attempt.completedAt = timestamp;
        attempt.recoveryEvidence ??= [];
        attempt.recoveryEvidence.push({ id: `recovery:${epoch}:${attempt.id}`, conversationId: current.id, turnId: turn.id,
          participantId: attempt.participantId, attemptId: attempt.id, coordinatorEpoch: attempt.coordinatorEpoch,
          observingEpoch: epoch, kind: 'reconciliation', observedAt: timestamp, provenance: 'coordinator-startup', data: { dispatched: wasDispatched, toolCapable } });
        turn.state = attempt.state === 'outcome_unknown' ? 'outcome_unknown' : 'interrupted';
      }
    }
  }
  return next;
}
