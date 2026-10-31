import { useSyncExternalStore } from 'react';
import type { WireImageAttachment } from '@praxis/core';

/**
 * The turn a person has just sent, before the session records it. The composer
 * owns that state, but on the session page the transcript is a separate
 * component (`AgentActivityFeed`), so the composer publishes it here and the
 * transcript reads it — otherwise a sent message only appears once the record
 * catches up, a visible second or two later.
 */
export interface PendingTurn {
  optimisticFollowUp?: { message: string; images?: WireImageAttachment[]; suppressPreviousResponse?: boolean };
  optimisticTerminalContext?: { cwd: string; output: string; message: string };
  livePendingConversationMessages?: Array<{ participantId?: string; message: string }>;
}

const turns = new Map<string, PendingTurn>();
const listeners = new Set<() => void>();
const NONE: PendingTurn = {};

function emit(): void {
  for (const listener of listeners) listener();
}

export function publishPendingTurn(sessionKey: string, turn: PendingTurn | undefined): void {
  const empty = !turn || (!turn.optimisticFollowUp && !turn.livePendingConversationMessages?.length);
  if (empty) {
    if (turns.delete(sessionKey)) emit();
    return;
  }
  turns.set(sessionKey, turn);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingTurn(sessionKey: string | undefined): PendingTurn {
  return useSyncExternalStore(subscribe, () => (sessionKey ? turns.get(sessionKey) : undefined) ?? NONE);
}
