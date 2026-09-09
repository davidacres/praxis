/**
 * Scoped browser diagnostics capture (FX-BE-056 / TASK-147).
 *
 * A Run preview (FX-BE-055) is a real web page the user's own service
 * serves — console errors and failed API requests are exactly the signal a
 * person or an agent debugging that service needs, and a screenshot is
 * often the fastest way to confirm a UI actually rendered. This module is
 * the capture-and-storage half: bounded ring buffers (never unbounded
 * growth from a chatty page), redaction on the way in (reusing
 * `workflows/workflowEvidence.ts`'s pattern-based scrubber — the same
 * defence a check's stdout gets), and one bundle per (project, run,
 * service) so nothing captured under one project can be attributed to, or
 * read back as, another's — a project boundary AGENTS.md and this whole
 * story hold as an invariant, not a convenience.
 *
 * Wiring capture into `previewBrowser.ts`'s real `WebContentsView` events
 * (`console-message`, `did-fail-load`, `capturePage()`) is TASK-146's
 * counterpart on the Electron side; this module defines what gets captured
 * and how it's kept, independent of Electron.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeSegment, redactEvidenceContent, truncateUtf8Tail } from '../workflows/workflowEvidence';

export const BROWSER_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const DEFAULT_CONSOLE_BUFFER_SIZE = 200;
export const DEFAULT_NETWORK_BUFFER_SIZE = 200;
/** A single console line or URL/error string, bounded before redaction even runs — a page that logs megabytes must not turn one line into the whole capture budget. */
const MAX_ENTRY_BYTES = 4_000;

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error';

export interface ConsoleDiagnosticEntry {
  level: ConsoleLevel;
  message: string;
  at: string;
  redacted: boolean;
}

export interface NetworkFailureEntry {
  url: string;
  method: string;
  /** An HTTP status that came back at all (e.g. a 500) — absent for a connection-level failure (refused, aborted, DNS). */
  status?: number;
  error?: string;
  at: string;
  redacted: boolean;
}

export interface ScreenshotRecord {
  presence: 'present' | 'missing';
  /** A bare filename this module generated itself — never taken from a caller, so a stored record can't be used to escape its own directory. */
  path?: string;
  capturedAt: string;
  /** Required when presence is 'missing' — matches `WorkflowEvidenceEntry`'s "missing is not omitted" discipline. */
  missingReason?: string;
}

export interface BrowserDiagnosticsBundleKey {
  projectId: string;
  runId: string;
  serviceId: string;
}

export interface BrowserDiagnosticsBundle extends BrowserDiagnosticsBundleKey {
  schemaVersion: number;
  capturedAt: string;
  console: ConsoleDiagnosticEntry[];
  network: NetworkFailureEntry[];
  screenshots: ScreenshotRecord[];
  /** True once the console or network buffer has dropped its oldest entry to stay bounded — tells a reader "there was more than this," rather than letting an incomplete capture look exhaustive. */
  truncated: boolean;
}

/** A bounded ring buffer — pushes past capacity drop the oldest entry and are remembered via `dropped`. */
class BoundedBuffer<T> {
  private items: T[] = [];
  private droppedCount = 0;
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.droppedCount++;
    }
  }
  list(): T[] {
    return [...this.items];
  }
  get dropped(): boolean {
    return this.droppedCount > 0;
  }
}

function redactedText(raw: string): { text: string; redacted: boolean } {
  const { content, redacted } = redactEvidenceContent(truncateUtf8Tail(raw, MAX_ENTRY_BYTES));
  return { text: content, redacted };
}

/**
 * Accumulates console/network/screenshot evidence for one (project, run,
 * service). Each instance owns its own buffers — there is no shared or
 * global state a second recorder could read or be confused with, which is
 * what makes "unrelated browser sessions do not enter attachments" true by
 * construction rather than by a filter applied afterward.
 */
export class BrowserDiagnosticsRecorder {
  private readonly consoleBuffer = new BoundedBuffer<ConsoleDiagnosticEntry>(DEFAULT_CONSOLE_BUFFER_SIZE);
  private readonly networkBuffer = new BoundedBuffer<NetworkFailureEntry>(DEFAULT_NETWORK_BUFFER_SIZE);
  private readonly screenshotRecords: ScreenshotRecord[] = [];

  constructor(private readonly key: BrowserDiagnosticsBundleKey) {}

  recordConsole(level: ConsoleLevel, message: string, at: string = new Date().toISOString()): void {
    const { text, redacted } = redactedText(message);
    this.consoleBuffer.push({ level, message: text, at, redacted });
  }

