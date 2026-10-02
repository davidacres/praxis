import type { AgentEventSummary } from '@praxis/core';

/**
 * Per-turn tool activity for the chat.
 *
 * `tool_start` / `tool_complete` events stay out of the transcript, but the
 * thought block lists what the turn actually did, and its caption counts calls
 * rather than distinct tool names (four `read_file` calls are four calls). So
 * walk the full event list once and attach, to every assistant message, the
 * calls made in its turn up to that point.
 */

export interface ToolCallRow {
  name: string;
  callId?: string;
  /** Short human summary of the arguments, e.g. the file path. */
  detail?: string;
  /** Undefined while the call is still running. */
  ok?: boolean;
}

export interface TurnTools {
  calls: ToolCallRow[];
  /**
   * Whether the agent went on to call a tool after this message. A message
   * followed by tool calls is a mid-turn aside, not the answer.
   */
  followedByTools: boolean;
}

export function collectTurnTools(
  events: readonly AgentEventSummary[]
): Map<AgentEventSummary, TurnTools> {
  const byMessage = new Map<AgentEventSummary, TurnTools>();
  let calls: ToolCallRow[] = [];
  let lastMessage: TurnTools | undefined;

  for (const event of events) {
    if (event.type === 'user_input_completed') {
      calls = [];
      lastMessage = undefined;
    } else if (event.type === 'tool_start') {
      if (lastMessage) lastMessage.followedByTools = true;
      calls.push({
        name: event.data?.toolName ?? event.summary?.replace(/^Running tool:\s*/, '') ?? 'tool',
        callId: event.data?.callId,
        detail: event.data?.argsSummary
      });
    } else if (event.type === 'tool_complete') {
      // Match by call id when the host supplies one, otherwise settle the
      // oldest open call of that name (completions arrive in start order).
      const name = event.data?.toolName;
      const open = calls.find(call =>
        call.ok === undefined &&
        (event.data?.callId ? call.callId === event.data.callId : call.name === name)
      );
      if (open) open.ok = event.data?.ok !== false;
    } else if (event.type === 'message') {
      // Snapshot: the row objects are shared, so a later completion still
      // updates the card, but the list itself only ever grows.
      lastMessage = { calls: [...calls], followedByTools: false };
      byMessage.set(event, lastMessage);
    }
  }

  return byMessage;
}
