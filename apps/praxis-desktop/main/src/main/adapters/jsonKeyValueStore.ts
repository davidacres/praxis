import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyValueStore } from '@praxis/core';

/** JSON-file-backed KeyValueStore. One file per scope (global.json / a project's state.json). */
export class JsonKeyValueStore implements KeyValueStore {
  private data: Record<string, unknown>;

  public constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  public get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    const previous = this.data[key];
    this.data[key] = value;
    try {
      await this.persist();
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
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }
}
