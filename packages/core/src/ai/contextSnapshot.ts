/**
 * Bounded context snapshots and handover validation (FX-BE-092 / TASK-254, TASK-256).
 *
 * A handover envelope (`sessionHandover.ts`) tells the next AI what the last one
 * concluded. It did not say *what the work stood on*: the commit it was looking at,
 * which files it was handed and which it was deliberately not, and what the task
 * depends on. Without that a second provider resumes against whatever the tree
 * happens to hold, and a handover built against a commit that has since moved is
 * indistinguishable from a current one.
 *
 * A `ContextSnapshot` records exactly that — source commit, included and excluded
 * files with the reason for each, dependencies, and the generator that built it —
 * bounded so it can never become the prompt. `validateHandover` checks an envelope
 * and its snapshot before a handover is allowed to proceed, and names what is wrong.
 *
 * Pure: the desktop gathers Git facts and file sizes; this decides what goes in.
 */

import { createHash } from 'node:crypto';
import type { HandoverEnvelope } from './sessionHandover';

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1;
/** Bumped whenever what a snapshot includes, or how it decides, changes. */
export const CONTEXT_SNAPSHOT_GENERATOR = 'praxis-context-snapshot@1';

/** At most this many files are listed as included; the rest are excluded with reason `limit`. */
export const SNAPSHOT_MAX_FILES = 40;
/** A file larger than this is excluded as `too-large` — the next AI can open it itself. */
export const SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;

export type SnapshotFileReason = 'touched' | 'declared' | 'changed';
export type SnapshotExclusionReason = 'secret' | 'too-large' | 'binary' | 'outside-workspace' | 'missing' | 'limit';

export interface ContextSnapshot {
  schemaVersion: number;
  generator: string;
  createdAt: string;
  sessionKey: string;
  /** The commit the work stood on when the snapshot was taken. Absent outside a Git repository. */
  sourceCommit?: string;
  branch?: string;
  /** Uncommitted changes existed at snapshot time — the commit alone is not the whole picture. */
  dirty?: boolean;
  workspace?: string;
  includedFiles: Array<{ path: string; reason: SnapshotFileReason; bytes?: number }>;
  excludedFiles: Array<{ path: string; reason: SnapshotExclusionReason }>;
  /** Issue keys the task depends on, from its ticket context. */
  dependencies: string[];
  /** Hash over everything above, so two snapshots of the same state compare equal. */
  fingerprint: string;
}

/** A candidate file as the host found it. */
export interface SnapshotFileFact {
  path: string;
  reason: SnapshotFileReason;
  /** Absent when the file does not exist (deleted, or a path that never existed). */
  bytes?: number;
  binary?: boolean;
  /** Resolved outside the session's workspace. */
  outside?: boolean;
}

const SECRET_PATH = /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|keystore)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

/** Issue keys under a "depends on" / "blocked by" heading or line of a ticket context. */
export function extractDependencyKeys(ticketContext: string | undefined): string[] {
  if (!ticketContext) return [];
  const keys = new Set<string>();
  let inSection = false;
  for (const line of ticketContext.split('\n')) {
    const heading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?\s*$/.test(line.trim());
    const mentions = /\b(depend\w*|blocked by|blockers?|prerequisites?)\b/i.test(line);
    if (heading) inSection = mentions;
    if (inSection || mentions) for (const match of line.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) keys.add(match[0]);
  }
  return [...keys].sort();
}

export function buildContextSnapshot(input: {
  sessionKey: string;
  createdAt: string;
  git?: { head?: string; branch?: string; dirty?: boolean };
  workspace?: string;
  files: readonly SnapshotFileFact[];
  ticketContext?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}): ContextSnapshot {
  const maxFiles = input.maxFiles ?? SNAPSHOT_MAX_FILES;
  const maxBytes = input.maxFileBytes ?? SNAPSHOT_MAX_FILE_BYTES;
  const included: ContextSnapshot['includedFiles'] = [];
  const excluded: ContextSnapshot['excludedFiles'] = [];
  const seen = new Set<string>();
  // Declared paths first, then touched, then merely changed: the ones the task is about win the budget.
  const order: Record<SnapshotFileReason, number> = { declared: 0, touched: 1, changed: 2 };
  const files = [...input.files].sort((left, right) => order[left.reason] - order[right.reason] || left.path.localeCompare(right.path));
  for (const file of files) {
    const filePath = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const exclusion: SnapshotExclusionReason | undefined =
      SECRET_PATH.test(filePath) ? 'secret'
        : file.outside || filePath.startsWith('../') || filePath.startsWith('/') ? 'outside-workspace'
          : file.bytes === undefined ? 'missing'
            : file.binary ? 'binary'
              : file.bytes > maxBytes ? 'too-large'
                : included.length >= maxFiles ? 'limit'
                  : undefined;
    if (exclusion) excluded.push({ path: filePath, reason: exclusion });
    else included.push({ path: filePath, reason: file.reason, bytes: file.bytes });
  }
  const body = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    generator: CONTEXT_SNAPSHOT_GENERATOR,
    sessionKey: input.sessionKey,
    ...(input.git?.head ? { sourceCommit: input.git.head } : {}),
    ...(input.git?.branch ? { branch: input.git.branch } : {}),
    ...(input.git?.dirty ? { dirty: true } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
    includedFiles: included,
    excludedFiles: excluded,
    dependencies: extractDependencyKeys(input.ticketContext)
  };
  // `createdAt` is left out of the fingerprint: the same state snapshotted twice is the same context.
  const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, createdAt: input.createdAt, fingerprint };
}

