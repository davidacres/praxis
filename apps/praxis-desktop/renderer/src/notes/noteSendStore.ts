import { useSyncExternalStore } from 'react';
import type { NoteSource } from '@praxis/core';
import type { SessionContextReference } from '../ai/sessionContext';

/** What the Send-to-session dialog is open for. */
export interface NoteSendRequest { projectId: string; source: NoteSource; title: string }

/** A reference staged for a session composer to send (existing session) or hold (new session). */
export interface SessionHandoff {
  reference: SessionContextReference; instruction: string; stagedAt?: number;
  /** The dialog's saved instruction; kept until the destination takes the handoff so a lost destination loses nothing. */
  draft?: { projectId: string; source: NoteSource };
  /** Only add the chip to the composer — never fill in text or send (artifacts added to a chat). */
  attachOnly?: boolean;
}

/** How long after the explicit Send a staged handoff may still submit itself; later it only fills the composer. */
export const HANDOFF_AUTO_SEND_MS = 10_000;

/** Key under which a handoff waits for the New Session composer. */
export const NEW_SESSION_HANDOFF = 'new';

let request: NoteSendRequest | undefined;
const listeners = new Set<() => void>();
const handoffs = new Map<string, SessionHandoff>();
const instructions = new Map<string, string>();

const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const requestNoteSend = (next: NoteSendRequest) => { request = next; emit(); };
export const closeNoteSend = () => { request = undefined; emit(); };
export const useNoteSendRequest = (): NoteSendRequest | undefined => useSyncExternalStore(subscribe, () => request);

const instructionKey = (projectId: string, source: NoteSource) => `${projectId}:${source.kind}:${source.id}`;
/** Instructions typed but not sent survive cancelling and reopening the dialog. */
export const draftInstruction = (projectId: string, source: NoteSource): string => instructions.get(instructionKey(projectId, source)) ?? '';
export const saveDraftInstruction = (projectId: string, source: NoteSource, text: string) => {
  if (text) instructions.set(instructionKey(projectId, source), text);
  else instructions.delete(instructionKey(projectId, source));
};

export const stageSessionHandoff = (key: string, handoff: SessionHandoff) => { handoffs.set(key, { ...handoff, stagedAt: Date.now() }); emit(); };
/** True while the user's Send click is recent enough that submitting on their behalf is not a surprise. */
export const isFreshHandoff = (handoff: SessionHandoff, now = Date.now()): boolean =>
  handoff.stagedAt !== undefined && now - handoff.stagedAt <= HANDOFF_AUTO_SEND_MS;
/** Re-renders when a handoff is staged or consumed, so an already-open session notices it. */
export const useStagedHandoff = (key: string | undefined): SessionHandoff | undefined =>
  useSyncExternalStore(subscribe, () => (key ? handoffs.get(key) : undefined));
export const peekSessionHandoff = (key: string): SessionHandoff | undefined => handoffs.get(key);
/** Consume-once: a second call returns nothing, so a handoff can't be sent twice. */
export function takeSessionHandoff(key: string): SessionHandoff | undefined {
  const handoff = handoffs.get(key);
  handoffs.delete(key);
  if (handoff?.draft) saveDraftInstruction(handoff.draft.projectId, handoff.draft.source, '');
  if (handoff) emit();
  return handoff;
}
