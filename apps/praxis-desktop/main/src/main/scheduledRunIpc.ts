import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import {
  armScheduledRun,
  composeScheduledRun,
  holdScheduledRun,
  resolveMissedScheduledRun,
  type MissedResolution,
  type SaveScheduledRunInput,
  type ScheduledRunReadiness,
  type ScheduledRun,
  type ScheduledRunView
} from '@praxis/core';
import { buildScheduledRunView, getScheduledRunStore, notifyScheduledRunsChanged } from './scheduledRunInstance';

/**
 * Scheduled ticket runs IPC (FX-BF-047 / FX-BE-147).
 *
 * Every mutation is a pure core function applied to the stored run and saved,
 * so the rules (what is editable, what arming needs, what a missed run can do)
 * live in one tested place. Nothing here starts a run: the runner is FX-BE-148,
 * which is why saving a schedule only ever changes its definition.
 */

function requireRun(id: string): ScheduledRun {
  const run = getScheduledRunStore().get(id);
  if (!run) throw new Error('That scheduled run no longer exists.');
  return run;
}

export function registerScheduledRunIpc(): void {
  ipcMain.handle('scheduledRuns:list', async (): Promise<ScheduledRunView[]> => {
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
    const { id: _id, ...form } = input;
    const run = composeScheduledRun(existing, { ...form, at: new Date().toISOString() });
    await store.save(run);
    notifyScheduledRunsChanged(run.projectId);
    return buildScheduledRunView(run);
  });

  ipcMain.handle(
    'scheduledRuns:preview',
    async (_event, input: SaveScheduledRunInput): Promise<{ readiness?: ScheduledRunReadiness; error?: string }> => {
      try {
        const existing = input.id ? getScheduledRunStore().get(input.id) : undefined;
        const { id: _id, ...form } = input;
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
    return buildScheduledRunView(run);
  });
}

/** Marks armed schedules whose time passed while Praxis was closed as missed. Call once at launch. */
export async function reconcileScheduledRunsOnLaunch(): Promise<void> {
  const changedRuns = await getScheduledRunStore().reconcileOnLaunch(new Date().toISOString());
  for (const run of changedRuns) notifyScheduledRunsChanged(run.projectId);
}
