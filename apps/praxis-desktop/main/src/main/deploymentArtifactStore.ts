import * as path from 'node:path';
import { app } from 'electron';
import { createPublishedArtifact, type PublishedArtifact, type PublishManifest, type WorkflowEvidenceSourceRef } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

/**
 * Published artifact records (FX-BE-060 / TASK-160) — `deploymentArtifacts.json`
 * under `userData`, the same convention `deploymentManagerInstance.ts` uses
 * for `deploymentRuns.json`. Deliberately machine-local, not the project's
 * own `.praxis/deployments/` folder: a `PublishedArtifact.location.path`
 * points at wherever a build happened to land on *this* machine, which is
 * exactly the kind of local, ephemeral fact `DeploymentProfile` (committed,
 * reviewed, portable) must never carry — the same separation
 * `DeploymentRunStore` already draws between a profile (project folder) and
 * a run (userData).
 */

export interface PublishedArtifactRecord {
  artifact: PublishedArtifact;
  manifest: PublishManifest;
}

const KEY = 'praxis.publishedArtifacts.v1';
let store: JsonKeyValueStore | undefined;

function backing(): JsonKeyValueStore {
  if (!store) {
    store = new JsonKeyValueStore(path.join(app.getPath('userData'), 'deploymentArtifacts.json'));
  }
  return store;
}

function readAll(): PublishedArtifactRecord[] {
  const value = backing().get<PublishedArtifactRecord[]>(KEY);
  return Array.isArray(value) ? value : [];
}

/** Hashes `rootDir` and records the resulting `PublishedArtifact` — never replaces an existing record for the same id, matching a `PublishedArtifact`'s own "immutable, created once" contract. */
export async function publishArtifact(input: {
  id: string;
  deploymentProfileId: string;
  sourceCommit: WorkflowEvidenceSourceRef;
  rootDir: string;
}): Promise<PublishedArtifactRecord> {
  if (readAll().some(record => record.artifact.id === input.id)) {
    throw new Error(`Artifact ${input.id} was already published; artifacts are immutable once created.`);
  }
  const { artifact, manifest } = await createPublishedArtifact(input);
  const record: PublishedArtifactRecord = { artifact, manifest };
  await backing().update(KEY, [...readAll(), record]);
  return record;
}

export function listArtifactsForProfile(deploymentProfileId: string): PublishedArtifactRecord[] {
  return readAll()
    .filter(record => record.artifact.deploymentProfileId === deploymentProfileId)
    .sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
}

export function getPublishedArtifact(artifactId: string): PublishedArtifactRecord | undefined {
  return readAll().find(record => record.artifact.id === artifactId);
}

/** Every artifact ever published on this machine, newest first — for promotion, where a caller picks an artifact published under one profile and deploys it under another. */
export function listAllArtifacts(): PublishedArtifactRecord[] {
  return readAll().sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
}

export function resetDeploymentArtifactStore(): void {
  store = undefined;
}
