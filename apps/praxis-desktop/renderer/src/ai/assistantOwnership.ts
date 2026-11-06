import type { AgentSessionRecord, TeamChatSummary } from '@praxis/core';
import { isAssistantToolSession } from './sessionNav';

/**
 * One classification of "who owns this session", shared by every surface that lists sessions.
 *
 * A Virtual Team turn runs through a real agent session so its tools, permissions and usage are
 * durable, but the *conversation* lives in the team-chat store and is shown there as one row. If a
 * sidebar lets the runtime record through as well, the same work appears twice — once as a
 * navigable chat whose title is the internal persona prompt, once as the team chat. So both the
 * Classic tree and Easy Mode filter through this module rather than each writing its own rule.
 *
 * Ownership is typed (`session.teamChatExecution`) wherever the record was created after FX-BE-179;
 * the legacy `ASSISTANT-` issue-key prefix inside `isAssistantToolSession` is the narrow fallback
 * for records written before that. TASK-485 migration links the provable ones to their
 * conversation (or records a diagnostic) but never rewrites or deletes them, so the fallback stays.
 */

/** A session the assistant owns: a Virtual Team member's runtime execution, not a user chat. */
export function isAssistantOwnedSession(session: AgentSessionRecord): boolean {
  return isAssistantToolSession(session);
}

/**
 * The sessions a user may navigate to: everything except assistant-owned internal executions.
 * Applied at the single place the session list is loaded and incrementally merged, and again
 * defensively in each sidebar consumer, so a record that arrives late cannot slip a duplicate row
 * into either mode.
 */
export function visibleSessions(sessions: readonly AgentSessionRecord[]): AgentSessionRecord[] {
  return sessions.filter(session => !isAssistantOwnedSession(session));
}

/**
 * One row per team conversation.
 *
 * The sidebar asks `assistant.listChats` once per project id, so a chat whose summary is listed by
 * two feeds (a project id and the empty "general" id) would render twice. Dedupe by conversation
 * id, keeping the first summary seen, which is the feed that asked for it.
 */
export function dedupeTeamChats(chats: readonly TeamChatSummary[]): TeamChatSummary[] {
  const seen = new Set<string>();
  const result: TeamChatSummary[] = [];
  for (const chat of chats) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    result.push(chat);
  }
  return result;
}
