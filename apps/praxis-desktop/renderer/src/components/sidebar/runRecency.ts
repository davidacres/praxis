import type { WorkflowRunSummary } from '@praxis/core';

export const RUN_BUCKETS = ['active', 'today', 'yesterday', 'this-week', 'last-week', 'older'] as const;
type RunBucket = typeof RUN_BUCKETS[number];
export const RUN_BUCKET_LABEL: Record<RunBucket, string> = {
  active: 'Active', today: 'Today', yesterday: 'Yesterday', 'this-week': 'This week', 'last-week': 'Last week', older: 'Older'
};

export function runHistoryBucket(run: WorkflowRunSummary, now: Date): RunBucket {
  if (run.status === 'running' || run.status === 'awaiting-approval' || run.paused) return 'active';
  const time = new Date(run.endedAt ?? run.startedAt).getTime();
  const day = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  if (time >= day(0)) return 'today';
  if (time >= day(1)) return 'yesterday';
  if (time >= day(6)) return 'this-week';
  if (time >= day(13)) return 'last-week';
  return 'older';
}