  recordNetworkFailure(input: { url: string; method: string; status?: number; error?: string; at?: string }): void {
    const url = redactedText(input.url);
    const error = input.error !== undefined ? redactedText(input.error) : undefined;
    this.networkBuffer.push({
      url: url.text,
      method: input.method,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(error !== undefined ? { error: error.text } : {}),
      at: input.at ?? new Date().toISOString(),
      redacted: url.redacted || Boolean(error?.redacted)
    });
  }

  recordScreenshot(record: ScreenshotRecord): void {
    this.screenshotRecords.push(record);
  }

  snapshot(capturedAt: string = new Date().toISOString()): BrowserDiagnosticsBundle {
    return {
      schemaVersion: BROWSER_DIAGNOSTICS_SCHEMA_VERSION,
      ...this.key,
      capturedAt,
      console: this.consoleBuffer.list(),
      network: this.networkBuffer.list(),
      screenshots: [...this.screenshotRecords],
      truncated: this.consoleBuffer.dropped || this.networkBuffer.dropped
    };
  }
}

// ── Storage ──────────────────────────────────────────────────────────────

const BUNDLE_FILE_NAME = 'bundle.json';

function requireSafeSegment(value: string, field: string): string {
  if (!isSafeSegment(value)) throw new Error(`Unsafe ${field}: "${value}".`);
  return value;
}

/**
 * `<storageRoot>/<projectId>/<runId>/<serviceId>/` — every segment validated
 * before it is joined, and the joined result re-checked against the
 * resolved root, the same defence-in-depth `workflowEvidence.ts`'s
 * `evidenceBundleDir` uses. This is the isolation boundary: a malformed or
 * hostile id can neither collide with nor escape into another project's,
 * run's, or service's directory.
 */
function bundleDir(storageRoot: string, key: BrowserDiagnosticsBundleKey): string {
  const projectSeg = requireSafeSegment(key.projectId, 'projectId');
  const runSeg = requireSafeSegment(key.runId, 'runId');
  const serviceSeg = requireSafeSegment(key.serviceId, 'serviceId');
  const root = path.resolve(storageRoot);
  const dir = path.join(root, projectSeg, runSeg, serviceSeg);
  if (path.relative(root, dir).startsWith('..')) {
    throw new Error(`Resolved diagnostics directory escapes the storage root: ${dir}`);
  }
  return dir;
}

export async function writeBrowserDiagnosticsBundle(storageRoot: string, bundle: BrowserDiagnosticsBundle): Promise<void> {
  const dir = bundleDir(storageRoot, bundle);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, BUNDLE_FILE_NAME), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}

/** No bundle ever captured for this key is not an error — comes back `undefined`. A malformed file on disk is treated the same way rather than thrown. */
export async function readBrowserDiagnosticsBundle(
  storageRoot: string,
  key: BrowserDiagnosticsBundleKey
): Promise<BrowserDiagnosticsBundle | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(bundleDir(storageRoot, key), BUNDLE_FILE_NAME), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as BrowserDiagnosticsBundle) : undefined;
  } catch {
    return undefined;
  }
}

function screenshotFileName(capturedAt: string): string {
  const safe = capturedAt.replace(/[^0-9]/g, '') || String(Date.now());
  return `screenshot-${safe}.png`;
}

/** Writes a captured screenshot and returns the `ScreenshotRecord` to add to a bundle. The filename is generated here, never accepted from a caller. */
export async function writeScreenshot(
  storageRoot: string,
  key: BrowserDiagnosticsBundleKey,
  png: Buffer,
  capturedAt: string = new Date().toISOString()
): Promise<ScreenshotRecord> {
  const dir = bundleDir(storageRoot, key);
  await mkdir(dir, { recursive: true });
  const fileName = screenshotFileName(capturedAt);
  await writeFile(path.join(dir, fileName), png);
  return { presence: 'present', path: fileName, capturedAt };
}

/** Reads a screenshot back by its `ScreenshotRecord`. Fails closed on a record whose `path` isn't a safe bare filename (e.g. a hand-edited bundle) — returns `undefined` rather than resolving a path outside the bundle's own directory. */
export async function readScreenshot(
  storageRoot: string,
  key: BrowserDiagnosticsBundleKey,
  record: ScreenshotRecord
): Promise<Buffer | undefined> {
  if (record.presence !== 'present' || !record.path || !isSafeSegment(record.path)) return undefined;
  try {
    return await readFile(path.join(bundleDir(storageRoot, key), record.path));
  } catch {
    return undefined;
  }
}
