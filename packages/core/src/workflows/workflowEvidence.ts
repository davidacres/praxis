/**
 * Failure evidence identity and storage (FX-BE-051 / TASK-132).
 *
 * A workflow node attempt can fail in ways a declared `WorkflowArtifactContract`
 * was never built for: a check that times out, or one whose process never
 * starts, produces no artifact at all under that model — the moment evidence
 * matters most is the moment `WorkflowNodeState.artifacts` stays empty. An
 * evidence bundle is the retained record of what actually happened during one
 * attempt, independent of whether the stage produced enough to report a
 * contract output. Wiring capture into the check runner for a real timeout or
 * spawn failure is TASK-133; this module defines the bundle it will write.
 *
 * Three properties the acceptance criteria hold this to:
 *
 * - **Missing is not empty.** A command that legitimately printed nothing and a
 *   capture that crashed before writing anything must never look the same —
 *   only the second is `missing`, and it must say why. Collapsing the two would
 *   show "no output" for a failure that has evidence nobody wrote down.
 * - **Unknown is not omitted.** Every bundle names the commit it was captured
 *   against; when that cannot be determined (no repository, an uninitialised
 *   worktree) the source is the explicit `{ kind: 'unknown' }` value, never an
 *   absent field — diagnosis must never assume HEAD for a bundle that never
 *   said so.
 * - **A bundle cannot smuggle another project's evidence, or escape its own
 *   directory.** `validateEvidenceBundle` checks both: the bundle's identity
 *   against an expected project, and every entry's stored path against the
 *   bare-filename shape `writeEvidenceBundle`/`readEvidenceContent` require.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowIssue } from './workflowValidation';

export const WORKFLOW_EVIDENCE_SCHEMA_VERSION = 1;

/** Enough for a full check log without unbounded growth; the tail survives truncation. */
export const DEFAULT_EVIDENCE_MAX_BYTES = 200_000;
export const DEFAULT_EVIDENCE_RETENTION_DAYS = 30;

export type WorkflowEvidenceKind = 'log' | 'test-results' | 'attachment';

/**
 * Whether stored content exists, is deliberately empty, or was never captured.
 * See the module doc — collapsing `missing` into `empty` is the bug this type
 * exists to prevent.
 */
export type WorkflowEvidencePresence = 'present' | 'empty' | 'missing';

/** The commit an evidence bundle was captured against, explicit when unknown. */
export type WorkflowEvidenceSourceRef = { kind: 'commit'; sha: string } | { kind: 'unknown' };

export interface WorkflowEvidenceRetention {
  policy: 'default' | 'legal-hold';
  /** ISO timestamp after which the store may reclaim this bundle. Absent under legal-hold. */
  expiresAt?: string;
}

/** One piece of retained evidence: a log, a test-results report, or an attachment. */
export interface WorkflowEvidenceEntry {
  evidenceId: string;
  kind: WorkflowEvidenceKind;
  /** Unique within its bundle — e.g. 'stdout', 'combined', 'junit-report'. */
  label: string;
  presence: WorkflowEvidencePresence;
  capturedAt: string;
  /** A bare filename, resolved under the bundle's own directory. Set only when presence is 'present'. */
  path?: string;
  storedBytes?: number;
  /** The size before truncation, when known and larger than storedBytes. */
  originalBytes?: number;
  truncated: boolean;
  /** Whether content was redacted before storage — set before evidence ever reaches a model. */
  redacted: boolean;
  retention: WorkflowEvidenceRetention;
  /** Required when presence is 'missing' — why nothing was captured. */
  missingReason?: string;
}

/** Identifies one bundle: the attempt it belongs to. */
export interface WorkflowEvidenceBundleKey {
  projectId: string;
  runId: string;
  nodeId: string;
  /** 1-based, matching `WorkflowNodeAttempt.attempt`. */
  attempt: number;
}

/** A versioned bundle of evidence for one node attempt, keyed by project, run, node, attempt and source commit. */
export interface WorkflowEvidenceBundle extends WorkflowEvidenceBundleKey {
  schemaVersion: number;
  /** Derived — see `evidenceBundleId`. Never assigned independently. */
  bundleId: string;
  source: WorkflowEvidenceSourceRef;
  createdAt: string;
  entries: WorkflowEvidenceEntry[];
}

// ── Identity ─────────────────────────────────────────────────────────────

