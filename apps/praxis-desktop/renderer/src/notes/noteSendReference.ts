import type { AgentSessionRecord, NoteRequestSnapshot } from '@praxis/core';
import type { SessionContextReference } from '../ai/sessionContext';

/** Copies a captured snapshot into a context reference; later edits to the notes can't change it. */
export function snapshotToReference(snapshot: NoteRequestSnapshot): SessionContextReference {
  const content = snapshot.notes.map((note, index) => `${index + 1}. ${note.title}\n\n${note.body}`).join('\n\n---\n\n');
  if (snapshot.source.kind === 'note') {
    return { id: `note:${snapshot.source.id}@${snapshot.capturedAt}`, kind: 'note', label: `Note: ${snapshot.source.title}`, content, capturedAt: snapshot.capturedAt };
  }
  const count = snapshot.notes.length;
  return {
    id: `note-group:${snapshot.source.id}@${snapshot.capturedAt}`, kind: 'note-group',
    label: `Group: ${snapshot.source.title} (${count} ${count === 1 ? 'note' : 'notes'})`, content, capturedAt: snapshot.capturedAt
  };
}

/** Both session paths reject an empty message, so an empty instruction falls back to this. */
export function defaultNoteInstruction(snapshot: NoteRequestSnapshot): string {
  return snapshot.notes.length === 1 ? 'Use the attached note as context.' : 'Use the attached notes as context.';
}

const recency = (session: AgentSessionRecord): string => session.lastActivityAt ?? session.startedAt;

/**
 * Sessions a note can be handed to: the project's own, live, top-level sessions.
 * Subagents, workflow stages/controllers and ticket reviews are reached through their
 * run or ticket, so they are never offered. Most recently updated first.
 */
export function compatibleNoteSessions(sessions: readonly AgentSessionRecord[], projectId: string): AgentSessionRecord[] {
  return sessions
    .filter(session => session.projectId === projectId
      && !session.archived
      && !session.parentSessionKey
      && !session.workflowRunId
      && !session.workflowNodeId
      && session.workflowRole !== 'controller'
      && !session.issueKey.startsWith('review~'))
    .sort((a, b) => recency(b).localeCompare(recency(a)));
}
