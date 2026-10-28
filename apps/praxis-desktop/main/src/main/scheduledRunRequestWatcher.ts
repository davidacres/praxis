import type { IssueSummary } from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getScheduledRunStore, notifyScheduledRunsChanged } from './scheduledRunInstance';
import { importScheduledRunRequests } from './scheduledRunRequests';
import { defaultScheduleWorkflow } from './scheduledWorkflow';
import { getServiceForConnection } from './serviceRegistry';
import { listWorkflowChoices } from './workflowIpc';

/** How often project request folders are checked; unchanged files are skipped by hash. */
const POLL_MS = 5_000;

let timer: NodeJS.Timeout | undefined;
let pending: Promise<unknown> = Promise.resolve();

async function projectIssues(projectId: string): Promise<IssueSummary[]> {
  const service = await getServiceForConnection(`project:${projectId}`);
  const issues: IssueSummary[] = [];
  for (let offset = 0; ; ) {
    const page = await service.getIssues({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, offset, 200);
    issues.push(...page.issues);
    if (!page.hasMore || page.issues.length === 0) break;
    offset += page.issues.length;
  }
  return issues;
}

/** Imports new or changed request files. Calls are serialized so two checks never race on one file. */
export function checkScheduledRunRequests(): Promise<void> {
  const next = pending.then(() => importScheduledRunRequests({
    projects: () => getProjectStore().list(),
    issues: projectIssues,
    workflowChoices: listWorkflowChoices,
    defaultWorkflow: defaultScheduleWorkflow,
    store: getScheduledRunStore,
    changed: notifyScheduledRunsChanged,
    now: () => new Date().toISOString()
  }));
  pending = next.catch(() => undefined);
  return next.then(() => undefined, error => console.error('Scheduled-run request import failed:', error));
}

export function startScheduledRunRequestImports(): void {
  if (timer) return;
  void checkScheduledRunRequests();
  timer = setInterval(() => void checkScheduledRunRequests(), POLL_MS);
  timer.unref();
}

export function stopScheduledRunRequestImports(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
