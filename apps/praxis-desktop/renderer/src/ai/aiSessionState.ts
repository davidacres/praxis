import type { AgentEventType, AgentTaskState } from '@praxis/core';
import type { IconName } from '../ui/Icon';

/**
 * Presentation helpers for agent session state, shared by the sidebar count,
 * the Sessions view and the issue detail's AI section.
 */

const TERMINAL_STATES: ReadonlySet<AgentTaskState> = new Set(['completed', 'failed', 'aborted']);

export function isTerminalAgentState(state: AgentTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function agentStateLabel(state: AgentTaskState): string {
  switch (state) {
    case 'not_started':
      return 'Not started';
    case 'planning':
      return 'Planning';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'executing':
      return 'Executing';
    case 'awaiting_input':
      return 'Awaiting input';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Aborted';
  }
}

/** Maps onto the existing badge tone classes (default / progress / done / blocked). */
export function agentStateBadgeClass(state: AgentTaskState): string {
  if (state === 'completed') {
    return 'badge badge-done';
  }
  if (state === 'failed' || state === 'aborted') {
    return 'badge badge-blocked';
  }
  if (state === 'not_started' || state === 'paused') {
    return 'badge';
  }
  return 'badge badge-progress';
}

/**
 * The sidebar tree's compact state mark — a lane dot, the same vocabulary the
 * Agents tree uses for host state. A full text badge does not fit a tree row.
 */
export function agentStateLaneClass(state: AgentTaskState): string {
  if (state === 'failed' || state === 'aborted') {
    return 'lane lane--failed';
  }
  if (isTerminalAgentState(state) || state === 'not_started' || state === 'paused') {
    return 'lane lane--idle';
  }
  return 'lane lane--running';
}

export function agentEventIcon(type: AgentEventType): IconName {
  switch (type) {
    case 'session_start':
      return 'play';
    case 'plan':
      return 'book';
    case 'intent':
      return 'target';
    case 'reasoning':
      return 'lightbulb';
    case 'message':
      return 'chats';
    case 'tool_start':
      return 'tools';
    case 'tool_complete':
      return 'check-square';
    case 'permission_requested':
    case 'permission_completed':
      return 'shield';
    case 'user_input_requested':
    case 'user_input_completed':
      return 'mic';
    case 'error':
      return 'close';
    case 'task_complete':
      return 'check-square';
    case 'aborted':
      return 'close';
    case 'warning':
      return 'info';
    case 'idle':
      return 'dot';
    case 'info':
    default:
      return 'info';
  }
}

/** Tones the event icon by type; class names live in theme.css next to .event-icon. */
export function agentEventToneClass(type: AgentEventType): string {
  if (type === 'error' || type === 'aborted') {
    return `event-icon ${type}`;
  }
  if (type === 'task_complete' || type === 'session_start') {
    return `event-icon ${type}`;
  }
  if (type === 'tool_start' || type === 'tool_complete') {
    return `event-icon ${type}`;
  }
  return 'event-icon';
}