/** Deterministic id: re-capturing the same attempt overwrites rather than duplicates. */
export function evidenceBundleId(key: WorkflowEvidenceBundleKey): string {
  return `${key.runId}-${key.nodeId}-${key.attempt}`;
}

export function commitEvidenceSource(sha: string): WorkflowEvidenceSourceRef {
  return { kind: 'commit', sha };
}

export function unknownEvidenceSource(): WorkflowEvidenceSourceRef {
  return { kind: 'unknown' };
}

export function createEvidenceBundle(input: {
  key: WorkflowEvidenceBundleKey;
  source: WorkflowEvidenceSourceRef;
  createdAt: string;
  entries?: WorkflowEvidenceEntry[];
}): WorkflowEvidenceBundle {
  return {
    schemaVersion: WORKFLOW_EVIDENCE_SCHEMA_VERSION,
    bundleId: evidenceBundleId(input.key),
    projectId: input.key.projectId,
    runId: input.key.runId,
    nodeId: input.key.nodeId,
    attempt: input.key.attempt,
    source: input.source,
    createdAt: input.createdAt,
    entries: input.entries ?? []
  };
}

/** Adds or replaces (by label) one entry. Pure, so capturing twice for one label is idempotent. */
export function withEvidenceEntry(bundle: WorkflowEvidenceBundle, entry: WorkflowEvidenceEntry): WorkflowEvidenceBundle {
  const index = bundle.entries.findIndex(existing => existing.label === entry.label);
  const entries = [...bundle.entries];
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  return { ...bundle, entries };
}

// ── Retention ────────────────────────────────────────────────────────────

export function defaultEvidenceRetention(capturedAt: string, days: number = DEFAULT_EVIDENCE_RETENTION_DAYS): WorkflowEvidenceRetention {
  const capturedMs = Date.parse(capturedAt);
  const base = Number.isNaN(capturedMs) ? Date.now() : capturedMs;
  return { policy: 'default', expiresAt: new Date(base + days * 24 * 60 * 60 * 1000).toISOString() };
}

export function legalHoldEvidenceRetention(): WorkflowEvidenceRetention {
  return { policy: 'legal-hold' };
}

export function isEvidenceExpired(retention: WorkflowEvidenceRetention, now: string = new Date().toISOString()): boolean {
  if (retention.policy === 'legal-hold' || !retention.expiresAt) return false;
  return Date.parse(retention.expiresAt) <= Date.parse(now);
}

// ── Capture ──────────────────────────────────────────────────────────────

export interface CaptureEvidenceInput {
  bundleId: string;
  kind: WorkflowEvidenceKind;
  label: string;
  capturedAt: string;
  /**
   * `undefined` means the capture itself failed — e.g. the process never
   * started, or writing output crashed — so presence becomes `missing`. An
   * empty string means the command ran and legitimately produced nothing;
   * presence becomes `empty`. These are never the same thing.
   */
  content: string | undefined;
  /** Required when `content` is undefined; ignored otherwise. */
  missingReason?: string;
  maxBytes?: number;
  redacted?: boolean;
  retention?: WorkflowEvidenceRetention;
}

/** Builds one entry (and, when present, the content to store) from raw captured output. */
export function captureEvidenceEntry(input: CaptureEvidenceInput): { entry: WorkflowEvidenceEntry; content?: string } {
  const evidenceId = `${input.bundleId}-${input.label}`;
  const retention = input.retention ?? defaultEvidenceRetention(input.capturedAt);
  const redacted = input.redacted ?? false;
  const base = {
    evidenceId,
    kind: input.kind,
    label: input.label,
    capturedAt: input.capturedAt,
    redacted,
    retention
  };

  if (input.content === undefined) {
    return {
      entry: {
        ...base,
        presence: 'missing',
        truncated: false,
        missingReason: input.missingReason?.trim() || 'Not captured.'
      }
    };
  }

  if (input.content.length === 0) {
    return { entry: { ...base, presence: 'empty', truncated: false } };
  }

  const maxBytes = input.maxBytes ?? DEFAULT_EVIDENCE_MAX_BYTES;
  const originalBytes = Buffer.byteLength(input.content, 'utf8');
  const truncated = originalBytes > maxBytes;
  const stored = truncated ? truncateUtf8Tail(input.content, maxBytes) : input.content;
  const storedBytes = Buffer.byteLength(stored, 'utf8');

  return {
    entry: {
      ...base,
      presence: 'present',
      path: evidenceFileName(input.label),
      storedBytes,
      originalBytes,
      truncated
    },
    content: stored
  };
}

