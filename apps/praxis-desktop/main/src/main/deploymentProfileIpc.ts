import { ipcMain } from 'electron';
import {
  allCredentialsBound,
  evaluateCredentialBindings,
  listDeploymentProfiles,
  preflightDeploymentCapabilities,
  readDeploymentProfile,
  validateDeploymentProfile,
  writeDeploymentProfile,
  type CredentialBindingStatus,
  type DeploymentProfile,
  type DeploymentProfileIssue
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getSecretsStore } from './connectionStoreInstance';

/**
 * Deployment profile CRUD and live validation IPC (FX-BE-060 / TASK-159).
 *
 * A profile lives at `.praxis/deployments/<id>.deployment.praxis.json`
 * under the project's own workspace folder (TASK-151's
 * `deploymentProfileStore.ts`) — the same "one file per record, under the
 * project's own folder" discipline `runProfileIpc.ts` follows for
 * `run.praxis.json`. Nothing here touches `DeploymentRunStore` or the
 * target lock registry (`deploymentControlIpc.ts`'s concern) — this file
 * is purely "what profiles exist and are they well-formed," never "is one
 * currently deploying."
 */

function projectFolder(projectId: string): string {
  const folder = getProjectStore().get(projectId)?.workspaceFolder?.trim();
  if (!folder) throw new Error('This project has no working folder to store deployment profiles in.');
  return folder;
}

export function registerDeploymentProfileIpc(): void {
  ipcMain.handle('deployments:listProfiles', async (_event, projectId: string): Promise<DeploymentProfile[]> => {
    return listDeploymentProfiles(projectFolder(projectId));
  });

  ipcMain.handle(
    'deployments:getProfile',
    async (_event, projectId: string, profileId: string): Promise<{ profile?: DeploymentProfile; issues: DeploymentProfileIssue[] }> => {
      return readDeploymentProfile(projectFolder(projectId), profileId);
    }
  );

  /** Rejects an invalid profile with its errors rather than persisting it — the same discipline `workflows:save` follows. */
  ipcMain.handle('deployments:saveProfile', async (_event, projectId: string, profile: DeploymentProfile): Promise<DeploymentProfile> => {
    const { valid, errors } = validateDeploymentProfile(profile);
    if (!valid) {
      throw new Error(`Deployment profile is invalid: ${errors.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`);
    }
    await writeDeploymentProfile(projectFolder(projectId), profile);
    return profile;
  });

  /** Live validation for the editor — no persistence. Structural shape only; see `preflightCapabilities` for "can this build actually run it." */
  ipcMain.handle(
    'deployments:validateProfile',
    async (_event, profile: DeploymentProfile): Promise<{ valid: boolean; errors: DeploymentProfileIssue[] }> => {
      return validateDeploymentProfile(profile);
    }
  );

  /** "Can this build, right now, actually run this" — unsupported executor/target kinds surface here, not as a structural error. */
  ipcMain.handle('deployments:preflightCapabilities', async (_event, profile: DeploymentProfile): Promise<DeploymentProfileIssue[]> => {
    return preflightDeploymentCapabilities(profile);
  });

  ipcMain.handle(
    'deployments:evaluateCredentials',
    async (_event, profile: DeploymentProfile): Promise<{ statuses: CredentialBindingStatus[]; allBound: boolean }> => {
      const statuses = await evaluateCredentialBindings(profile, name => getSecretsStore().get(name));
      return { statuses, allBound: allCredentialsBound(statuses) };
    }
  );
}
