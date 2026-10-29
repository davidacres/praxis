import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { extractPromptIdentifiers, type FeedbackWorkspaceHints } from '@praxis/core';
import { lookupIndexedSymbols } from './codeIntelligenceIpc';

/**
 * Raw workspace facts for prompt/session feedback (FX-BF-112): the files git
 * reports as changed, the repository's test files, and the folder's npm
 * scripts. Core ranks them against the prompt; this module only gathers them.
 *
 * The composer evaluates on every typing pause, so results are cached per
 * folder for a short while and every git call is bounded.
 */

const CACHE_TTL_MS = 15_000;
const MAX_TRACKED_FILES = 20_000;
const TEST_FILE = /\.(?:spec|test)\.tsx?$/;
const cache = new Map<string, { at: number; hints: Promise<FeedbackWorkspaceHints | undefined> }>();

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

/** `git status --porcelain` paths, made relative to `cwd` (renames keep the new path). */
function parseStatus(output: string, repoRoot: string, cwd: string): string[] {
  const files: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const raw = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
    const relative = nodePath.relative(cwd, nodePath.join(repoRoot, raw)).split(nodePath.sep).join('/');
    if (!relative.startsWith('..')) files.push(relative);
  }
  return files;
}

async function readScripts(cwd: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await fsp.readFile(nodePath.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return Object.keys(manifest.scripts ?? {});
  } catch {
    return [];
  }
}

async function gather(folder: string): Promise<FeedbackWorkspaceHints | undefined> {
  // git reports the real path (macOS: /var → /private/var), so compare against the real folder
  const cwd = await fsp.realpath(folder).catch(() => folder);
  const repoRoot = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const [status, tests, packageScripts] = await Promise.all([
    repoRoot ? git(cwd, ['status', '--porcelain', '--untracked-files=all']) : Promise.resolve(''),
    repoRoot ? git(cwd, ['ls-files']) : Promise.resolve(''),
    readScripts(cwd)
  ]);
  const changedFiles = repoRoot ? parseStatus(status, repoRoot, cwd) : [];
  const trackedFiles = tests.split('\n').map(line => line.trim()).filter(Boolean).slice(0, MAX_TRACKED_FILES);
  const testFiles = trackedFiles.filter(file => TEST_FILE.test(file));
  if (changedFiles.length === 0 && trackedFiles.length === 0 && packageScripts.length === 0) return undefined;
  return { changedFiles, testFiles, packageScripts, trackedFiles };
}

/**
 * Workspace hints plus, when the prompt names code identifiers, their exact-name
 * lookups in the folder's code index (skipped silently when the index is off or absent).
 */
export async function getFeedbackWorkspaceHints(
  workingDirectory: string | undefined,
  promptText = ''
): Promise<FeedbackWorkspaceHints | undefined> {
  const [hints, symbols] = await Promise.all([
    folderHints(workingDirectory),
    lookupIndexedSymbols(workingDirectory, extractPromptIdentifiers(promptText)).catch(() => undefined)
  ]);
  if (!hints) return undefined;
  return symbols?.length ? { ...hints, symbols } : hints;
}

function folderHints(workingDirectory: string | undefined): Promise<FeedbackWorkspaceHints | undefined> {
  const cwd = workingDirectory?.trim();
  if (!cwd) return Promise.resolve(undefined);
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hints;
  const hints = gather(cwd).catch(() => undefined);
  cache.set(cwd, { at: Date.now(), hints });
  return hints;
}
