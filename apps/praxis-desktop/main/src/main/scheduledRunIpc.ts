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
  type ScheduledRunView,
  type ScheduledWorkflowChoice
} from '@praxis/core';
import { broadcastToAllWindows } from './windowBroadcast';
import { buildScheduledRunView, getScheduledRunStore } from './scheduledRunInstance';
import { getScheduledRunRunner } from './scheduledRunRunnerInstance';
import { listWorkflowChoices } from './workflowIpc';

/**
 * Scheduled ticket runs IPC (FX-BF-047 / FX-BE-147).
 *
 * Every mutation is a pure core function applied to the stored run and saved,
 * so the rules (what is editable, what arming needs, what a missed run can do)
 * live in one tested place. Nothing here *starts* a schedule: saving only changes
 * its definition, and the runner (`scheduledRunRunnerInstance.ts`, FX-BE-148) starts
 * it at its time. The pause/resume/skip/retry/cancel/approve handlers hand the
 * user's decision to that runner, which applies it in order with its other work.
 */
function changed(): void {
  broadcastToAllWindows('scheduledRuns:changed');
}

function requireRun(id: string): ScheduledRun {
  const run = getScheduledRunStore().get(id);
  if (!run) throw new Error('That scheduled run no longer exists.');
  return run;
}

/** The workflow used when the composer does not choose one: a ticket-owned workflow, else the governed-delivery template. */
export function defaultScheduleWorkflow(choices: readonly ScheduledWorkflowChoice[]): string | undefined {
  return (choices.find(choice => choice.trigger === 'ticket') ?? choices.find(choice => choice.workflowId === 'governed-delivery'))?.workflowId;
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
    changed();
    return buildScheduledRunView(run);
  };
  ipcMain.handle('scheduledRuns:workflowChoices', async (_event, projectId: string) => {
    const choices = await listWorkflowChoices(projectId);
    return { choices, defaultWorkflowId: defaultScheduleWorkflow(choices) };
  });
  ipcMain.handle('scheduledRuns:pause', decide(id => getScheduledRunRunner().pause(id)));
  ipcMain.handle('scheduledRuns:resume', decide(id => getScheduledRunRunner().resume(id)));
  ipcMain.handle('scheduledRuns:cancel', decide(id => getScheduledRunRunner().cancel(id)));
  ipcMain.handle('scheduledRuns:skipEntry', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().skipEntry(id, entryId);
    changed();
    return buildScheduledRunView(run);
  });
  ipcMain.handle('scheduledRuns:retryEntry', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().retryEntry(id, entryId);
    changed();
    return buildScheduledRunView(run);
  });
  ipcMain.handle('scheduledRuns:approveGate', async (_event, id: string, entryId: string) => {
    const run = await getScheduledRunRunner().approveGate(id, entryId);
    changed();
    return buildScheduledRunView(run);
  });

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
    const { id: _id, ...form } = await withDefaultWorkflow(input, existing);
    const run = composeScheduledRun(existing, { ...form, at: new Date().toISOString() });
    await store.save(run);
    changed();
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
    await getScheduledRunStore().remove(id);
    changed();
  });

  ipcMain.handle('scheduledRuns:setArmed', async (_event, id: string, armed: boolean): Promise<ScheduledRunView> => {
    const at = new Date().toISOString();
    const run = armed ? armScheduledRun(requireRun(id), at) : holdScheduledRun(requireRun(id), at);
    await getScheduledRunStore().save(run);
    changed();
    return buildScheduledRunView(run);
  });

  ipcMain.handle('scheduledRuns:resolveMissed', async (_event, id: string, resolution: MissedResolution): Promise<ScheduledRunView> => {
    const run = resolveMissedScheduledRun(requireRun(id), resolution, new Date().toISOString());
    await getScheduledRunStore().save(run);
    changed();
    // "Start now" means now: do not wait for the next tick.
    if (resolution === 'start-now') void getScheduledRunRunner().tick().catch(error => console.error('Scheduled run start failed:', error));
    return buildScheduledRunView(run);
  });
}

/** Marks armed schedules whose time passed while Praxis was closed as missed. Call once at launch. */
export async function reconcileScheduledRunsOnLaunch(): Promise<void> {
  const changedRuns = await getScheduledRunStore().reconcileOnLaunch(new Date().toISOString());
  if (changedRuns.length > 0) changed();
}
