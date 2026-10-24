import {
  armScheduledRun, composeScheduledRun, holdScheduledRun, resolveMissedScheduledRun,
  type MobileScheduleInput, type MobileScheduledRun, type ScheduledRun, type ScheduledTicketRef,
} from '@praxis/core';
import type { MobileHostServiceDeps } from './mobileHostServices';

export interface MobileScheduleStore {
  list(): ScheduledRun[];
  get(id: string): ScheduledRun | undefined;
  save(run: ScheduledRun): Promise<unknown>;
}

export function mobileScheduledRun(run: ScheduledRun): MobileScheduledRun {
  if (!run.projectId) throw new Error('A mobile schedule requires a project.');
  return {
    id: run.id, projectId: run.projectId, name: run.name, status: run.status,
    scheduledStartAt: run.scheduledStartAt, timezone: run.timezone,
    entries: run.entries.map(entry => ({
      id: entry.id, sequence: entry.sequence, issueKey: entry.ticket.issueKey, title: entry.ticket.title,
      status: entry.outcome?.status ?? 'queued',
      ...(entry.outcome?.workflowRunId ? { workflowRunId: entry.outcome.workflowRunId } : {}),
      ...(entry.outcome?.reason ? { reason: entry.outcome.reason } : {}),
    })),
  };
}

/** Shares core's editor rules and persistent store; phones never supply backing connection ids. */
export function createMobileSchedules(deps: {
  store(): MobileScheduleStore;
  tickets(projectId: string): Promise<ScheduledTicketRef[]>;
  changed(projectId: string): void;
  defaultWorkflow?(projectId: string): Promise<string | undefined>;
  startNow?(): Promise<void>;
  now?(): string;
}): NonNullable<MobileHostServiceDeps['schedules']> {
  const now = () => deps.now?.() ?? new Date().toISOString();
  const requireRun = (projectId: string, id: string) => {
    const run = deps.store().get(id);
    if (!run || run.projectId !== projectId) throw new Error('That scheduled run was not found in this project.');
    return run;
  };
  const save = async (run: ScheduledRun) => {
    await deps.store().save(run);
    deps.changed(run.projectId!);
    return mobileScheduledRun(run);
  };
  return {
    list: async projectId => deps.store().list().filter(run => run.projectId === projectId).map(mobileScheduledRun),
    save: async (projectId: string, input: MobileScheduleInput) => {
      const available = await deps.tickets(projectId);
      const tickets = input.issueKeys.map(key => {
        const matches = available.filter(ticket => ticket.issueKey === key);
        if (matches.length !== 1) throw new Error(`Ticket ${key} is unavailable or ambiguous in this project.`);
        return matches[0];
      });
      const workflowId = await deps.defaultWorkflow?.(projectId);
      return save(composeScheduledRun(undefined, { ...input, projectId, tickets, workflowId, arm: false, at: now() }));
    },
    setArmed: async (projectId, id, armed) => save(armed ? armScheduledRun(requireRun(projectId, id), now()) : holdScheduledRun(requireRun(projectId, id), now())),
    resolveMissed: async (projectId, id, resolution) => {
      const saved = await save(resolveMissedScheduledRun(requireRun(projectId, id), resolution, now()));
      if (resolution === 'start-now') await deps.startNow?.();
      return saved;
    },
  };
}