/** Keeps the tail: for a failing command, the signal a person needs to act is usually at the end. */
function truncateUtf8Tail(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;
  let start = buf.length - maxBytes;
  // Never split a multi-byte UTF-8 sequence: back off to the next character boundary.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return `…${buf.subarray(start).toString('utf8')}`;
}

function evidenceFileName(label: string): string {
  const safe = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'entry'}.txt`;
}

// ── Redaction ────────────────────────────────────────────────────────────

/**
 * `key = value` / `key: "value"` assignments for secret-shaped names — the
 * same vocabulary `workspaceTypes.ts`'s `SECRET_SETTING_PATTERN` uses for
 * settings fields, applied here to free-text log lines instead. Keeps the key
 * so the log still reads (`API_KEY=[REDACTED]`, not a blank line).
 */
const ASSIGNMENT_SECRET = /\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(["']?)([^\s"',]{4,})\2/gi;
const BEARER_TOKEN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{10,})/g;
/** Bare secrets with a recognisable shape — the whole match is replaced, there is no key to keep. */
const BARE_SECRETS = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub personal/app tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

/**
 * Pattern-based redaction applied before evidence is captured — a check's raw
 * stdout/stderr can echo a secret from the environment or a failing command
 * line, and this is what stands between that and either a person's screen or,
 * eventually, a diagnosis agent's prompt (FX-BE-052). Best-effort by design:
 * it catches recognisable shapes, not everything a determined secret could
 * look like — never treat `redacted: false` as a proof the content is clean.
 */
export function redactEvidenceContent(content: string): { content: string; redacted: boolean } {
  let redacted = false;
  let result = content.replace(ASSIGNMENT_SECRET, (_match, prefix: string, quote: string) => {
    redacted = true;
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  result = result.replace(BEARER_TOKEN, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}[REDACTED]`;
  });
  for (const pattern of BARE_SECRETS) {
    result = result.replace(pattern, () => {
      redacted = true;
      return '[REDACTED]';
    });
  }
  return { content: result, redacted };
}

// ── Validation ───────────────────────────────────────────────────────────

const EVIDENCE_KINDS = new Set<WorkflowEvidenceKind>(['log', 'test-results', 'attachment']);
const EVIDENCE_PRESENCE = new Set<WorkflowEvidencePresence>(['present', 'empty', 'missing']);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && SAFE_SEGMENT.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isValidSource(value: unknown): value is WorkflowEvidenceSourceRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'unknown') return true;
  return candidate.kind === 'commit' && typeof candidate.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(candidate.sha);
}

/**
 * Fails closed, matching `workflowValidation.ts`: a bundle that cannot be
 * proven safe is rejected rather than partially trusted. Pass `expected` when
 * a bundle is being read or written against a specific project's evidence
 * store, so a bundle that names a different project is refused rather than
 * silently attributed to the caller's project.
 */
