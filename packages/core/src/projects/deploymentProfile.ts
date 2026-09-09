/**
 * Deployment domain contracts (FX-BF-023 / TASK-150).
 *
 * A project's issue tracker (Jira, GitHub Issues, …) must never determine
 * how or where it deploys — that's `feature.md`'s own "Implementation
 * boundaries" for this feature, stated as an invariant. `DeploymentProfile`
 * is deliberately independent of `Project.type`/tracker connection: nothing
 * here reads or branches on tracker identity, and a schema test proves a
 * profile round-trips the same way regardless of which tracker the owning
 * project happens to use.
 *
 * `ExecutorRef`/`TargetRef` are closed unions covering more kinds than this
 * feature (FX-BF-023) actually implements — `direct-process` execution and
 * `local-process`/`directory` targets are this feature's own scope
 * (FX-BE-059); `github-actions`/`gitlab-ci` executors and an `iis` target
 * are modeled now so a profile authored against them is at least
 * schema-valid, but belong to later features (pipeline-managed deployment,
 * the IIS target) to actually execute. `validateDeploymentProfile` checks
 * shape only; `preflightDeploymentCapabilities` is the separate, second
 * check for "can *this build*, right now, actually run this" — the
 * acceptance criterion's "unsupported executor/target capabilities fail
 * preflight" is that second function, not the first, on purpose: a
 * schema-valid profile referencing a not-yet-implemented executor must
 * still be readable, storable, and displayable, and only refused at the
 * point something would actually try to run it.
 */

import type { WorkflowEvidenceSourceRef } from '../workflows/workflowEvidence';
import type { RunReadinessProbe } from './runProfile';

export const DEPLOYMENT_PROFILE_SCHEMA_VERSION = 1;

export type DeploymentExecutorKind = 'direct-process' | 'github-actions' | 'gitlab-ci';
export type DeploymentTargetKind = 'local-process' | 'directory' | 'iis';

/** Executors this feature (FX-BF-023 / FX-BE-059) actually implements — everything else is schema-valid but not yet runnable. */
export const SUPPORTED_EXECUTOR_KINDS: ReadonlySet<DeploymentExecutorKind> = new Set(['direct-process']);
/** Targets this feature actually implements. IIS needs Windows and a later feature (FX-BF-025). */
export const SUPPORTED_TARGET_KINDS: ReadonlySet<DeploymentTargetKind> = new Set(['local-process', 'directory']);

export interface DirectProcessExecutorRef {
  kind: 'direct-process';
}

/** Schema-valid now; execution belongs to a pipeline-managed-deployment feature, not this one. */
export interface GitHubActionsExecutorRef {
  kind: 'github-actions';
  workflowFile: string;
}

/** Schema-valid now; execution belongs to a pipeline-managed-deployment feature, not this one. */
export interface GitLabCiExecutorRef {
  kind: 'gitlab-ci';
  pipelineFile: string;
}

export type ExecutorRef = DirectProcessExecutorRef | GitHubActionsExecutorRef | GitLabCiExecutorRef;

/** Runs the published artifact as a local process — the direct executor's own target. */
export interface LocalProcessTargetRef {
  kind: 'local-process';
  executable: string;
  args?: string[];
  /** Repo-relative, resolved against the project's workspace folder — never stored absolute (same discipline as `RunServiceDefinition.cwd`). */
  cwd?: string;
}

/** Copies the published artifact into a directory — e.g. a static site's web root. */
export interface DirectoryTargetRef {
  kind: 'directory';
  path: string;
}

/** Schema-valid now; execution needs Windows and belongs to FX-BF-025, not this feature. */
export interface IisTargetRef {
  kind: 'iis';
  siteName: string;
  appPoolName?: string;
}

export type TargetRef = LocalProcessTargetRef | DirectoryTargetRef | IisTargetRef;

export interface DeploymentRollbackPolicy {
  kind: 'keep-previous-artifact' | 'none';
  /** How many prior artifacts to retain for rollback; only meaningful for `keep-previous-artifact`. */
  retainCount?: number;
}

export interface DeploymentProfile {
  schemaVersion: number;
  id: string;
  name: string;
  projectId: string;
  /** Free text (e.g. "staging", "production") — deliberately not a closed enum; environments are project-defined, not Praxis-defined. */
  environment: string;
  executor: ExecutorRef;
  target: TargetRef;
  /** Reuses `RunReadinessProbe` (TASK-141) rather than a second probe schema — a deployment health check and a Run service's readiness probe are the same concept (how do I know this process is actually up) applied at a different point in the lifecycle. */
  healthCheck?: RunReadinessProbe;
  rollback: DeploymentRollbackPolicy;
  createdAt: string;
  updatedAt: string;
}

