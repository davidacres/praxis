import type { BackgroundTask, BackgroundTaskState } from './agentTypes';

export const backgroundTaskIsLive = (task: Pick<BackgroundTask, 'state'>): boolean => task.state === 'running' || task.state === 'paused';
export const backgroundTaskIsUnsettled = (task: Pick<BackgroundTask, 'state'>): boolean => backgroundTaskIsLive(task) || task.state === 'unknown';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : undefined;
const states = new Set<BackgroundTaskState>(['running', 'paused', 'completed', 'failed', 'stopped']);
export interface ProviderBackgroundUpdate {
  id: string;
  state?: BackgroundTaskState;
  label?: string;
  detail?: string;
  callId?: string;
}

/** AIR asyncTasks extension, negotiated explicitly; no status is inferred from prose. */
export function readProviderBackgroundUpdate(value: unknown): ProviderBackgroundUpdate | undefined {
  const update = object(value);
  const kind = update.sessionUpdate;
  if (kind === 'subagent_spawned' || kind === 'subagent_state_update') {
    const id = string(update.subagentSessionId);
    if (!id || id.length > 256) return;
    const state = kind === 'subagent_spawned' ? 'running' : update.state === 'cancelled' ? 'stopped' : update.state === 'disconnected' ? 'unknown' : update.state === 'completed' || update.state === 'failed' ? update.state : undefined;
    if (!state) return;
    return { id: `child:${id}`, state, label: string(update.name), detail: kind === 'subagent_spawned' ? string(update.task) : state === 'unknown' ? 'The provider disconnected from this subagent before confirming its result.' : undefined };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const native = /^(Start|Complete|Interrupt) subagent (.+)$/i.exec(string(update.title) ?? '') ?? /^(Start|Complete|Interrupt) subagent (.+)$/i.exec(string(update.name) ?? '');
    if (!native) return;
    const action = native[1].toLowerCase();
    const terminal = update.status === 'completed' || update.status === 'failed';
    if (action !== 'start' && !terminal) return;
    return { id: `subagent:${native[2].trim()}`, label: native[2].trim(), state: update.status === 'failed' ? 'failed' : action === 'start' ? 'running' : action === 'interrupt' ? 'stopped' : 'completed', callId: string(update.toolCallId) };
  }
  if (kind !== 'async_task_spawned' && kind !== 'async_task_progress' && kind !== 'async_task_state_update') return;
  const id = string(update.asyncTaskId);
  if (!id || id.length > 256) return;
  const state = kind === 'async_task_spawned' ? 'running' : kind === 'async_task_state_update' && states.has(update.state as BackgroundTaskState) ? update.state as BackgroundTaskState : undefined;
  if (kind === 'async_task_state_update' && !state) return;
  return { id, state, label: string(update.description) ?? string(update.name), detail: string(update.summary), callId: string(update.toolCallId) };
}

/** Explicit structured launch result from older adapters: launching is not finishing. */
export function readUnobservedBackgroundLaunch(value: unknown): ProviderBackgroundUpdate | undefined {
  const update = object(value);
  if (update.sessionUpdate !== 'tool_call_update' && update.sessionUpdate !== 'tool_call') return;
  if (update.status !== 'completed') return;
  const output = object(update.rawOutput);
  const id = string(output.backgroundTaskId);
  if (!id || id.length > 256) return;
  return { id, state: 'unknown', label: string(update.title) ?? 'Provider background task', callId: string(update.toolCallId), detail: 'The provider launched this task but has not reported its live status. Completion is not confirmed.' };
}
