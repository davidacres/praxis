import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@praxis/core';

/** JSON-file-backed KeyValueStore. One file per scope (global.json / a project's state.json). */
export class JsonKeyValueStore implements KeyValueStore {
  private data: Record<string, unknown>;
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
  }

  public get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    const previous = this.data[key];
    this.data[key] = value;
    const write = this.writeQueue.then(() => this.persist());
    // Keep the queue chained regardless of this write's outcome.
    this.writeQueue = write.then(
      () => undefined,
      () => undefined
    );
    try {
      await write;
    } catch (error) {
      if (previous === undefined) delete this.data[key];
      else this.data[key] = previous;
      throw error;
    }
  }

  private load(): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async persist(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    // A random component (not just pid+time) so two saves in the same
    // millisecond can never target the same temp file.
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      await fs.promises.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
