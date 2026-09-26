import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Ensures child processes launched by Praxis inherit the user's interactive
 * login shell PATH on macOS and Linux.
 *
 * When an Electron app is installed and launched by the OS (via macOS launchd /
 * Finder or Linux desktop runners), the OS passes a minimal default system PATH
 * (e.g. `/usr/bin:/bin:/usr/sbin:/sbin` on macOS). User-installed package
 * managers (Homebrew in `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin`
 * on Intel, NVM, FNM, Volta, Cargo, etc.) are only configured in the user's
 * shell startup scripts (.zprofile, .zshrc, .bash_profile).
 *
 * Without resolving the shell PATH, spawning tools like `npm`, `npx`, `pnpm`,
 * or `yarn` fails with `ENOENT`.
 */

let pathInitialized = false;

const MARKER_START = '__PRAXIS_PATH_START__';
const MARKER_END = '__PRAXIS_PATH_END__';

const WELL_KNOWN_MAC_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];

const WELL_KNOWN_LINUX_PATHS = [
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];

/**
 * Discovers candidate paths for installed developer tools and version managers.
 */
export function getCandidateToolPaths(home: string): string[] {
  const paths: string[] = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.yarn', 'bin')
  ];

  // NVM active/installed node paths
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
      for (const ver of versions) {
        paths.push(path.join(nvmVersionsDir, ver, 'bin'));
      }
    }
  } catch {
    // Ignore read errors
  }

  // FNM / Volta / asdf
  paths.push(path.join(home, '.fnm', 'current', 'bin'));
  paths.push(path.join(home, '.volta', 'bin'));
  paths.push(path.join(home, '.asdf', 'shims'));

  return paths;
}

/**
 * Resolves the user's interactive login shell PATH.
 */
export function resolveShellPath(customShell?: string): string | undefined {
  if (process.platform === 'win32') {
    return process.env.PATH;
  }

  const shell = customShell
    || process.env.SHELL
    || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

  if (!shell) {
    return undefined;
  }

  try {
    // -i: interactive (evaluates .zshrc / .bashrc)
    // -l: login (evaluates .zprofile / .bash_profile)
    // -c: run command
    const script = `echo -n ${MARKER_START}; printenv PATH; echo -n ${MARKER_END}`;
    const output = execFileSync(shell, ['-ilc', script], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        CI: '1'
      }
    });

    const start = output.indexOf(MARKER_START);
    const end = output.indexOf(MARKER_END);
    if (start !== -1 && end > start) {
      const extracted = output.slice(start + MARKER_START.length, end).trim();
      if (extracted.length > 0) {
        return extracted;
      }
    }
  } catch {
    // Shell execution failed, timed out, or shell not found; fallback paths will be used
  }

  return undefined;
}

export interface EnsureEnvironmentPathOptions {
  force?: boolean;
  shellPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  initialPath?: string;
}

/**
 * Updates `process.env.PATH` to include the user's shell environment and well-known tool directories.
 * Returns the effective resolved PATH string.
 */
export function ensureEnvironmentPath(options?: EnsureEnvironmentPathOptions): string {
  if (pathInitialized && !options?.force) {
    return process.env.PATH ?? '';
  }
  pathInitialized = true;

  const currentPlatform = options?.platform ?? process.platform;
  if (currentPlatform === 'win32') {
    return process.env.PATH ?? '';
  }

  const home = options?.homeDir ?? os.homedir();
  const currentPath = options?.initialPath !== undefined ? options.initialPath : (process.env.PATH ?? '');
  const currentEntries = currentPath.split(path.delimiter).filter(Boolean);

  const resolved = options?.shellPath !== undefined ? options.shellPath : resolveShellPath();
  const shellEntries = resolved ? resolved.split(path.delimiter).filter(Boolean) : [];

  const wellKnown = currentPlatform === 'darwin' ? WELL_KNOWN_MAC_PATHS : WELL_KNOWN_LINUX_PATHS;
  const userTools = getCandidateToolPaths(home);
  const fallbackCandidates = [...wellKnown, ...userTools].filter(dir => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });

  // Priority:
  // 1. Shell-resolved PATH entries (user's explicit terminal configuration)
  // 2. Existing process.env.PATH entries
  // 3. Fallback well-known / user tool directories that exist on disk
  const combined = new Set<string>();

  for (const entry of shellEntries) {
    const trimmed = entry.trim();
    if (trimmed) combined.add(trimmed);
  }

  for (const entry of currentEntries) {
    const trimmed = entry.trim();
    if (trimmed) combined.add(trimmed);
  }

  for (const entry of fallbackCandidates) {
    const trimmed = entry.trim();
    if (trimmed) combined.add(trimmed);
  }

  const effectivePath = Array.from(combined).join(path.delimiter);
  process.env.PATH = effectivePath;

  return effectivePath;
}
