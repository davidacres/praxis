#!/usr/bin/env node
/**
 * Reset Praxis workspace/project persistence for local testing.
 *
 * This intentionally does not remove the whole Electron profile, settings,
 * credentials, or portable workspace files in repositories unless explicitly
 * requested. Use --user-data-dir when testing with a custom Electron profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  console.log(`Usage:
  node scripts/reset-praxis-workspace-data.mjs --dry-run
  node scripts/reset-praxis-workspace-data.mjs --confirm
  node scripts/reset-praxis-workspace-data.mjs --confirm --include-located
  node scripts/reset-praxis-workspace-data.mjs --confirm --user-data-dir /path/to/profile

Default reset removes from Electron userData:
  workspaces.json, workspace-locations.json, projects.json, projects/

--include-located also removes the .workspace.praxis files registered in
workspace-locations.json. Without it, those repository files are preserved.
`);
}

function defaultUserDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Praxis');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Praxis');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Praxis');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const confirm = args.includes('--confirm');
const dryRun = args.includes('--dry-run');
const includeLocated = args.includes('--include-located');
const userDataIndex = args.indexOf('--user-data-dir');
const userDataDir = userDataIndex >= 0 ? args[userDataIndex + 1] : defaultUserDataDir();

if (userDataIndex >= 0 && (!userDataDir || userDataDir.startsWith('--'))) {
  console.error('Missing value for --user-data-dir.');
  process.exit(2);
}
if (!confirm && !dryRun) {
  console.error('Refusing to delete data without --confirm. Use --dry-run to preview targets.');
  usage();
  process.exit(2);
}

const resolvedUserDataDir = path.resolve(userDataDir);
const targets = [
  path.join(resolvedUserDataDir, 'workspaces.json'),
  path.join(resolvedUserDataDir, 'workspace-locations.json'),
  path.join(resolvedUserDataDir, 'projects')
];
const projectFile = path.join(resolvedUserDataDir, 'projects.json');
targets.splice(2, 0, projectFile);

if (includeLocated) {
  const registryPath = path.join(resolvedUserDataDir, 'workspace-locations.json');
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const locations = Array.isArray(registry?.['praxis.workspaceLocations.v1'])
      ? registry['praxis.workspaceLocations.v1'] : [];
    for (const location of locations) {
      if (typeof location?.path === 'string' && path.basename(location.path).endsWith('.workspace.praxis')) {
        targets.push(path.resolve(location.path));
      }
    }
  } catch {
    // A missing or malformed registry is itself removed by the normal reset.
  }
}

const uniqueTargets = [...new Set(targets)];
console.log(`${dryRun ? 'Would remove' : 'Removing'} Praxis workspace/project data from:`);
for (const target of uniqueTargets) console.log(`  ${target}`);

if (dryRun) process.exit(0);

for (const target of uniqueTargets) {
  // All default targets are explicitly under userDataDir. Located files are
  // allowed only through --include-located and must have the exact extension.
  const isUserDataTarget = target === resolvedUserDataDir || target.startsWith(`${resolvedUserDataDir}${path.sep}`);
  const isLocatedWorkspace = includeLocated && path.basename(target).endsWith('.workspace.praxis');
  if (!isUserDataTarget && !isLocatedWorkspace) {
    throw new Error(`Refusing to delete unexpected target: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

console.log('Reset complete. Praxis will recreate the app-owned files on next launch.');