/** The snapshot as the next AI reads it, inside the handover text. */
export function formatContextSnapshot(snapshot: ContextSnapshot): string {
  const lines = [
    '## Context snapshot',
    `Generated by ${snapshot.generator} (${snapshot.fingerprint.slice(0, 12)}).`,
    snapshot.sourceCommit
      ? `Source commit: ${snapshot.sourceCommit}${snapshot.branch ? ` on ${snapshot.branch}` : ''}${snapshot.dirty ? ' (with uncommitted changes)' : ''}. Check out or diff against it before trusting anything below.`
      : 'Not a Git repository: there is no commit to anchor this context to.',
    snapshot.includedFiles.length
      ? `Files to read first:\n${snapshot.includedFiles.map(file => `- ${file.path} (${file.reason})`).join('\n')}`
      : 'No files were handed over.',
    snapshot.excludedFiles.length
      ? `Deliberately left out:\n${snapshot.excludedFiles.map(file => `- ${file.path} (${file.reason})`).join('\n')}`
      : '',
    snapshot.dependencies.length ? `Depends on: ${snapshot.dependencies.join(', ')}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

export interface HandoverIssue {
  /** `block` stops the handover; `warn` is shown but lets it proceed. */
  level: 'block' | 'warn';
  message: string;
}

const SECRET_VALUE = /\b(ghp|gho|github_pat|glpat|sk-ant|sk-)[A-Za-z0-9_-]{16,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Checks a handover before it is allowed to proceed. A malformed envelope, a
 * snapshot from another session or generator, a commit that has moved on, or a
 * secret that survived redaction blocks it with the reason; softer gaps warn.
 */
export function validateHandover(
  envelope: Pick<HandoverEnvelope, 'purpose' | 'brief' | 'text'>,
  snapshot: ContextSnapshot | undefined,
  current: { sessionKey: string; head?: string }
): HandoverIssue[] {
  const issues: HandoverIssue[] = [];
  const block = (message: string) => issues.push({ level: 'block', message });
  const warn = (message: string) => issues.push({ level: 'warn', message });

  if (!envelope.purpose?.goal?.trim()) block('The handover has no goal: the next AI would not know what it is continuing.');
  const brief = envelope.brief as unknown as Record<string, unknown> | undefined;
  if (!brief || typeof brief !== 'object') block('The handover brief is missing.');
  else {
    for (const field of ['progress', 'nextSteps'] as const) {
      if (typeof brief[field] !== 'string') block(`The handover brief's "${field}" is not text.`);
    }
    if (!Array.isArray(brief.touchedFiles)) block('The handover brief\'s touched files are not a list.');
    if (typeof brief.nextSteps === 'string' && !brief.nextSteps.trim()) warn('The brief names no next steps; the next AI will have to work them out.');
  }
  if (!envelope.text?.trim()) block('The handover text is empty.');
  else if (SECRET_VALUE.test(envelope.text)) block('The handover text still contains something that looks like a secret; remove it from the brief before handing over.');

  if (!snapshot) {
    block('The handover has no context snapshot.');
    return issues;
  }
  if (snapshot.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) block(`The context snapshot is schema ${snapshot.schemaVersion}; this build reads ${CONTEXT_SNAPSHOT_SCHEMA_VERSION}.`);
  if (snapshot.generator !== CONTEXT_SNAPSHOT_GENERATOR) block(`The context snapshot was made by ${snapshot.generator}, not ${CONTEXT_SNAPSHOT_GENERATOR}.`);
  if (snapshot.sessionKey !== current.sessionKey) block('The context snapshot belongs to a different session.');
  if (current.head && snapshot.sourceCommit && current.head !== snapshot.sourceCommit) {
    block(`The work has moved since the snapshot (${snapshot.sourceCommit.slice(0, 7)} → ${current.head.slice(0, 7)}); take a new snapshot.`);
  }
  if (!snapshot.sourceCommit) warn('The snapshot has no source commit, so the next AI cannot check what changed since.');
  const leaked = snapshot.includedFiles.find(file => SECRET_PATH.test(file.path));
  if (leaked) block(`The snapshot hands over ${leaked.path}, which looks like a secrets file.`);
  return issues;
}

/** A manifest entry recording where a snapshot was persisted, for the session's evidence. */
export interface ContextSnapshotManifest {
  sessionKey: string;
  createdAt: string;
  fingerprint: string;
  sourceCommit?: string;
  path: string;
  included: number;
  excluded: number;
}

export function snapshotManifest(snapshot: ContextSnapshot, storedAt: string): ContextSnapshotManifest {
  return {
    sessionKey: snapshot.sessionKey,
    createdAt: snapshot.createdAt,
    fingerprint: snapshot.fingerprint,
    ...(snapshot.sourceCommit ? { sourceCommit: snapshot.sourceCommit } : {}),
    path: storedAt,
    included: snapshot.includedFiles.length,
    excluded: snapshot.excludedFiles.length
  };
}
