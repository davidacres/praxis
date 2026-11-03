import { createHash } from 'node:crypto';
import type { ConversationAttempt, ConversationMessage, ConversationTurn, DurableConversation } from './assistantTypes';

/** Stable JSON encoding: object key order must not change command identity. */
export function conversationPayloadDigest(payload: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
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
export function completeConversationAttempt(current: DurableConversation, expected: number, turnId: string, attemptId: string, epoch: string, message: ConversationMessage, receipt: ConversationAttempt['contextReceipt']): DurableConversation {
  const next = changed(current, expected);
  const turn = next.turns.find(item => item.id === turnId);
  const attempt = turn?.attempts.find(item => item.id === attemptId);
  if (!turn || !attempt || turn.state !== 'running' || epoch !== current.coordinatorEpoch || epoch !== attempt.coordinatorEpoch ||
      (!['dispatching', 'running', 'awaiting_approval'].includes(attempt.state) || !attempt.dispatchIntent) || turn.attempts.filter(item => item.participantId === attempt.participantId).at(-1)?.id !== attemptId ||
      turn.completedParticipantIds.includes(attempt.participantId) || message.turnId !== turnId || message.participantId !== attempt.participantId ||
      message.role !== turn.plan.participants.find(item => item.id === attempt.participantId)?.role || next.messages.some(item => item.id === message.id) ||
      message.sequence !== (current.messages.at(-1)?.sequence ?? 0) + 1 || receipt.digest !== attempt.contextReceipt.digest ||
      JSON.stringify(receipt) !== JSON.stringify(attempt.contextReceipt)) throw new Error('Invalid, duplicate or fenced completion.');
  attempt.state = 'completed';
  attempt.resultMessageId = message.id;
  attempt.completedAt = message.createdAt;
  turn.completedParticipantIds.push(attempt.participantId);
  if (turn.completedParticipantIds.length === turn.plan.participants.length) turn.state = 'completed';
  next.messages.push(structuredClone(message));
  return next;
}
