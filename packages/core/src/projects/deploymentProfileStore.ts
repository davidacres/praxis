/**
 * Portable deployment profile storage and credential rebinding
 * (FX-BF-023 / TASK-151).
 *
 * `deployment.praxis.json`-suffixed files, one per profile id, under
 * `<projectFolder>/.praxis/deployments/` — committed to the repository like
 * `run.praxis.json`, so a profile travels with the project rather than
 * living only on the machine that created it. Every path field TASK-150's
 * schema carries (`directory.path`, `local-process.cwd`) is already
 * repo-relative by validation, so a `directory`/`local-process` target
 * needs no per-machine rebinding at all — it resolves the same way
 * wherever the tree is checked out, the same portability property
 * `RunServiceDefinition.cwd` already has.
 *
 * What genuinely cannot travel with the repository is a credential value:
 * `credentials` holds only `${secret:NAME}` references (enforced by
 * `validateDeploymentProfile`), and each machine's own `SecretsStore` is
 * what actually resolves a NAME to a value — encrypted, per-profile,
 * never committed. `evaluateCredentialBindings` is "export/open on
 * another machine rebinds secrets explicitly": on a fresh checkout with an
 * empty secret store, every referenced credential comes back `bound:
 * false`, so a caller can prompt for each one by name rather than either
 * silently deploying with nothing bound or guessing at a value.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { validateDeploymentProfile, type DeploymentProfile, type DeploymentProfileIssue } from './deploymentProfile';

export const DEPLOYMENT_PROFILE_FILE_SUFFIX = '.deployment.praxis.json';
export const DEPLOYMENT_PROFILES_DIR = '.praxis/deployments';

function fileName(id: string): string {
  return `${id}${DEPLOYMENT_PROFILE_FILE_SUFFIX}`;
}

function profilesDir(projectFolder: string): string {
  return path.join(projectFolder, DEPLOYMENT_PROFILES_DIR);
}

/** Validates, then writes. Refuses to write a profile that would come back invalid on the next read — same fail-closed discipline as `writeRunProfile`. */
export async function writeDeploymentProfile(projectFolder: string, profile: DeploymentProfile): Promise<void> {
  const { valid, errors } = validateDeploymentProfile(profile);
  if (!valid) {
    throw new Error(
      `Deployment profile ${profile.id || '(unnamed)'} is invalid: ${errors.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`
    );
  }
  const dir = profilesDir(projectFolder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName(profile.id)), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}

/** A missing profile is not an error — comes back `{issues: []}`. A malformed hand-edited file comes back with a visible reason, matching `readRunProfile`'s contract. */
export async function readDeploymentProfile(
  projectFolder: string,
  id: string
): Promise<{ profile?: DeploymentProfile; issues: DeploymentProfileIssue[] }> {
  let raw: string;
  try {
    raw = await readFile(path.join(profilesDir(projectFolder), fileName(id)), 'utf8');
  } catch {
    return { issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { issues: [{ path: '', message: `Could not read deployment profile: ${(error as Error).message}` }] };
  }
  const profile = parsed as DeploymentProfile;
  const { valid, errors } = validateDeploymentProfile(profile);
  if (!valid) return { issues: errors };
  return { profile, issues: [] };
}

/**
 * Every profile stored for this project, valid ones only — a malformed
 * file is skipped rather than aborting the whole listing, since one
 * corrupt profile must not hide every other one from a UI trying to list
 * them all.
 */
export async function listDeploymentProfiles(projectFolder: string): Promise<DeploymentProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(profilesDir(projectFolder));
  } catch {
    return [];
  }
  const profiles: DeploymentProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(DEPLOYMENT_PROFILE_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -DEPLOYMENT_PROFILE_FILE_SUFFIX.length);
    const { profile } = await readDeploymentProfile(projectFolder, id);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/** A single credential's rebinding status on this machine. */
export interface CredentialBindingStatus {
  /** The key in `DeploymentProfile.credentials` (e.g. "DEPLOY_TOKEN"), not the secret store's own name. */
  key: string;
  /** The `NAME` extracted from `${secret:NAME}` — what actually gets looked up in the secret store. */
  secretName: string;
  bound: boolean;
}

const SECRET_REFERENCE = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

/**
 * Checks every credential reference in `profile.credentials` against this
 * machine's own secret store. `lookup` is a narrow seam
 * (`SecretsStore.get`'s own shape) so this stays testable without a real
 * `SecretsStore` — pass `(name) => secretsStore.get(name)` in the real app.
 * A malformed reference (should never happen past `validateDeploymentProfile`,
 * but this function fails closed regardless) reports `bound: false` rather
 * than throwing.
 */
export async function evaluateCredentialBindings(
  profile: DeploymentProfile,
  lookup: (secretName: string) => Promise<string | undefined>
): Promise<CredentialBindingStatus[]> {
  const results: CredentialBindingStatus[] = [];
  for (const [key, reference] of Object.entries(profile.credentials ?? {})) {
    const match = SECRET_REFERENCE.exec(reference);
    if (!match) {
      results.push({ key, secretName: '', bound: false });
      continue;
    }
    const secretName = match[1];
    const value = await lookup(secretName);
    results.push({ key, secretName, bound: value !== undefined && value.length > 0 });
  }
  return results;
}

/** True when every credential this profile references is actually bound on this machine — the explicit gate before a deploy should even be attempted. */
export function allCredentialsBound(statuses: CredentialBindingStatus[]): boolean {
  return statuses.every(status => status.bound);
}
