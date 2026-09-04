import type { AgentSessionRecord } from '@praxis/core';

/**
 * Naming and classification for an agent session, shared by the three surfaces
 * that show one: the sidebar tree, the console, and the right-pane inspector.
 *
 * These were private to `SessionsPage` while it owned its own list column. The
 * list now lives in the shell's sidebar, so they are shared rather than
 * duplicated.
 */

export function sessionTitle(session: AgentSessionRecord): string {
  return session.title?.trim() || session.taskDefinition.goal.split('\n')[0];
}

/**
 * A free-form session (New Session composer, no tracker issue) is stored under a
 * synthesized `SESSION-<hex>` key — a unique internal handle, not something the
 * user chose. The UI shows the session's title instead; only a real tracker
 * issue keeps its key (e.g. `PROJ-123`) on screen.
 */
export function isSynthesizedKey(issueKey: string): boolean {
  return /^SESSION-[0-9a-f]{6,}$/i.test(issueKey);
}

/**
 * A governed workflow stage (FX-BF-013) is stored under a synthesized
 * `WF-<run>-<node>` key too, but unlike a composer session it belongs to a run
 * the user can navigate to — so it is labelled by its stage and badged as a
 * workflow session rather than showing a key nobody chose.
 */
export function isWorkflowStageSession(session: AgentSessionRecord): boolean {
  return !!session.workflowRunId && !!session.workflowNodeId;
}

/** What to show as the session's name: the title alone for free-form sessions,
 *  `KEY — title` for tracker-issue sessions. */
export function sessionLabel(session: AgentSessionRecord): string {
  const title = sessionTitle(session);
  if (isWorkflowStageSession(session)) return title;
  return isSynthesizedKey(session.issueKey) ? title : `${session.issueKey} — ${title}`;
}

export function sessionMode(session: AgentSessionRecord): 'Chat' | 'Analysis' | 'Review' | 'Workflow' {
  if (isWorkflowStageSession(session)) return 'Workflow';
  if (session.mode === 'analysis' || session.taskDefinition.kind === 'analysis') return 'Analysis';
  if (session.mode === 'review' || session.taskDefinition.kind === 'review') return 'Review';
  return 'Chat';
}

/** Last path segment, for a compact working-directory label. */
export function basename(fsPath: string): string {
  const parts = fsPath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? fsPath;
}

export function formatStarted(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}

export function toolModeLabel(toolMode: AgentSessionRecord['toolMode']): string {
  return toolMode === 'project-only' ? 'Project only' : toolMode === 'read-only' ? 'Read only' : 'Full tools';
}

/**
 * How long a session's work took — wall clock from start to finish, or so far
 * while it is still running.
 *
 * Deliberately not a cost or token figure: ACP carries no usage data, and a
 * CLI agent bills on its own account, so there is nothing real to report.
 * Duration and step count are what this app actually observes.
 */
export function formatElapsed(startedAt: string, completedAt?: string): string | undefined {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A session's token total, compactly. Returns undefined when the provider
 * reported nothing — CLI-hosted agents run on their own account and report no
 * usage over ACP, and an invented 0 would read as "this was free".
 */
export function formatTokens(usage: AgentSessionRecord['tokenUsage']): string | undefined {
  const total = usage?.totalTokens;
  if (typeof total !== 'number' || total <= 0) {
    return undefined;
  }
  if (total < 1000) return `${total} tokens`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tokens`;
  return `${(total / 1_000_000).toFixed(1)}M tokens`;
}

export interface ContextPressure {
  /** 0–1 share of the model's window the current prompt occupies. */
  fraction: number;
  percent: number;
  used: number;
  limit: number;
  /** `warn` past two-thirds, `critical` past 85% — where turns start failing. */
  level: 'ok' | 'warn' | 'critical';
}

/**
 * How full the model's context is for the *next* turn.
 *
 * Uses `contextTokens` (the latest turn's prompt) rather than cumulative usage:
 * a session can spend a million tokens over fifty small turns without ever
 * filling its window, so a running total would cry wolf constantly.
 *
 * Returns undefined when either number is unknown — a CLI-hosted agent reports
 * no usage, and not every gateway publishes a context length. A guessed
 * percentage would be worse than none.
 */
export function contextPressure(session: AgentSessionRecord): ContextPressure | undefined {
  const used = session.contextTokens;
  const limit = session.contextLimit;
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0 || used <= 0) {
    return undefined;
  }
  const fraction = Math.min(used / limit, 1);
  return {
    fraction,
    percent: Math.round(fraction * 100),
    used,
    limit,
    level: fraction >= 0.85 ? 'critical' : fraction >= 0.67 ? 'warn' : 'ok'
  };
}
