import type { AgentToolEventData } from './agentTypes';

export type ToolEventKind = NonNullable<AgentToolEventData['kind']>;

/** Buckets a local/tracker tool name into the coarse kind the session console renders by. */
export function classifyLocalTool(name: string): ToolEventKind {
  switch (name) {
    case 'write_file':
      return 'write';
    case 'run_shell':
      return 'shell';
    case 'read_file':
      return 'read';
    case 'list_dir':
      return 'list';
    default:
      return name.startsWith('tracker_') ? 'tracker' : 'other';
  }
}

/** Maps an ACP `tool_call.kind` to the same coarse kind. */
export function mapAcpToolKind(kind: string | undefined): ToolEventKind {
  switch (kind) {
    case 'edit':
    case 'delete':
    case 'move':
      return 'write';
    case 'execute':
      return 'shell';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    default:
      return 'other';
  }
}

/** One-line digest of a tool's arguments for the `tool_start` summary row. */
export function summariseToolArgs(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '';
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  if (name === 'write_file' || name === 'read_file' || name === 'list_dir') {
    return str('path');
  }
  if (name === 'run_shell') {
    return truncate(str('command'), 80);
  }
  if (name.startsWith('tracker_')) {
    return str('issueKey');
  }
  const firstString = Object.values(args).find(value => typeof value === 'string') as string | undefined;
  return firstString ? truncate(firstString, 80) : '';
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
