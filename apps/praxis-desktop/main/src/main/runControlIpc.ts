import { BrowserWindow, ipcMain } from 'electron';
import {
  readRunProfile,
  type BrowserDiagnosticsBundle,
  type CreateDiagnosisSessionResult,
  type PreviewVerificationCheck,
  type PreviewVerificationOutcome,
  type ReconciledService,
  type RunServiceStatus
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import {
  previewAccess,
  projectRunStatus,
  reconcileProjectRun,
  restartProjectRunService,
  startProjectRun,
  startProjectRunService,
  stopProjectRun,
  stopProjectRunService
} from './runManagerInstance';
import { getPreviewBrowser } from './previewBrowser';
import { startDiagnosisFromVerificationFailure } from './previewVerificationSession';

/** Run lifecycle + preview IPC (FX-BE-055 / TASK-146). */

function projectFolder(projectId: string): string | undefined {
  return getProjectStore().get(projectId)?.workspaceFolder?.trim() || undefined;
}

export function registerRunControlIpc(): void {
  ipcMain.handle('runs:start', async (_event, projectId: string): Promise<void> => {
    const folder = projectFolder(projectId);
    if (!folder) throw new Error('This project has no working folder to run services in.');
    const { profile, issues } = await readRunProfile(folder);
    if (!profile) throw new Error(issues[0]?.message ?? 'This project has no run profile yet.');
    await startProjectRun({ projectId, projectFolder: folder, profile });
  });

  ipcMain.handle('runs:stop', async (_event, projectId: string): Promise<void> => {
    await stopProjectRun(projectId);
  });

  ipcMain.handle('runs:stopService', async (_event, projectId: string, serviceId: string): Promise<void> => {
    await stopProjectRunService(projectId, serviceId);
  });

  ipcMain.handle('runs:startService', async (_event, projectId: string, serviceId: string): Promise<void> => {
    await startProjectRunService(projectId, serviceId);
  });

  ipcMain.handle('runs:restartService', async (_event, projectId: string, serviceId: string): Promise<void> => {
    await restartProjectRunService(projectId, serviceId);
  });

  ipcMain.handle('runs:status', async (_event, projectId: string): Promise<RunServiceStatus[]> => projectRunStatus(projectId));

  ipcMain.handle('runs:reconcile', async (_event, projectId: string): Promise<ReconciledService[]> => reconcileProjectRun(projectId));

  ipcMain.handle('runs:previewUrl', async (_event, projectId: string, serviceId: string): Promise<string | undefined> => {
    const status = projectRunStatus(projectId).find(service => service.id === serviceId);
    if (status?.state !== 'ready') return undefined;
    return previewAccess.grants().find(grant => grant.projectId === projectId && grant.serviceId === serviceId)?.origin;
  });

  const win = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) throw new Error('No window for preview IPC.');
    return w;
  };

  ipcMain.handle('preview:attach', event => {
    getPreviewBrowser().attach(win(event));
  });

  ipcMain.handle('preview:setBounds', (event, bounds: { x: number; y: number; width: number; height: number }) => {
    getPreviewBrowser().setBounds(win(event), bounds);
  });

  ipcMain.handle('preview:setVisible', (event, visible: boolean) => {
    getPreviewBrowser().setVisible(win(event), Boolean(visible));
  });

  ipcMain.handle('preview:open', async (_event, url: string): Promise<void> => {
    await getPreviewBrowser().open(String(url));
  });

  ipcMain.handle('preview:captureDiagnostics', async (): Promise<BrowserDiagnosticsBundle | undefined> => {
    return getPreviewBrowser().captureDiagnostics();
  });

  ipcMain.handle(
    'runs:runVerification',
    async (_event, projectId: string, check: PreviewVerificationCheck): Promise<PreviewVerificationOutcome> => {
      return getPreviewBrowser().runVerification({ projectId, check });
    }
  );

  ipcMain.handle(
    'runs:diagnoseVerificationFailure',
    async (_event, projectId: string, check: PreviewVerificationCheck, outcome: PreviewVerificationOutcome): Promise<CreateDiagnosisSessionResult> => {
      return startDiagnosisFromVerificationFailure({ check, outcome, workingDirectory: projectFolder(projectId) });
    }
  );
}
