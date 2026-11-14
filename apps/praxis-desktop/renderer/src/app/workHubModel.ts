import type { AgentSessionRecord, ScheduledRunView, WorkflowRunSummary } from '@praxis/core';

export interface AttentionItem {
  id: string;
  projectId?: string;
  title: string;
  reason: string;
  action: string;
  kind: 'session' | 'workflow' | 'schedule';
  target: string;
}

export function attentionItems(sessions: AgentSessionRecord[], runs: WorkflowRunSummary[], schedules: ScheduledRunView[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const action = session.state === 'awaiting_approval' ? 'Review request'
      : session.state === 'awaiting_input' ? 'Answer question'
      : session.interruptedByRestart ? 'Review recovery'
      : session.state === 'paused' ? 'Review pause'
      : session.state === 'failed' ? 'Review failure' : undefined;
    if (!action) continue;
    const requestType = session.state === 'awaiting_approval' ? 'permission_requested' : session.state === 'awaiting_input' ? 'user_input_requested' : 'error';
    const event = [...session.events].reverse().find(event => event.type === requestType);
    items.push({ id: `session:${session.issueKey}`, kind: 'session', target: session.issueKey, projectId: session.projectId,
      title: session.title || session.taskDefinition.goal || session.issueKey,
      reason: event?.detail || event?.summary || session.lastError || action, action });
  }
  for (const run of runs) {
    if (run.archived || !(['failed', 'awaiting-approval'].includes(run.status) || run.paused || run.needsDecision)) continue;
    items.push({ id: `workflow:${run.runId}`, kind: 'workflow', target: run.runId, projectId: run.projectId,
      title: run.workflowName, reason: run.needsDecision?.message || run.explanation,
      action: run.status === 'awaiting-approval' ? 'Review gate' : 'Review run' });
  }
  for (const { run } of schedules) {
    if (run.archived || !['failed', 'paused', 'missed'].includes(run.status)) continue;
    items.push({ id: `schedule:${run.id}`, kind: 'schedule', target: run.id, projectId: run.projectId,
      title: run.name, reason: run.pause?.message || run.events?.at(-1)?.message || `Scheduled run ${run.status}`, action: run.status === 'missed' ? 'Resolve missed start' : 'Review schedule' });
  }
  return items;
}

/** Keep the excerpt anchored on the actual match, even deep inside a transcript. */
export function matchingExcerpt(text: string, query: string, radius = 120): string | undefined {
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (index < 0) return undefined;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.trim().length + radius);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** The host resolves lifecycle state; completed or superseded decisions must never reappear. */
export function pendingDecisionQuestions(blocks: import('@praxis/core').ChatBlock[]): string[] {
  return blocks.flatMap(block => {
    if (block.type !== 'gadget' || (block.gadget.state ?? 'active') !== 'active'
      || !['choice', 'form', 'confirmation'].includes(block.gadget.kind) || !block.gadget.actions.length) return [];
    const payload = block.gadget.payload as { question?: string; title?: string; message?: string };
    return [payload.question || payload.title || payload.message || 'An agent is waiting for your decision.'];
  });
}
