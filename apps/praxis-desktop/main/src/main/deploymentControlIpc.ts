import { ipcMain } from 'electron';
import {
  approveDirectDeployment,
  deploymentHealthResult,
  prepareDirectDeployment,
  rollbackDirectDeployment,
  runDirectDeployment,
  type ApproveDirectDeploymentResult,
  type DeploymentHealthResult,
  type DeploymentProfile,
  type DeploymentRun,
  type PublishManifest,
  type PublishedArtifact,
  type RollbackDirectDeploymentResult,
  type RunDirectDeploymentResult
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getDeploymentRunStore, getDeploymentTargetLocks } from './deploymentManagerInstance';

/**
 * Direct deployment action IPC (FX-BE-059 / TASK-158) — prepare, approve,
 * deploy, health results, and explicit rollback, each a thin pass-through
 * to `packages/core/src/deployments/directDeploymentOrchestrator.ts`. The
 * orchestrator's own idempotency (the `DeploymentRun` state machine's
 * per-command status guards, plus `DeploymentTargetLockRegistry`) is what
 * actually makes "repeated click and reconnect cannot duplicate execution"
 * true — this file adds no additional locking or deduplication of its own,
 * because doing so here would just be a second, weaker copy of what the
 * orchestrator already guarantees.
 *
 * A profile and its artifact/manifest are passed as plain arguments on each
 * call rather than looked up from a stored-profile id — picking which
 * profile and which published artifact to act on is FX-BE-060's UI concern
 * ("Build profile selection and review"), not this task's.
 */

function projectFolder(projectId: string): string {
  const folder = getProjectStore().get(projectId)?.workspaceFolder?.trim();
  if (!folder) throw new Error('This project has no working folder to deploy from.');
  return folder;
}

export interface DirectDeployOptions {
  excludePaths?: string[];
  backupDir?: string;
  stagingDir?: string;
  processInputs?: Record<string, string>;
  timeoutMs?: number;
  healthCheckHost?: string;
  healthCheckPort?: number;
}

export interface DirectRollbackOptions {
  backupDir?: string;
  excludePaths?: string[];
}

export interface PrepareDirectDeploymentContext {
  issueKey?: string;
  issueConnectionId?: string;
  workflowRunId?: string;
  targetUrl?: string;
}

export function registerDeploymentControlIpc(): void {
  ipcMain.handle(
    'deployments:prepare',
    async (
      _event,
      _projectId: string,
      runId: string,
      profile: DeploymentProfile,
      artifact: PublishedArtifact,
      context: PrepareDirectDeploymentContext = {}
    ): Promise<DeploymentRun> => {
      return prepareDirectDeployment({
        store: getDeploymentRunStore(),
        runId,
        profile,
        artifact,
        now: () => new Date().toISOString(),
        ...context
      });
    }
  );

  ipcMain.handle(
    'deployments:approve',
    async (
      _event,
      _projectId: string,
      runId: string,
      profile: DeploymentProfile,
      artifact: PublishedArtifact,
      actor: string
    ): Promise<ApproveDirectDeploymentResult> => {
      return approveDirectDeployment({
        store: getDeploymentRunStore(),
        runId,
        profile,
        artifact,
        actor,
        now: () => new Date().toISOString()
      });
    }
  );

  ipcMain.handle(
    'deployments:deploy',
    async (
      _event,
      projectId: string,
      runId: string,
      profile: DeploymentProfile,
      artifact: PublishedArtifact,
      manifest: PublishManifest,
      options: DirectDeployOptions = {}
    ): Promise<RunDirectDeploymentResult> => {
      return runDirectDeployment({
        store: getDeploymentRunStore(),
        locks: getDeploymentTargetLocks(),
        runId,
        profile,
        artifact,
        manifest,
        projectFolder: projectFolder(projectId),
        excludePaths: options.excludePaths,
        backupDir: options.backupDir,
        stagingDir: options.stagingDir,
        processInputs: options.processInputs,
        timeoutMs: options.timeoutMs,
        healthCheckHost: options.healthCheckHost,
        healthCheckPort: options.healthCheckPort,
        now: () => new Date().toISOString()
      });
    }
  );

  ipcMain.handle('deployments:getRun', async (_event, runId: string): Promise<DeploymentRun | undefined> => {
    return getDeploymentRunStore().get(runId);
  });

  ipcMain.handle('deployments:listRuns', async (_event, deploymentProfileId: string): Promise<DeploymentRun[]> => {
    return getDeploymentRunStore().forProfile(deploymentProfileId);
  });

  ipcMain.handle('deployments:health', async (_event, runId: string): Promise<DeploymentHealthResult> => {
    const run = getDeploymentRunStore().get(runId);
    if (!run) throw new Error(`Deployment run ${runId} was not found.`);
    return deploymentHealthResult(run);
  });

  ipcMain.handle(
    'deployments:rollback',
    async (
      _event,
      projectId: string,
      runId: string,
      profile: DeploymentProfile,
      options: DirectRollbackOptions = {}
    ): Promise<RollbackDirectDeploymentResult> => {
      return rollbackDirectDeployment({
        store: getDeploymentRunStore(),
        runId,
        profile,
        projectFolder: projectFolder(projectId),
        backupDir: options.backupDir,
        excludePaths: options.excludePaths,
        now: () => new Date().toISOString()
      });
    }
  );
}
