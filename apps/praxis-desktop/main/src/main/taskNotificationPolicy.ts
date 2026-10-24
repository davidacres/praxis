import { backgroundTaskIsUnsettled, scheduleWorkflowRun, pauseReasonOf } from '@praxis/core';
import type { AgentSessionRecord, TaskNotificationSettings, TaskNotificationTarget, WorkflowRun } from '@praxis/core';

export interface TaskNotice {
  category: 'completed' | 'failed' | 'needsAttention';
  title: string;
  body: string;
  target: TaskNotificationTarget;
}

/** Stores small immutable signatures, never mutable session/run records or transcripts. */
export class TaskNotificationPolicy {
  private readonly sessions = new Map<string, string>();
  private readonly backgroundTasks = new Map<string, string>();
  private readonly runs = new Map<string, string>();

  session(record: AgentSessionRecord, seed = false): TaskNotice | undefined {
    const signature = `${record.sessionId}:${record.state}:${record.conversation?.state ?? ''}`;
    const previous = this.sessions.get(record.issueKey);
    this.sessions.set(record.issueKey, signature);
    if (seed || previous === signature || record.interruptedByRestart) return;
    const terminal = record.state === 'completed' || record.state === 'failed';
    // Stage completion belongs to the run. Permission/input requests still need an alert.
    if (terminal && (previous === undefined || record.workflowNodeId || record.parentSessionKey || record.conversation?.state === 'running')) return;
    const category = record.state === 'completed' ? 'completed'
      : record.state === 'failed' ? 'failed'
      : record.state === 'awaiting_approval' || record.state === 'awaiting_input' || record.state === 'paused' ? 'needsAttention' : undefined;
    if (!category) return;
    if (category === 'completed' && record.backgroundTasks?.some(backgroundTaskIsUnsettled)) return;
    return {
      category,
      title: category === 'completed' ? 'AI task completed' : category === 'failed' ? 'AI task failed' : 'AI task needs your attention',
      body: (record.title || record.taskDefinition.goal || record.issueKey).slice(0, 180),
      target: { sessionKey: record.issueKey, projectId: record.projectId, conversation: !record.projectId && !record.workflowRunId && !record.workflowNodeId && !record.issueKey.startsWith('review~') }
    };
  }

  background(record: AgentSessionRecord, seed = false): TaskNotice[] {
    const notices: TaskNotice[] = [];
    for (const task of record.backgroundTasks ?? []) {
      const key = `${record.sessionId}:${task.id}`;
      const previous = this.backgroundTasks.get(key);
      this.backgroundTasks.set(key, task.state);
      if (seed || previous === task.state || task.state === 'running' || task.state === 'stopped') continue;
      const category = task.state === 'failed' ? 'failed' : task.state === 'unknown' || task.state === 'paused' ? 'needsAttention' : 'completed';
      notices.push({
        category,
        title: task.state === 'exited' ? 'Background process exited' : task.state === 'unknown' ? 'Background task status unknown' : task.state === 'paused' ? 'Background task paused' : task.state === 'failed' ? 'Background task failed' : 'Background task completed',
        body: task.label.slice(0, 180),
        target: { sessionKey: record.issueKey, projectId: record.projectId, conversation: !record.projectId && !record.workflowRunId && !record.issueKey.startsWith('review~') }
      });
    }
    return notices;
  }

  run(run: WorkflowRun, seed = false): TaskNotice | undefined {
    const attention = [...scheduleWorkflowRun(run).awaitingApproval, ...Object.entries(run.nodes).filter(([, node]) => pauseReasonOf(node)).map(([id]) => id)].sort().join(',');
    const phase = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' ? run.status : attention ? `attention:${attention}` : run.status === 'awaiting-approval' ? 'attention' : 'running';
    const signature = `${run.startedAt}:${phase}`;
    const previous = this.runs.get(run.runId);
    this.runs.set(run.runId, signature);
    if (seed || previous === signature) return;
    const terminal = run.status === 'succeeded' || run.status === 'failed';
    if (terminal && previous === undefined) return;
    const category = run.status === 'succeeded' ? 'completed' : run.status === 'failed' ? 'failed'
      : run.status === 'awaiting-approval' || attention ? 'needsAttention' : undefined;
    if (!category) return;
    return {
      category,
      title: category === 'completed' ? 'Workflow completed' : category === 'failed' ? 'Workflow failed' : 'Workflow needs your attention',
      body: (run.displayName || run.definition.name).slice(0, 180),
      target: { runId: run.runId, workflowId: run.workflowId, projectId: run.projectId }
    };
  }
}

export function shouldNotify(notice: TaskNotice, settings: TaskNotificationSettings, views: readonly TaskNotificationTarget[]): boolean {
  if (!settings[notice.category]) return false;
  return !settings.suppressWhenViewing || !views.some(view =>
    notice.target.runId ? view.runId === notice.target.runId : view.sessionKey === notice.target.sessionKey);
}
