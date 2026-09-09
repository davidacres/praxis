/**
 * The `directory` deployment target: a persistent local web root updated in
 * place from one immutable artifact (FX-BE-059 / TASK-157).
 *
 * "Distinguish application content from mutable data" is the load-bearing
 * idea: every file the artifact's own `PublishManifest` names is
 * application content — owned by the deploy, replaced wholesale on every
 * update. Anything under a caller-configured `excludePaths` entry is
 * mutable data — an upload folder, a local config override, a database
 * file — and is never read, copied over, or deleted by this module,
 * regardless of what the new artifact contains. There is no third
 * category and no inference: a path is either named in the manifest or it
 * is excluded; this module never guesses which a file already on disk
 * belongs to.
 *
 * The flow: stage the new artifact's files into a scratch directory first,
 * so a read failure never touches the live target; back up the target's
 * current non-excluded content; remove that content; copy the staged files
 * in. A post-install health check (reusing `RunReadinessProbe` — the same
 * type `projects/runProfile.ts` and a `DeploymentProfile.healthCheck`
 * already use, `host/networkProbe.ts`'s http/tcp checks doing the actual
 * work, shared with `projects/runServiceManager.ts`) that fails restores
 * the backup this same deploy just took, automatically.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { checkHttpOk, checkTcpOpen } from '../host/networkProbe';
import { isSafeSegment } from '../workflows/workflowEvidence';
import { listFilesRecursive, validatePublishedArtifact, type PublishManifest } from '../projects/publishManifest';
import type { DirectoryTargetRef } from '../projects/deploymentProfile';
import type { RunReadinessProbe } from '../projects/runProfile';

/** A relative, POSIX-separated path under the target directory: no leading `/`, no `..`, every segment filesystem-safe. */
export function isValidExcludePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.split('/').includes('..')) return false;
  return value.split('/').every(isSafeSegment);
}

function isExcluded(relativePath: string, excludePaths: string[]): boolean {
  return excludePaths.some(exclude => relativePath === exclude || relativePath.startsWith(`${exclude}/`));
}

async function copyRelative(fromRoot: string, toRoot: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/');
  const from = path.join(fromRoot, ...segments);
  const to = path.join(toRoot, ...segments);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
}

/** Copies every non-excluded file currently under `targetDir` into `backupDir`, preserving relative paths. */
async function backupApplicationContent(targetDir: string, excludePaths: string[], backupDir: string): Promise<void> {
  const exists = await stat(targetDir).catch(() => undefined);
  if (!exists?.isDirectory()) return; // nothing to back up on a first deploy
  const files = await listFilesRecursive(targetDir);
  for (const relativePath of files) {
    if (isExcluded(relativePath, excludePaths)) continue;
    await copyRelative(targetDir, backupDir, relativePath);
  }
}

/** Deletes every non-excluded file currently under `targetDir`. Excluded files, and the directories that hold only excluded files, are left untouched. */
async function removeApplicationContent(targetDir: string, excludePaths: string[]): Promise<void> {
  const exists = await stat(targetDir).catch(() => undefined);
  if (!exists?.isDirectory()) return;
  const files = await listFilesRecursive(targetDir);
  for (const relativePath of files) {
    if (isExcluded(relativePath, excludePaths)) continue;
    await rm(path.join(targetDir, ...relativePath.split('/')), { force: true });
  }
}

export interface DirectoryDeploymentInput {
  target: DirectoryTargetRef;
  /** Where the immutable artifact currently lives on disk. Re-validated against `manifest` before anything under `target.path` is touched. */
  artifactRootDir: string;
  manifest: PublishManifest;
  /** Relative paths under `target.path` that are mutable user data — see the module doc. */
  excludePaths: string[];
  /** Where this deploy's backup of the previous application content is written; a fresh subdirectory per call, never reused. */
  backupDir: string;
  /** Scratch directory the new artifact is staged into before the live target is touched. Caller-supplied so it can be cleaned up alongside the caller's own temp-directory lifecycle. */
  stagingDir: string;
}

export interface DirectoryDeploymentResult {
  applied: boolean;
  filesWritten: string[];
  error?: string;
}

/**
 * Updates `target.path` in place from `manifest`'s artifact, preserving
 * every excluded path untouched and backing up whatever application
 * content it replaces into `backupDir` first — restorable via
 * `restoreDirectoryBackup`. Refuses (without touching the target at all)
 * when an exclude path is not a safe relative path, or when the artifact on
 * disk no longer matches its own manifest.
 */
