import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@praxis/core';
import { withJsonFileWrite } from './jsonFileWrites';

/** JSON-file-backed KeyValueStore. One file per scope (global.json / a project's state.json). */
export class JsonKeyValueStore implements KeyValueStore {
  private data: Record<string, unknown>;
  private committed: Record<string, unknown>;
  private readonly pending: Array<{ key: string; value: unknown }> = [];
  /**
   * Serialises writes. `update()` is called fire-and-forget from many places
   * (e.g. AiSessionManager persists on every session event), and two
   * overlapping `persist()` calls used to race on the temp file — the second
   * `rename` losing with ENOENT after the first consumed the temp. Queueing
   * them also stops one write clobbering another's snapshot.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {
    this.data = this.load();
    this.committed = this.data;
  }

  public get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  /** A detached copy of the same optimistic document synchronous readers currently see. */
  public snapshot(): unknown { return structuredClone(this.data); }

  public async update(key: string, value: unknown): Promise<void> {
    const operation = { key, value };
    this.pending.push(operation);
    this.rebuild();
    const write = this.writeQueue.then(async () => {
      const next = { ...this.committed, [key]: value };
      try {
        await this.persist(key, value);
        this.committed = next;
      } finally {
        this.pending.splice(this.pending.indexOf(operation), 1);
        this.rebuild();
      }
    });
    // Keep the queue chained regardless of this write's outcome.
    this.writeQueue = write.then(
      () => undefined,
      () => undefined
    );
    await write;
  }

  private rebuild(): void {
    this.data = { ...this.committed };
    for (const { key, value } of this.pending) this.data[key] = value;
  }

  private load(): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async persist(key: string, value: unknown): Promise<void> {
    await withJsonFileWrite(this.filePath, async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      // Another adapter owns settings in this document. Change only this store's key.
      const disk = this.load();
      const next = { ...disk, [key]: value };
      // A random component keeps atomic staging files unique.
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }
}
