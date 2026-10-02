import { ipcMain, app } from 'electron';
import { broadcastToAllWindows } from './windowBroadcast';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AppSettingsPatch, MobileCapability } from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';
import { abortActiveTask, getAllActiveTaskIssueKeys, resetAiStores } from './aiInstance';
import { resetBoardPreferencesStore } from './boardPreferencesInstance';
import { resetProjectStore } from './projectStoreInstance';
import { resetTaskDesignerStore } from './taskDesignerStoreInstance';
import { resetWorkspaceStore } from './workspaceStoreInstance';
import { resetWorkspaceScopes } from './workspaceLocations';
import { getConnectionStore } from './connectionStoreInstance';
import {
  confirmMobilePairing,
  createMobilePairingInvitation,
  denyMobilePairing,
  revokeMobilePairedDevice,
  rotateMobileHostKey,
  snapshotMobilePairing,
} from './mobilePairingInstance';
import { restartMobileLanAfterKeyRotation } from './mobileListenerInstance';
import { setDesktopAppearance } from './mobileAppearance';

async function removeUserDataFile(name: string): Promise<void> {
  await fs.rm(path.join(app.getPath('userData'), name), { force: true });
}

/**
 * Registers the settings IPC channels: `settings:get`, `settings:set`, and the
 * push channel `settings:changed` broadcast from main to every live window when
 * the backend fires `onDidChange` (either from a local `set` or from the VS
 * Code extension editing the same file).
 */
export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => getSettingsBackend().read());

  ipcMain.handle('settings:set', async (_event, patch: AppSettingsPatch) =>
    getSettingsBackend().write(patch)
  );

  ipcMain.handle('settings:getMobileHostInfo', async () => snapshotMobilePairing());
  ipcMain.handle('settings:publishMobileAppearance', async (_event, appearance: unknown) => { setDesktopAppearance(appearance); });
  ipcMain.handle('settings:createMobilePairingInvitation', async () => createMobilePairingInvitation());
  ipcMain.handle('settings:confirmMobilePairing', async (_event, requestId: string, grant: { label?: string; capabilities: readonly MobileCapability[]; projectIds: readonly string[] }) =>
    confirmMobilePairing(requestId, grant),
  );
  ipcMain.handle('settings:denyMobilePairing', async (_event, requestId: string) => denyMobilePairing(requestId));
  ipcMain.handle('settings:revokeMobilePairedDevice', async (_event, deviceId: string) => revokeMobilePairedDevice(deviceId));
  ipcMain.handle('settings:rotateMobileHostKey', async () => {
    const snapshot = await rotateMobileHostKey();
    await restartMobileLanAfterKeyRotation();
    return snapshotMobilePairing().then(next => next ?? snapshot);
  });

  ipcMain.handle('settings:clearSessionData', async () => {
    const activeIssues = getAllActiveTaskIssueKeys();
    await Promise.all(activeIssues.map(issueKey => abortActiveTask(issueKey)));
    await Promise.all([removeUserDataFile('ai-sessions.json'), removeUserDataFile('ai-analysis.json')]);
    resetAiStores();
  });

  ipcMain.handle('settings:clearProjectWorkspaceBoardData', async () => {
    await getConnectionStore().clearTrackedBoards();
    await Promise.all([
      removeUserDataFile('workspaces.json'),
      removeUserDataFile('workspace-locations.json'),
      removeUserDataFile('projects.json'),
      removeUserDataFile('board-preferences.json'),
      removeUserDataFile('task-designer.json'),
      fs.rm(path.join(app.getPath('userData'), 'projects'), { recursive: true, force: true })
    ]);
    resetWorkspaceScopes();
    resetWorkspaceStore();
    resetProjectStore();
    resetBoardPreferencesStore();
    resetTaskDesignerStore();
  });

  getSettingsBackend().onDidChange(settings => {
    broadcastToAllWindows('settings:changed', settings);
  });
}