export async function applyDirectoryDeployment(input: DirectoryDeploymentInput): Promise<DirectoryDeploymentResult> {
  const badExclude = input.excludePaths.find(value => !isValidExcludePath(value));
  if (badExclude !== undefined) {
    return { applied: false, filesWritten: [], error: `Not a safe exclude path: "${badExclude}".` };
  }

  const artifactCheck = await validatePublishedArtifact(input.artifactRootDir, input.manifest);
  if (!artifactCheck.valid) {
    return {
      applied: false,
      filesWritten: [],
      error: `Artifact no longer matches its manifest: ${artifactCheck.issues.map(issue => `${issue.kind} ${issue.path}`).join(', ')}.`
    };
  }

  // Stage first: every artifact file must be readable before the live
  // target is touched at all, so a source-side problem never leaves the
  // target half-replaced.
  for (const file of input.manifest.files) {
    await copyRelative(input.artifactRootDir, input.stagingDir, file.path);
  }

  await mkdir(input.target.path, { recursive: true });
  await backupApplicationContent(input.target.path, input.excludePaths, input.backupDir);
  await removeApplicationContent(input.target.path, input.excludePaths);

  const filesWritten: string[] = [];
  for (const file of input.manifest.files) {
    await copyRelative(input.stagingDir, input.target.path, file.path);
    filesWritten.push(file.path);
  }

  return { applied: true, filesWritten };
}

/** Restores `target.path`'s application content from a backup `applyDirectoryDeployment` took, leaving excluded paths untouched throughout. */
export async function restoreDirectoryBackup(
  target: DirectoryTargetRef,
  backupDir: string,
  excludePaths: string[]
): Promise<{ restored: boolean; error?: string }> {
  const backupStat = await stat(backupDir).catch(() => undefined);
  if (!backupStat?.isDirectory()) {
    return { restored: false, error: `Backup directory not found: ${backupDir}` };
  }

  await removeApplicationContent(target.path, excludePaths);
  const files = await listFilesRecursive(backupDir);
  for (const relativePath of files) {
    await copyRelative(backupDir, target.path, relativePath);
  }
  return { restored: true };
}

export interface DirectoryHealthCheckResult {
  healthy: boolean;
  detail: string;
}

/**
 * Runs a configured post-install health check against `host:port`. A
 * directory target has no process of its own for a log-line probe to read
 * from, so that probe kind is refused rather than silently treated as
 * passing — an unsupported check must never be mistaken for a passed one.
 */
export async function verifyDirectoryHealth(
  probe: RunReadinessProbe,
  host: string,
  port: number
): Promise<DirectoryHealthCheckResult> {
  if (probe.kind === 'log-line') {
    return {
      healthy: false,
      detail: 'A log-line health check is not supported for a directory target — nothing serving it has a log stream Praxis controls.'
    };
  }
  const healthy =
    probe.kind === 'tcp' ? await checkTcpOpen(host, port) : await checkHttpOk(host, port, probe.path, probe.expectedStatus);
  return { healthy, detail: healthy ? 'Health check passed.' : 'Health check failed.' };
}

export interface DirectoryDeploymentWithHealthInput extends DirectoryDeploymentInput {
  /** Absent means no post-install verification is configured — the deploy stands as applied, unverified. */
  healthCheck?: RunReadinessProbe;
  healthCheckHost?: string;
  healthCheckPort?: number;
}

export interface DirectoryDeploymentWithHealthResult extends DirectoryDeploymentResult {
  /** Absent when no health check was configured, or the deploy itself never applied. */
  healthy?: boolean;
  /** True once a failed health check's automatic restore has completed. */
  restored?: boolean;
}

/**
 * `applyDirectoryDeployment` plus, when `healthCheck` is configured, an
 * automatic restore of the backup this same call just took if the check
 * fails — "fails on bad health and can restore the previous version" as
 * one integrated call, so a caller cannot apply without ever checking, or
 * check without a restore path.
 */
export async function deployDirectoryWithHealthCheck(
  input: DirectoryDeploymentWithHealthInput
): Promise<DirectoryDeploymentWithHealthResult> {
  const applied = await applyDirectoryDeployment(input);
  if (!applied.applied || !input.healthCheck) return applied;

  const health = await verifyDirectoryHealth(input.healthCheck, input.healthCheckHost ?? '127.0.0.1', input.healthCheckPort ?? 80);
  if (health.healthy) return { ...applied, healthy: true };

  const restore = await restoreDirectoryBackup(input.target, input.backupDir, input.excludePaths);
  return {
    ...applied,
    healthy: false,
    restored: restore.restored,
    error: restore.restored ? `${health.detail} Restored the previous version.` : `${health.detail} Restore also failed: ${restore.error}`
  };
}

/** Every file currently under `dir`, POSIX-relative — for tests and diagnostics. Empty (not an error) when `dir` does not exist. */
export async function listDirectoryContents(dir: string): Promise<string[]> {
  const exists = await stat(dir).catch(() => undefined);
  if (!exists?.isDirectory()) return [];
  return listFilesRecursive(dir);
}
