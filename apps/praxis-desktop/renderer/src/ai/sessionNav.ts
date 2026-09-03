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
