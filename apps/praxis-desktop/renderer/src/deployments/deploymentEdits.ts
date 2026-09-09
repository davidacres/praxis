/**
 * Browser-safe deployment profile editor mutations (FX-BE-060 / TASK-159).
 *
 * A renderer-local copy of the shapes `packages/core/src/projects/deploymentProfile.ts`
 * defines, kept here for the same reason `workflowEdits.ts` keeps its own:
 * the renderer may import only *types* from `@praxis/core` at runtime (the
 * package is CommonJS and pulls in Node-only dependencies that cannot enter
 * the browser bundle). Validity (shape, capability preflight) is answered by
 * `window.praxis.deployments.{validateProfile,preflightCapabilities}` over
 * IPC, which runs core's real checks — these helpers only keep the object
 * coherent enough to edit, the same non-goal `workflowEdits.ts` states for
 * its own mutations.
 *
 * Nothing here reads or reacts to a project's issue-tracker connection —
 * there is no parameter for one anywhere below, and a `DeploymentProfile`'s
 * `target`/`executor` fields are only ever changed by an explicit call to
 * `updateProfile`/`setTarget`/`setExecutor`. That absence is what makes
 * "switching issue backend never rewrites deployment target" true by
 * construction rather than by a check somewhere: there is no code path
 * connecting the two at all.
 */

import type { DeploymentProfile, ExecutorRef, TargetRef } from '@praxis/core';

/** Mirrors `DEPLOYMENT_PROFILE_SCHEMA_VERSION` from `packages/core/src/projects/deploymentProfile.ts` — a plain constant here rather than a value import, per the renderer's types-only core rule. */
const DEPLOYMENT_PROFILE_SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'profile';
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function newLocalProcessTarget(): TargetRef {
  return { kind: 'local-process', executable: '' };
}

export function newDirectoryTarget(): TargetRef {
  return { kind: 'directory', path: '' };
}

export function newIisTarget(): TargetRef {
  return { kind: 'iis', siteName: '' };
}

export function newDirectProcessExecutor(): ExecutorRef {
  return { kind: 'direct-process' };
}

export function newGitHubActionsExecutor(): ExecutorRef {
  return { kind: 'github-actions', workflowFile: '' };
}

export function newGitLabCiExecutor(): ExecutorRef {
  return { kind: 'gitlab-ci', pipelineFile: '' };
}

export function emptyDeploymentProfile(input: { id: string; projectId: string; name: string }): DeploymentProfile {
  const at = nowIso();
  return {
    schemaVersion: DEPLOYMENT_PROFILE_SCHEMA_VERSION,
    id: input.id,
    version: 1,
    name: input.name,
    projectId: input.projectId,
    environment: '',
    executor: newDirectProcessExecutor(),
    target: newLocalProcessTarget(),
    rollback: { kind: 'none' },
    createdAt: at,
    updatedAt: at
  };
}

/** Applies a shallow patch and bumps `updatedAt`. Never touches `id`/`projectId`/`createdAt` — same non-goal `updateNode` states for a workflow node's `id`/`type`. */
export function updateProfile(profile: DeploymentProfile, patch: Partial<Omit<DeploymentProfile, 'id' | 'projectId' | 'createdAt'>>): DeploymentProfile {
  return { ...profile, ...patch, updatedAt: nowIso() };
}

/** Replaces the executor wholesale — a different kind carries different fields, so a partial patch across kinds would leave stale ones behind. */
export function setExecutor(profile: DeploymentProfile, executor: ExecutorRef): DeploymentProfile {
  return updateProfile(profile, { executor });
}

/** Replaces the target wholesale, for the same reason `setExecutor` does. */
export function setTarget(profile: DeploymentProfile, target: TargetRef): DeploymentProfile {
  return updateProfile(profile, { target });
}
