import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseRunProfile,
  serializeRunProfile,
  validateRunProfile,
  RUN_PROFILE_FILE_NAME,
  type RunProfile,
  type RunProfileIssue
} from './runProfile';

/**
 * `<projectFolder>/run.praxis.json` storage (FX-BE-054 / TASK-143).
 *
 * One profile per project, at the project root — same tier as
 * `project.praxis.md`/`board.praxis.json`, not `.praxis/workflows/`'s
 * one-file-per-id folder, because a Run profile is project identity ("how do
 * I run this project locally"), not a library of definitions a project
 * chooses among.
 */

/**
 * A missing file is not an error — most projects have not created a Run
 * profile yet. A malformed one comes back with `issues` rather than being
 * silently ignored: unlike `board.praxis.json`'s "no overrides" contract, a
 * broken run.praxis.json a person hand-edited deserves a visible reason, not
 * a silent fallback to "no profile".
 */
export async function readRunProfile(projectFolder: string): Promise<{ profile?: RunProfile; issues: RunProfileIssue[] }> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectFolder, RUN_PROFILE_FILE_NAME), 'utf8');
  } catch {
    return { issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { issues: [{ path: '', message: `Could not read run profile: ${(error as Error).message}` }] };
  }
  return parseRunProfile(parsed);
}

/** Validates, then writes. Refuses to write a profile that would come back invalid on the next read. */
export async function writeRunProfile(projectFolder: string, profile: RunProfile): Promise<void> {
  const { valid, errors } = validateRunProfile(profile);
  if (!valid) {
    throw new Error(
      `Run profile ${profile.id || '(unnamed)'} is invalid: ${errors.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ')}`
    );
  }
  await mkdir(projectFolder, { recursive: true });
  await writeFile(path.join(projectFolder, RUN_PROFILE_FILE_NAME), serializeRunProfile(profile), 'utf8');
}