/** An immutable, published build — created once, never mutated. A `DeploymentRun` references one by id; nothing here ever updates a `PublishedArtifact` in place. */
export interface PublishedArtifact {
  id: string;
  deploymentProfileId: string;
  /** Reuses `WorkflowEvidenceSourceRef` (TASK-132) — "the commit this came from, explicit when unknown" is the same concept for a deployable artifact as for a workflow evidence bundle. */
  sourceCommit: WorkflowEvidenceSourceRef;
  /** A content hash (e.g. `sha256:<hex>`) proving what was actually published — the identity a `DeploymentRun` and a rollback both check against, not just a filename. */
  digest: string;
  createdAt: string;
  /** Where the artifact's bytes actually live. Only a local path for this feature's direct executor; a registry/URL-based location is a later executor's concern. */
  location: { kind: 'local-path'; path: string };
}

export type DeploymentRunStatus = 'pending' | 'deploying' | 'healthy' | 'failed' | 'rolled-back';

export interface DeploymentRun {
  id: string;
  deploymentProfileId: string;
  artifactId: string;
  status: DeploymentRunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface DeploymentProfileIssue {
  path: string;
  message: string;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Shape validation only — a profile referencing a not-yet-implemented executor/target is still valid here. See `preflightDeploymentCapabilities` for the "can this build actually run it" check. */
export function validateDeploymentProfile(profile: DeploymentProfile): { valid: boolean; errors: DeploymentProfileIssue[] } {
  const errors: DeploymentProfileIssue[] = [];
  if (!isNonEmpty(profile.id)) errors.push({ path: 'id', message: 'id is required.' });
  if (!isNonEmpty(profile.name)) errors.push({ path: 'name', message: 'name is required.' });
  if (!isNonEmpty(profile.projectId)) errors.push({ path: 'projectId', message: 'projectId is required.' });
  if (!isNonEmpty(profile.environment)) errors.push({ path: 'environment', message: 'environment is required.' });

  const executorKinds: DeploymentExecutorKind[] = ['direct-process', 'github-actions', 'gitlab-ci'];
  if (!executorKinds.includes(profile.executor?.kind)) {
    errors.push({ path: 'executor.kind', message: `Unknown executor kind "${profile.executor?.kind}".` });
  } else if (profile.executor.kind === 'github-actions' && !isNonEmpty(profile.executor.workflowFile)) {
    errors.push({ path: 'executor.workflowFile', message: 'workflowFile is required for a github-actions executor.' });
  } else if (profile.executor.kind === 'gitlab-ci' && !isNonEmpty(profile.executor.pipelineFile)) {
    errors.push({ path: 'executor.pipelineFile', message: 'pipelineFile is required for a gitlab-ci executor.' });
  }

  const targetKinds: DeploymentTargetKind[] = ['local-process', 'directory', 'iis'];
  if (!targetKinds.includes(profile.target?.kind)) {
    errors.push({ path: 'target.kind', message: `Unknown target kind "${profile.target?.kind}".` });
  } else if (profile.target.kind === 'local-process' && !isNonEmpty(profile.target.executable)) {
    errors.push({ path: 'target.executable', message: 'executable is required for a local-process target.' });
  } else if (profile.target.kind === 'directory' && !isNonEmpty(profile.target.path)) {
    errors.push({ path: 'target.path', message: 'path is required for a directory target.' });
  } else if (profile.target.kind === 'iis' && !isNonEmpty(profile.target.siteName)) {
    errors.push({ path: 'target.siteName', message: 'siteName is required for an iis target.' });
  }

  const rollbackKinds: DeploymentRollbackPolicy['kind'][] = ['keep-previous-artifact', 'none'];
  if (!rollbackKinds.includes(profile.rollback?.kind)) {
    errors.push({ path: 'rollback.kind', message: `Unknown rollback kind "${profile.rollback?.kind}".` });
  } else if (profile.rollback.kind === 'keep-previous-artifact' && profile.rollback.retainCount !== undefined) {
    if (!Number.isInteger(profile.rollback.retainCount) || profile.rollback.retainCount < 1) {
      errors.push({ path: 'rollback.retainCount', message: 'retainCount must be a positive integer when set.' });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The "unsupported executor/target capabilities fail preflight" check
 * itself: a schema-valid profile can still name an executor or target this
 * build cannot run. Returns every unsupported capability found — never
 * throws — so a caller can show *all* the reasons a profile can't be
 * deployed from here, not just the first.
 */
export function preflightDeploymentCapabilities(profile: DeploymentProfile): DeploymentProfileIssue[] {
  const issues: DeploymentProfileIssue[] = [];
  if (!SUPPORTED_EXECUTOR_KINDS.has(profile.executor.kind)) {
    issues.push({ path: 'executor.kind', message: `Executor "${profile.executor.kind}" is not supported by this build.` });
  }
  if (!SUPPORTED_TARGET_KINDS.has(profile.target.kind)) {
    issues.push({ path: 'target.kind', message: `Target "${profile.target.kind}" is not supported by this build.` });
  }
  return issues;
}
