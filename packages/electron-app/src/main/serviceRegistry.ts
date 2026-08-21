import type { IssueTrackerService } from '@ticket-manager/core';
import { LiveFolderService } from '@ticket-manager/core';
import { getConnectionStore } from './connectionStoreInstance';
import { getDemoService } from './demoServiceInstance';
import { ElectronLiveFolderConfigProvider } from './adapters/electronLiveFolderConfigProvider';

const liveFolderServices = new Map<string, LiveFolderService>();

/** Resolves the backend for a connectionId. Undefined (or an unknown id) falls back to the built-in demo backend. */
export function getServiceForConnection(connectionId: string | undefined): IssueTrackerService {
  if (!connectionId) {
    return getDemoService();
  }

  const connection = getConnectionStore().getConnection(connectionId);
  if (!connection) {
    return getDemoService();
  }

  switch (connection.mode) {
    case 'livefolder': {
      const cached = liveFolderServices.get(connectionId);
      if (cached) {
        return cached;
      }
      const service = new LiveFolderService(new ElectronLiveFolderConfigProvider(connection));
      liveFolderServices.set(connectionId, service);
      return service;
    }
    default:
      return getDemoService();
  }
}

/** All connections whose mode has a working Electron backend today. */
export function getSupportedConnections() {
  return getConnectionStore().getConnections().filter(c => c.mode === 'livefolder');
}
