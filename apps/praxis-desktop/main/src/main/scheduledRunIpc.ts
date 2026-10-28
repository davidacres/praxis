import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import {
  armScheduledRun,
  composeScheduledRun,
  holdScheduledRun,
  instantToZonedParts,
  resolveMissedScheduledRun,
  type MissedResolution,
  type SaveScheduledRunInput,
  type ScheduledRunReadiness,
  type ScheduledRun,
  type ScheduledRunView
} from '@praxis/core';
import { buildScheduledRunView, getScheduledRunStore, notifyScheduledRunsChanged } from './scheduledRunInstance';
import { getScheduledRunRunner } from './scheduledRunRunnerInstance';
import { checkScheduledRunRequests } from './scheduledRunRequestWatcher';
import { listWorkflowChoices } from './workflowIpc';
import { defaultScheduleWorkflow } from './scheduledWorkflow';

/**
 * Scheduled ticket runs IPC (FX-BF-047 / FX-BE-147).
 *
 * Every mutation is a pure core function applied to the stored run and saved,
 * so the rules (what is editable, what arming needs, what a missed run can do)
 * live in one tested place. Saving normally changes only the definition; Run now
 * explicitly hands it to the runner (`scheduledRunRunnerInstance.ts`, FX-BE-148)
 * immediately instead of waiting for its time. The pause/resume/skip/retry/cancel/approve handlers hand the
 * user's decision to that runner, which applies it in order with its other work.
 */

function requireRun(id: string): ScheduledRun {
  const run = getScheduledRunStore().get(id);
  if (!run) throw new Error('That scheduled run no longer exists.');
  return run;
}

async function withDefaultWorkflow(input: SaveScheduledRunInput, existing: ScheduledRun | undefined): Promise<SaveScheduledRunInput> {
  if (input.workflowId) return input;
  const kept = existing?.policy.workflowId;
  if (kept) return { ...input, workflowId: kept };
  const projectId = input.projectId ?? existing?.projectId;
  if (!projectId) return input;
  const workflowId = defaultScheduleWorkflow(await listWorkflowChoices(projectId));
  return workflowId ? { ...input, workflowId } : input;
}

export function registerScheduledRunIpc(): void {
  const decide = (apply: (id: string) => Promise<ScheduledRun>) => async (_event: unknown, id: string): Promise<ScheduledRunView> => {
    const run = await apply(id);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  };
  ipcMain.handle('scheduledRuns:workflowChoices', async (_event, projectId: string) => {
    const choices = await listWorkflowChoices(projectId);
    return { choices, defaultWorkflowId: defaultScheduleWorkflow(choices) };
  });
  ipcMain.handle('scheduledRuns:pause', decide(id => getScheduledRunRunner().pause(id)));
  ipcMain.handle('scheduledRuns:startNow', decide(id => getScheduledRunRunner().startNow(id)));
  ipcMain.handle('scheduledRuns:resume', decide(id => getScheduledRunRunner().resume(id)));
  ipcMain.handle('scheduledRuns:cancel', decide(id => getScheduledRunRunner().cancel(id)));
  ipcMain.handle('scheduledRuns:skipEntry', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().skipEntry(id, entryId);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  });
  ipcMain.handle('scheduledRuns:retryEntry', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().retryEntry(id, entryId);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  });
  ipcMain.handle('scheduledRuns:approveGate', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().approveGate(id, entryId);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  });

  ipcMain.handle('scheduledRuns:list', async (): Promise<ScheduledRunView[]> => {
    // Pick up any request file an agent has just written, so the list is current.
    await checkScheduledRunRequests();
    const runs = getScheduledRunStore().list();
    return Promise.all(runs.map(run => buildScheduledRunView(run, runs)));
  });

  ipcMain.handle('scheduledRuns:get', async (_event, id: string): Promise<ScheduledRunView | undefined> => {
    const run = getScheduledRunStore().get(id);
    return run ? buildScheduledRunView(run) : undefined;
  });

  ipcMain.handle('scheduledRuns:save', async (_event, input: SaveScheduledRunInput): Promise<ScheduledRunView> => {
    const store = getScheduledRunStore();
    const existing = input.id ? requireRun(input.id) : undefined;
    const { id: _id, startNow, ...form } = await withDefaultWorkflow(input, existing);
    const at = new Date().toISOString();
    // An immediate start does not require a future date or a valid scheduled wall time.
    const start = startNow ? instantToZonedParts(at, form.timezone) : undefined;
    if (startNow && !start) throw new Error('Choose a valid timezone before starting this run.');
    const run = composeScheduledRun(existing, { ...form, ...(start ? { ...start, arm: false } : {}), at });
    await store.save(run);
    notifyScheduledRunsChanged(run.projectId);
    if (startNow) return buildScheduledRunView(await getScheduledRunRunner().startNow(run.id));
    return buildScheduledRunView(run);
  });

  ipcMain.handle(
    'scheduledRuns:preview',
    async (_event, input: SaveScheduledRunInput): Promise<{ readiness?: ScheduledRunReadiness; error?: string }> => {
      try {
        const existing = input.id ? getScheduledRunStore().get(input.id) : undefined;
        const { id: _id, ...form } = await withDefaultWorkflow(input, existing);
        const run = composeScheduledRun(existing, { ...form, at: new Date().toISOString() });
        return { readiness: (await buildScheduledRunView(run)).readiness };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle('scheduledRuns:remove', async (_event, id: string): Promise<void> => {
    const run = getScheduledRunStore().get(id);
    await getScheduledRunStore().remove(id);
    notifyScheduledRunsChanged(run?.projectId);
  });

  ipcMain.handle('scheduledRuns:setArmed', async (_event, id: string, armed: boolean): Promise<ScheduledRunView> => {
    const at = new Date().toISOString();
    const run = armed ? armScheduledRun(requireRun(id), at) : holdScheduledRun(requireRun(id), at);
    await getScheduledRunStore().save(run);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  });

  ipcMain.handle('scheduledRuns:resolveMissed', async (_event, id: string, resolution: MissedResolution): Promise<ScheduledRunView> => {
    const run = resolveMissedScheduledRun(requireRun(id), resolution, new Date().toISOString());
    await getScheduledRunStore().save(run);
    notifyScheduledRunsChanged(run.projectId);
    // "Start now" means now: do not wait for the next tick.
    if (resolution === 'start-now') void getScheduledRunRunner().tick().catch(error => console.error('Scheduled run start failed:', error));
    return buildScheduledRunView(run);
  });
}

/** Marks armed schedules whose time passed while Praxis was closed as missed. Call once at launch. */
export async function reconcileScheduledRunsOnLaunch(): Promise<void> {
  const changedRuns = await getScheduledRunStore().reconcileOnLaunch(new Date().toISOString());
  for (const run of changedRuns) notifyScheduledRunsChanged(run.projectId);
}
