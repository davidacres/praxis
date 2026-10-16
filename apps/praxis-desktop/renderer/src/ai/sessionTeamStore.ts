import { useSyncExternalStore } from 'react';
import type { AgentSessionRecord, AssistantMessage, AssistantRole } from '@praxis/core';
import { sessionTitle } from './sessionNav';

/**
 * Virtual Team members added to a session, plus their replies. Held outside any
 * one component so every composer for a session (console, Agent Details, AI
 * Review) shows the same roster and every transcript can render the replies.
 * In memory only: nothing is persisted and the session's own agent never sees it.
 */
export interface SessionTeamState {
  members: readonly AssistantRole[];
  messages: readonly AssistantMessage[];
  busy: boolean;
}

const EMPTY: SessionTeamState = { members: [], messages: [], busy: false };
const states = new Map<string, SessionTeamState>();
const listeners = new Set<() => void>();

function update(key: string, change: (current: SessionTeamState) => SessionTeamState) {
  states.set(key, change(states.get(key) ?? EMPTY));
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionTeam(issueKey: string | undefined): SessionTeamState {
  return useSyncExternalStore(subscribe, () => (issueKey ? states.get(issueKey) : undefined) ?? EMPTY);
}

export function toggleSessionTeamMember(issueKey: string, role: AssistantRole): { adding: boolean; next: readonly AssistantRole[] } {
  const current = (states.get(issueKey) ?? EMPTY).members;
  const adding = !current.includes(role);
  const next = adding ? [...current, role] : current.filter(member => member !== role);
  update(issueKey, state => ({ ...state, members: next }));
  return { adding, next };
}

/** The first @mention of a member on this session's team, if the text carries one. */
export function mentionedSessionTeamMember(issueKey: string, text: string): AssistantRole | undefined {
  const match = /(?:^|\s)@(lead|dev|qa|security|product)\b/i.exec(text)?.[1]?.toLowerCase() as AssistantRole | undefined;
  return match && (states.get(issueKey) ?? EMPTY).members.includes(match) ? match : undefined;
}

/**
 * Asks one team member about a session. The member answers separately,
 * read-only and without tools; session details ride in `context` because the
 * message itself is capped at 4,000 characters. Rejects with the engine's error.
 */
export async function askSessionTeamMember(session: AgentSessionRecord, role: AssistantRole, request: string): Promise<void> {
  const key = session.issueKey;
  if (states.get(key)?.busy) return;
  const goal = session.taskDefinition?.goal?.trim();
  const latest = (session.responseText ?? '').trim();
  const context = {
    pageType: 'general' as const,
    title: `Session ${sessionTitle(session)}`,
    summary: `You have been added to the session "${sessionTitle(session)}". Use the session details below when answering.`,
    data: [
      goal ? `Session goal:\n${goal.slice(0, 2000)}` : '',
      latest ? `Latest reply from the session's agent:\n${latest.slice(-6000)}` : ''
    ].filter(Boolean).join('\n\n')
  };
  const user: AssistantMessage = { id: crypto.randomUUID(), role: 'user', text: request, createdAt: new Date().toISOString() };
  update(key, state => ({ ...state, busy: true, messages: [...state.messages, user] }));
  try {
    const result = await window.praxis.assistant.turn({
      message: request,
      personaId: role,
      context,
      history: [],
      provider: session.provider,
      model: session.model,
      permissionMode: session.permissionMode
    } as Parameters<typeof window.praxis.assistant.turn>[0]);
    update(key, state => ({ ...state, messages: [...state.messages, ...result.messages] }));
  } finally {
    update(key, state => ({ ...state, busy: false }));
  }
}
