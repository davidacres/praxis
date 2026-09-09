import { ipcMain } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  proposeDotnetRunService,
  proposeNodeRunService,
  readRunProfile,
  validateRunProfile,
  writeRunProfile,
  type ProposedRunService,
  type RunProfile,
  type RunProfileIssue,
  type RunProfileValidationResult
} from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';

/**
 * Run profile IPC (FX-BE-054 / TASK-143): read/write `run.praxis.json`
 * through TASK-141's fail-closed store, and a shallow discovery scan built
 * on TASK-142's read-only proposal functions.
 */

function projectFolder(projectId: string): string | undefined {
  return getProjectStore().get(projectId)?.workspaceFolder?.trim() || undefined;
}

/**
 * A shallow scan (project root plus its immediate subdirectories) for a
 * Node `package.json` or an ASP.NET `Properties/launchSettings.json` —
 * enough for the common "frontend/ + api/" project layout the acceptance
 * fixtures cover, without recursing an entire repository. Every candidate
 * file is only ever read and handed to TASK-142's parse-only functions.
 */
async function discoverRunServices(rootFolder: string): Promise<Array<ProposedRunService & { relativeDir: string }>> {
  const candidates: Array<{ dir: string; relativeDir: string }> = [{ dir: rootFolder, relativeDir: '.' }];
  try {
    const entries = await readdir(rootFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        candidates.push({ dir: path.join(rootFolder, entry.name), relativeDir: entry.name });
      }
    }
  } catch {
    return [];
  }

  const proposals: Array<ProposedRunService & { relativeDir: string }> = [];
  for (const candidate of candidates) {
    const packageJson = await readFile(path.join(candidate.dir, 'package.json'), 'utf8').catch(() => undefined);
    if (packageJson) {
      const proposed = proposeNodeRunService(packageJson);
      if (proposed) proposals.push({ ...proposed, relativeDir: candidate.relativeDir });
    }
    const launchSettings = await readFile(path.join(candidate.dir, 'Properties', 'launchSettings.json'), 'utf8').catch(() => undefined);
    if (launchSettings) {
      const proposed = proposeDotnetRunService(launchSettings);
      if (proposed) proposals.push({ ...proposed, relativeDir: candidate.relativeDir });
    }
  }
  return proposals;
}

export function registerRunProfileIpc(): void {
  ipcMain.handle(
    'projects:getRunProfile',
    async (_event, projectId: string): Promise<{ profile?: RunProfile; issues: RunProfileIssue[] }> => {
      const folder = projectFolder(projectId);
      if (!folder) return { issues: [] };
      return readRunProfile(folder);
    }
  );

  ipcMain.handle('projects:saveRunProfile', async (_event, projectId: string, profile: RunProfile): Promise<void> => {
    const folder = projectFolder(projectId);
    if (!folder) throw new Error('This project has no working folder to store a run profile in.');
    await writeRunProfile(folder, profile);
  });

  ipcMain.handle('projects:validateRunProfile', (_event, profile: RunProfile): RunProfileValidationResult => validateRunProfile(profile));

  ipcMain.handle(
    'projects:discoverRunServices',
    async (_event, projectId: string): Promise<Array<ProposedRunService & { relativeDir: string }>> => {
      const folder = projectFolder(projectId);
      if (!folder) return [];
      return discoverRunServices(folder);
    }
  );
}
