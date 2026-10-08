import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  buildContextSnapshot,
  snapshotManifest,
  type AgentSessionRecord,
  type ContextSnapshot,
  type ContextSnapshotManifest,
  type SnapshotFileFact
} from '@praxis/core';

/**
 * The host half of a context snapshot (FX-BE-092): reads the session's Git state and
 * the files it touched, asks core what belongs in the snapshot, and persists it as a
 * manifest-linked JSON file — the evidence a handover points at. Electron-free, so it
 * is tested against a real repository.
 */

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await run('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return undefined;
  }
}

async function fact(root: string, relative: string, reason: SnapshotFileFact['reason']): Promise<SnapshotFileFact> {
  const absolute = path.resolve(root, relative);
  const fromRoot = path.relative(root, absolute);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return { path: relative, reason, outside: true };
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return { path: fromRoot, reason };
    const handle = await fs.open(absolute, 'r');
    try {
      const head = Buffer.alloc(Math.min(8192, stat.size));
      await handle.read(head, 0, head.length, 0);
      return { path: fromRoot, reason, bytes: stat.size, binary: head.includes(0) };
    } finally {
      await handle.close();
    }
  } catch {
    return { path: fromRoot, reason };
  }
}

/** The session's working tree right now: the commit, branch and changed paths. */
export async function readWorkspaceGit(root: string): Promise<{ head?: string; branch?: string; dirty: boolean; changed: string[] }> {
  const head = (await git(root, ['rev-parse', 'HEAD']))?.trim() || undefined;
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || undefined;
  const status = (await git(root, ['status', '--porcelain', '--untracked-files=all'])) ?? '';
  const changed = status
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
  return { ...(head ? { head } : {}), ...(branch && branch !== 'HEAD' ? { branch } : {}), dirty: changed.length > 0, changed };
}

export async function takeContextSnapshot(
  record: Pick<AgentSessionRecord, 'issueKey' | 'workingDirectory' | 'worktreePath' | 'handoverBrief' | 'taskDefinition'>,
  storeRoot: string,
  now = new Date().toISOString()
): Promise<{ snapshot: ContextSnapshot; manifest?: ContextSnapshotManifest; head?: string }> {
  const root = record.worktreePath || record.workingDirectory;
  const gitState = root ? await readWorkspaceGit(root) : { dirty: false, changed: [] as string[] };
  const files: SnapshotFileFact[] = root
    ? [
        ...(await Promise.all((record.handoverBrief?.touchedFiles ?? []).map(file => fact(root, file, 'touched')))),
        ...(await Promise.all(gitState.changed.map(file => fact(root, file, 'changed'))))
      ]
    : [];
  const snapshot = buildContextSnapshot({
    sessionKey: record.issueKey,
    createdAt: now,
    git: gitState,
    ...(root ? { workspace: root } : {}),
    files,
    ticketContext: record.taskDefinition?.ticketContext
  });
  try {
    const dir = path.join(storeRoot, 'handover-snapshots', record.issueKey.replace(/[^A-Za-z0-9._-]/g, '_'));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${now.replace(/[:.]/g, '-')}-${snapshot.fingerprint.slice(0, 12)}.json`);
    await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return { snapshot, manifest: snapshotManifest(snapshot, file), ...(gitState.head ? { head: gitState.head } : {}) };
  } catch {
    // A snapshot that could not be persisted still travels in the handover; it just has no evidence file.
    return { snapshot, ...(gitState.head ? { head: gitState.head } : {}) };
  }
}
