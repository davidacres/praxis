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
      else {
        // Some ACP adapters report a tool as already completed on its first
        // notification. There is no preceding `tool_start` in that case, but
        // the completed call still belongs to the turn and may be code intel.
        const name = event.data?.toolName ?? event.summary?.replace(/^Tool(?: failed| completed)?:\s*/i, '') ?? 'tool';
        calls.push({
          name,
          callId: event.data?.callId,
          detail: event.data?.argsSummary,
          ok: event.data?.ok !== false
        });
      }
    } else if (event.type === 'message') {
      // Snapshot: the row objects are shared, so a later completion still
      // updates the card, but the list itself only ever grows.
      lastMessage = { calls: [...calls], followedByTools: false };
      byMessage.set(event, lastMessage);
    }
  }

  return byMessage;
}

// Tools served by the local code intelligence index (see core's mcpBridge).
const CODE_INTELLIGENCE_TOOLS = [
  'search_code', 'find_symbol', 'get_symbol', 'get_source', 'explain_symbol',
  'get_callers', 'get_callees', 'trace_flow', 'find_related', 'summarize_project',
  'get_index_status', 'search_knowledge', 'get_knowledge_section', 'find_related_knowledge',
  'list_repositories'
].join('|');

// Hosts name an MCP call differently: `mcp__code_intelligence__search_code`
// (Claude Code, gateway), `code_intelligence.search_code` / `Tool: …/…`, or the
// bare tool with the server in brackets. A bare name only counts on its own,
// so another server's `mcp__github__search_code` does not.
const CODE_INTELLIGENCE_CALL = new RegExp(
  `^(?:tool:\\s*)?(?:mcp(?:__|[./:]))?code[_-]intelligence(?:__|[./:])(?:${CODE_INTELLIGENCE_TOOLS})\\b|^(?:${CODE_INTELLIGENCE_TOOLS})(?:\\s*\\(code[_-]intelligence\\b.*\\))?$`,
  'i'
);

export function isCodeIntelligenceTool(name: string): boolean {
  return CODE_INTELLIGENCE_CALL.test(name.trim());
}

/** The turn's code intelligence calls, for the chat's badge. */
export function codeIntelligenceCalls(calls: readonly ToolCallRow[]): ToolCallRow[] {
  return calls.filter(call => isCodeIntelligenceTool(call.name));
}

/** `mcp__code_intelligence__find_symbol` → `find_symbol`. */
export function codeIntelligenceToolLabel(name: string): string {
  return name.trim().match(new RegExp(`(${CODE_INTELLIGENCE_TOOLS})`, 'i'))?.[1].toLowerCase() ?? name;
}
