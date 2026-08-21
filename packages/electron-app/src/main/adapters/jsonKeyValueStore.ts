import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyValueStore } from '@ticket-manager/core';

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
    this.data[key] = value;
    await this.persist();
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
    await fs.promises.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}
