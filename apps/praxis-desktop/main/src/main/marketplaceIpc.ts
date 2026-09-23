import { BrowserWindow, ipcMain } from 'electron';
import type {
  AddonKind,
  MarketplaceConfigPatch,
  MarketplaceInstallOptions
} from '@praxis/core';

import { getLogBus } from './logBusInstance';
import {
  buildMarketplaceService,
  configureMarketplace,
  emitMarketplaceChanged,
  getMarketplaceStatus,
  listInstalledAddons,
  onMarketplaceChanged,
  readActiveAppearance,
  refreshAgentRuntimeForAddons,
  removeInstalledAddon,
  setInstalledAddonTrust,
  setMarketplaceToken
} from './marketplaceInstance';

/**
 * `marketplace:*` IPC. Config and browse/install/update/remove over
 * {@link buildMarketplaceService}; `marketplace:changed` is pushed to every
 * window after any mutation so the renderer can re-register add-ons and refresh
 * its lists.
 */
export function registerMarketplaceIpc(): void {
  ipcMain.handle('marketplace:getStatus', () => getMarketplaceStatus());

  ipcMain.handle('marketplace:configure', (_event, patch: MarketplaceConfigPatch) =>
    configureMarketplace(patch ?? {})
  );

  ipcMain.handle('marketplace:setToken', (_event, token: string | null) =>
    setMarketplaceToken(token ?? null)
  );

  ipcMain.handle('marketplace:listCatalog', async () => {
    const service = await buildMarketplaceService();
    return service.listCatalog();
  });

  // Installed add-ons are read straight from disk — no registry, no token.
  ipcMain.handle('marketplace:listInstalled', () => listInstalledAddons());

  ipcMain.handle('marketplace:listActiveAppearance', () => readActiveAppearance());

  ipcMain.handle(
    'marketplace:install',
    async (_event, packageName: string, options?: MarketplaceInstallOptions) => {
      const service = await buildMarketplaceService();
      const record = await service.install(packageName, options);
      if (record.manifest.kind === 'agent' || record.manifest.kind === 'skill') {
        await refreshAgentRuntimeForAddons();
      }
      emitMarketplaceChanged();
      getLogBus().appendLine(
        `[marketplace] installed ${record.manifest.kind}/${record.manifest.id} ${record.version}`
      );
      return record;
    }
  );

  ipcMain.handle('marketplace:update', async (_event, kind: AddonKind, id: string) => {
    const service = await buildMarketplaceService();
    const record = await service.update(kind, id);
    if (kind === 'agent' || kind === 'skill') {
      await refreshAgentRuntimeForAddons();
    }
    emitMarketplaceChanged();
    return record;
  });

  // Removing and (un)trusting are local disk operations — no registry, no token.
  ipcMain.handle('marketplace:remove', (_event, kind: AddonKind, id: string) =>
    removeInstalledAddon(kind, id)
  );

  ipcMain.handle('marketplace:checkForUpdates', async () => {
    const service = await buildMarketplaceService();
    return service.checkForUpdates();
  });

  ipcMain.handle('marketplace:setTrust', (_event, kind: AddonKind, id: string, enabled: boolean) =>
    setInstalledAddonTrust(kind, id, enabled)
  );

  onMarketplaceChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('marketplace:changed');
    }
  });
}