export function validateEvidenceBundle(bundle: WorkflowEvidenceBundle, expected?: { projectId?: string }): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];

  if (bundle.schemaVersion !== WORKFLOW_EVIDENCE_SCHEMA_VERSION) {
    issues.push({ path: 'schemaVersion', message: `Unsupported evidence schema version ${bundle.schemaVersion}.` });
  }

  const identityFields: Array<[string, unknown]> = [
    ['projectId', bundle.projectId],
    ['runId', bundle.runId],
    ['nodeId', bundle.nodeId]
  ];
  for (const [field, value] of identityFields) {
    if (!isSafeSegment(value)) {
      issues.push({ path: field, message: `${field} must be a safe non-empty identifier (letters, digits, dot, underscore, hyphen).` });
    }
  }
  if (!Number.isInteger(bundle.attempt) || bundle.attempt < 1) {
    issues.push({ path: 'attempt', message: 'attempt must be a positive integer.' });
  }

  if (issues.length === 0) {
    const expectedId = evidenceBundleId(bundle);
    if (bundle.bundleId !== expectedId) {
      issues.push({ path: 'bundleId', message: `bundleId must be derived as "${expectedId}".` });
    }
  }

  if (expected?.projectId && bundle.projectId !== expected.projectId) {
    issues.push({
      path: 'projectId',
      message: `Evidence bundle belongs to project "${bundle.projectId}", not "${expected.projectId}" — refusing a cross-project reference.`
    });
  }

  if (!isValidSource(bundle.source)) {
    issues.push({ path: 'source', message: 'source must be an explicit commit sha or { kind: "unknown" }.' });
  }

  if (!isValidTimestamp(bundle.createdAt)) {
    issues.push({ path: 'createdAt', message: 'createdAt must be a valid ISO timestamp.' });
  }

  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  bundle.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;

    if (!isNonEmptyString(entry.label)) {
      issues.push({ path: `${at}.label`, message: 'label is required.' });
    } else if (seenLabels.has(entry.label)) {
      issues.push({ path: `${at}.label`, message: `Duplicate evidence label "${entry.label}" within one bundle.` });
    } else {
      seenLabels.add(entry.label);
    }

    if (!isNonEmptyString(entry.evidenceId)) {
      issues.push({ path: `${at}.evidenceId`, message: 'evidenceId is required.' });
    } else if (seenIds.has(entry.evidenceId)) {
      issues.push({ path: `${at}.evidenceId`, message: `Duplicate evidenceId "${entry.evidenceId}".` });
    } else {
      seenIds.add(entry.evidenceId);
    }

    if (!EVIDENCE_KINDS.has(entry.kind)) {
      issues.push({ path: `${at}.kind`, message: `Unknown evidence kind "${entry.kind}".` });
    }
    if (!EVIDENCE_PRESENCE.has(entry.presence)) {
      issues.push({ path: `${at}.presence`, message: `Unknown evidence presence "${entry.presence}".` });
    }

    if (entry.presence === 'present') {
      if (!isSafeSegment(entry.path)) {
        issues.push({ path: `${at}.path`, message: `Evidence path "${String(entry.path)}" is not a safe bare filename.` });
      }
      if (typeof entry.storedBytes !== 'number' || entry.storedBytes < 0) {
        issues.push({ path: `${at}.storedBytes`, message: 'Present evidence must record storedBytes.' });
      }
    } else if (entry.path) {
      issues.push({ path: `${at}.path`, message: `Evidence marked "${entry.presence}" must not carry a stored path.` });
    }

    if (entry.presence === 'missing' && !isNonEmptyString(entry.missingReason)) {
      issues.push({ path: `${at}.missingReason`, message: 'Missing evidence must explain why nothing was captured.' });
    }

    if (entry.truncated) {
      if (entry.originalBytes === undefined || entry.storedBytes === undefined || entry.originalBytes <= entry.storedBytes) {
        issues.push({ path: `${at}.truncated`, message: 'Truncated evidence must record originalBytes greater than storedBytes.' });
      }
    }

    if (!isValidTimestamp(entry.capturedAt)) {
      issues.push({ path: `${at}.capturedAt`, message: 'capturedAt must be a valid ISO timestamp.' });
    }
  });

  return issues;
}

// ── Round trip ───────────────────────────────────────────────────────────

export function serializeEvidenceBundle(bundle: WorkflowEvidenceBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** The read-side counterpart to `serializeEvidenceBundle`. Fails closed on anything unsafe. */
export function parseEvidenceBundle(
  value: unknown,
  expected?: { projectId?: string }
): { bundle?: WorkflowEvidenceBundle; issues: WorkflowIssue[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ path: '', message: 'Evidence bundle must be a JSON object.' }] };
  }
  const raw = value as Record<string, unknown>;
  const bundle: WorkflowEvidenceBundle = {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0,
    bundleId: typeof raw.bundleId === 'string' ? raw.bundleId : '',
    projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
    runId: typeof raw.runId === 'string' ? raw.runId : '',
    nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : '',
    attempt: typeof raw.attempt === 'number' ? raw.attempt : NaN,
    source: (raw.source && typeof raw.source === 'object' ? raw.source : { kind: 'unknown' }) as WorkflowEvidenceSourceRef,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    entries: Array.isArray(raw.entries) ? (raw.entries as WorkflowEvidenceEntry[]) : []
  };

  const issues = validateEvidenceBundle(bundle, expected);
  if (issues.length > 0) return { issues };
  return { bundle, issues: [] };
}

// ── Storage ──────────────────────────────────────────────────────────────

function requireSafeSegment(value: string, field: string): string {
  if (!isSafeSegment(value)) throw new Error(`Unsafe evidence ${field}: ${value}`);
  return value;
}

