/**
 * Publish result manifests and digest validation (FX-BF-023 / TASK-152).
 *
 * A `PublishedArtifact` (TASK-150) is a claim: "this exact set of files, as
 * they existed at this moment, is what deploys." A manifest is what makes
 * that claim checkable rather than just asserted — every file under an
 * artifact's root, content-hashed, combined into one overall digest that
 * changes if anything is added, removed, or modified. "Reference a built
 * artifact for deployment/promotion instead of rebuilding" means a
 * deployment or promotion step reads `PublishedArtifact.digest` and
 * re-validates the files on disk still match it — it never re-runs a
 * build to get something to deploy.
 *
 * This module is generic on purpose: it hashes whatever directory tree
 * it's given, so a .NET `dotnet publish` output directory and a web
 * app's `dist/` are both "an artifact" to it — there is no dotnet- or
 * web-specific code path, matching the acceptance criteria's "a .NET
 * publish directory and a web artifact both validate."
 *
 * **This module does not touch, and this task does not reinterpret,**
 * `config/appSettings.ts`'s existing `publishCommand`/`artifactPattern`
 * (the MSI-oriented delivery-workflow settings `ai/deliveryWorkflow.ts`
 * already uses in its agent prompts). That is a separate, already-working
 * mechanism for a different workflow (the AI delivery agent's own publish
 * step); a `PublishManifest` is additive infrastructure for the
 * deployment-profile world TASK-150/151 built, not a replacement for it.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowEvidenceSourceRef } from '../workflows/workflowEvidence';
import type { PublishedArtifact } from './deploymentProfile';

export const PUBLISH_MANIFEST_SCHEMA_VERSION = 1;

export interface PublishManifestEntry {
  /** POSIX-separated, relative to the artifact root — portable across platforms regardless of which OS built or validates it. */
  path: string;
  digest: string;
  size: number;
}

export interface PublishManifest {
  schemaVersion: number;
  /** The overall artifact digest — combines every file's own digest, so any add/remove/modify changes this too. This is the value `PublishedArtifact.digest` (TASK-150) carries. */
  digest: string;
  files: PublishManifestEntry[];
  createdAt: string;
}

function sha256(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Every regular file under `rootDir`, recursively, as POSIX-relative paths
 * in sorted order — deterministic regardless of the filesystem's own
 * directory-read order. Exported for `deployments/directoryTarget.ts`
 * (TASK-157), which needs the identical walk to decide what a live target
 * directory currently holds; kept as one implementation rather than a
 * second copy of the same recursive walk.
 */
export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) results.push(path.relative(rootDir, full).split(path.sep).join('/'));
    }
  }
  await walk(rootDir);
  return results.sort();
}

function combinedDigest(files: PublishManifestEntry[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.digest}\n`);
  return `sha256:${hash.digest('hex')}`;
}

/** Hashes every file under `rootDir` and builds its manifest. Fails if `rootDir` doesn't exist or isn't a directory — there is no "empty manifest" for a publish that never happened. */
export async function buildPublishManifest(rootDir: string, createdAt: string = new Date().toISOString()): Promise<PublishManifest> {
  const rootStat = await stat(rootDir).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }
  const relativePaths = await listFilesRecursive(rootDir);
  const files: PublishManifestEntry[] = [];
  for (const relativePath of relativePaths) {
    const content = await readFile(path.join(rootDir, relativePath));
    files.push({ path: relativePath, digest: sha256(content), size: content.length });
  }
  return { schemaVersion: PUBLISH_MANIFEST_SCHEMA_VERSION, digest: combinedDigest(files), files, createdAt };
}

export type PublishValidationIssueKind = 'missing' | 'modified' | 'unexpected';

export interface PublishValidationIssue {
  path: string;
  kind: PublishValidationIssueKind;
}

/**
 * Re-hashes `rootDir` and compares it against a previously built
 * `manifest` — "absent or modified artifacts fail." A file the manifest
 * expected but that's gone is `missing`; one whose content changed is
 * `modified`; a file on disk the manifest never recorded is `unexpected`
 * — an artifact is exactly the files its manifest names, nothing added
 * since, so an extra file is a mismatch too, not a harmless bonus.
 */
export async function validatePublishedArtifact(rootDir: string, manifest: PublishManifest): Promise<{ valid: boolean; issues: PublishValidationIssue[] }> {
  const rootStat = await stat(rootDir).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return { valid: false, issues: manifest.files.map(file => ({ path: file.path, kind: 'missing' as const })) };
  }

  const expected = new Map(manifest.files.map(file => [file.path, file]));
  const onDisk = new Set(await listFilesRecursive(rootDir));
  const issues: PublishValidationIssue[] = [];

  for (const [relativePath, expectedEntry] of expected) {
    if (!onDisk.has(relativePath)) {
      issues.push({ path: relativePath, kind: 'missing' });
      continue;
    }
    const content = await readFile(path.join(rootDir, relativePath));
    if (sha256(content) !== expectedEntry.digest) {
      issues.push({ path: relativePath, kind: 'modified' });
    }
  }
  for (const relativePath of onDisk) {
    if (!expected.has(relativePath)) issues.push({ path: relativePath, kind: 'unexpected' });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Builds a manifest and folds it into a `PublishedArtifact` (TASK-150) —
 * the one place a manifest's digest becomes the digest a `DeploymentRun`
 * actually references. `id` is the caller's own choice (e.g. a generated
 * uuid); nothing here assigns one, matching `PublishedArtifact`'s own
 * "immutable, created once" contract — a caller decides identity before
 * calling this, not after.
 */
export async function createPublishedArtifact(input: {
  id: string;
  deploymentProfileId: string;
  sourceCommit: WorkflowEvidenceSourceRef;
  rootDir: string;
}): Promise<{ artifact: PublishedArtifact; manifest: PublishManifest }> {
  const manifest = await buildPublishManifest(input.rootDir);
  const artifact: PublishedArtifact = {
    id: input.id,
    deploymentProfileId: input.deploymentProfileId,
    sourceCommit: input.sourceCommit,
    digest: manifest.digest,
    createdAt: manifest.createdAt,
    location: { kind: 'local-path', path: input.rootDir }
  };
  return { artifact, manifest };
}
