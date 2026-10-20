import { promises as fs, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { LogBus } from '@praxis/core';

const LOG_FILE_NAME = 'application.log';
/** One rotation: `application.log` becomes `application.log.1` past this size. */
const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Reads the most recent lines from an application log file. Each line is stored
 * as one JSON string so a message containing a newline stays one entry. A
 * missing file or a corrupt line is skipped — history is best-effort and must
 * never stop the app starting.
 */
export function readRecentLogLines(logDir: string, limit: number): string[] {
  let text: string;
  try {
    text = readFileSync(path.join(logDir, LOG_FILE_NAME), 'utf8');
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const row of text.split('\n')) {
    if (!row) continue;
    try {
      const value: unknown = JSON.parse(row);
      if (typeof value === 'string') lines.push(value);
    } catch {
      // A half-written last line after a crash.
    }
  }
  return lines.slice(-limit);
}

/**
 * Keeps the Output panel's history across restarts: seeds `bus` with the lines
 * the previous session wrote, then appends every new line to
 * `<logDir>/application.log`. Seeding is synchronous (a bounded file read at
 * startup) so seeded lines always precede live ones; writes are serialised and
 * their failures swallowed (logging must never throw into the caller).
 */
export function attachLogPersistence(bus: LogBus, logDir: string, capacity = 500): () => void {
  const filePath = path.join(logDir, LOG_FILE_NAME);
  const previous = readRecentLogLines(logDir, capacity);
  for (const line of previous) bus.appendLine(line);

  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Writes below fail quietly too; the in-memory buffer still works.
  }
  let queue: Promise<void> = Promise.resolve();
  const write = (text: string): void => {
    queue = queue.then(async () => {
      try {
        const stats = await fs.stat(filePath).catch(() => undefined);
        if (stats && stats.size > MAX_LOG_BYTES) {
          await fs.rename(filePath, `${filePath}.1`);
        }
        await fs.appendFile(filePath, text, 'utf8');
      } catch {
        // Disk full / read-only profile: the in-memory buffer still works.
      }
    });
  };

  const unsubscribe = bus.subscribe(line => write(`${JSON.stringify(line)}\n`));
  // Appended after subscribing, so the marker is persisted too and the next
  // session can see where this one began.
  if (previous.length > 0) bus.appendLine('—— previous session above ——');
  return unsubscribe;
}