/**
 * `<storageRoot>/<projectId>/<runId>/<nodeId>/<attempt>/`. Every segment is
 * validated before it is joined, and the joined result is re-checked against
 * the resolved root — the same defence-in-depth `workflowStore.ts` uses for
 * project-committed workflows, applied to identity fields a workflow author
 * controls (`nodeId`) rather than ones the app generates.
 */
export function evidenceBundleDir(storageRoot: string, key: WorkflowEvidenceBundleKey): string {
  const projectSeg = requireSafeSegment(key.projectId, 'projectId');
  const runSeg = requireSafeSegment(key.runId, 'runId');
  const nodeSeg = requireSafeSegment(key.nodeId, 'nodeId');
  if (!Number.isInteger(key.attempt) || key.attempt < 1) {
    throw new Error(`Unsafe evidence attempt: ${key.attempt}`);
  }
  const root = path.resolve(storageRoot);
  const dir = path.join(root, projectSeg, runSeg, nodeSeg, String(key.attempt));
  if (path.relative(root, dir).startsWith('..')) {
    throw new Error(`Resolved evidence directory escapes the storage root: ${dir}`);
  }
  return dir;
}

/**
 * Writes every `present` entry's content alongside a `bundle.json` manifest.
 * Refuses an invalid bundle before touching disk. `content` must carry a value
 * for every entry marked `present`, keyed by label — `captureEvidenceEntry`
 * returns exactly that shape.
 */
export async function writeEvidenceBundle(
  storageRoot: string,
  bundle: WorkflowEvidenceBundle,
  content: ReadonlyMap<string, string>
): Promise<string> {
  const issues = validateEvidenceBundle(bundle, { projectId: bundle.projectId });
  if (issues.length > 0) {
    throw new Error(`Evidence bundle ${bundle.bundleId || '(unnamed)'} is invalid: ${describeIssues(issues)}`);
  }

  const dir = evidenceBundleDir(storageRoot, bundle);
  await mkdir(dir, { recursive: true });

  for (const entry of bundle.entries) {
    if (entry.presence !== 'present') continue;
    const body = content.get(entry.label);
    if (body === undefined) {
      throw new Error(`Missing stored content for evidence entry "${entry.label}".`);
    }
    const filePath = path.join(dir, entry.path as string);
    // entry.path already passed validateEvidenceBundle's safe-segment check; re-checked here too.
    if (path.relative(dir, filePath).startsWith('..')) {
      throw new Error(`Resolved evidence entry path escapes its bundle directory: ${filePath}`);
    }
    await writeFile(filePath, body, 'utf8');
  }

  const manifestPath = path.join(dir, 'bundle.json');
  await writeFile(manifestPath, serializeEvidenceBundle(bundle), 'utf8');
  return manifestPath;
}

/** Reads a bundle's manifest back. A bundle that was never written is not an error — it comes back `undefined`. */
export async function readEvidenceBundle(
  storageRoot: string,
  key: WorkflowEvidenceBundleKey
): Promise<{ bundle?: WorkflowEvidenceBundle; issues: WorkflowIssue[] }> {
  const dir = evidenceBundleDir(storageRoot, key);
  const manifestPath = path.join(dir, 'bundle.json');

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return { issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { issues: [{ path: '', message: `Could not read evidence bundle: ${(error as Error).message}` }] };
  }

  return parseEvidenceBundle(parsed, { projectId: key.projectId });
}

/** Reads one entry's stored content. Refuses anything not marked `present`, or any path that would escape the bundle directory. */
export async function readEvidenceContent(
  storageRoot: string,
  key: WorkflowEvidenceBundleKey,
  entry: WorkflowEvidenceEntry
): Promise<string> {
  if (entry.presence !== 'present' || !isSafeSegment(entry.path)) {
    throw new Error(`Evidence entry "${entry.label}" has no stored content (${entry.presence}).`);
  }
  const dir = evidenceBundleDir(storageRoot, key);
  const filePath = path.join(dir, entry.path);
  if (path.relative(dir, filePath).startsWith('..')) {
    throw new Error(`Resolved evidence entry path escapes its bundle directory: ${filePath}`);
  }
  return readFile(filePath, 'utf8');
}

function describeIssues(issues: WorkflowIssue[]): string {
  return issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ');
}
