import { ipcMain } from 'electron';
import type { WorkflowEvidenceSourceRef } from '@praxis/core';
import {
  getPublishedArtifact,
  listAllArtifacts,
  listArtifactsForProfile,
  publishArtifact,
  type PublishedArtifactRecord
} from './deploymentArtifactStore';

/**
 * Published artifact IPC (FX-BE-060 / TASK-160) — separate from
 * `deploymentControlIpc.ts` (run actions) and `deploymentProfileIpc.ts`
 * (profile CRUD) the same way `deploymentArtifactStore.ts` is a separate
 * store from both `DeploymentRunStore` and the file-based profile store:
 * three different lifetimes, three different owners.
 */
export function registerDeploymentArtifactIpc(): void {
  ipcMain.handle(
    'deployments:publishArtifact',
    async (
      _event,
      artifactId: string,
      deploymentProfileId: string,
      rootDir: string,
      sourceCommit: WorkflowEvidenceSourceRef = { kind: 'unknown' }
    ): Promise<PublishedArtifactRecord> => {
      return publishArtifact({ id: artifactId, deploymentProfileId, rootDir, sourceCommit });
    }
  );

  ipcMain.handle('deployments:listArtifacts', async (_event, deploymentProfileId: string): Promise<PublishedArtifactRecord[]> => {
    return listArtifactsForProfile(deploymentProfileId);
  });

  ipcMain.handle('deployments:listAllArtifacts', async (): Promise<PublishedArtifactRecord[]> => {
    return listAllArtifacts();
  });

  ipcMain.handle('deployments:getArtifact', async (_event, artifactId: string): Promise<PublishedArtifactRecord | undefined> => {
    return getPublishedArtifact(artifactId);
  });
}
