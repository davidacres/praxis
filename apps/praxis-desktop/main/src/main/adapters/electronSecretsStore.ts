import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretsStore } from '@praxis/core';

/**
 * safeStorage-encrypted secrets, persisted as a JSON file of base64-encoded encrypted blobs
 * under app.getPath('userData'). See plan §6 — avoids a keytar/native-module dependency.
 */
export class ElectronSecretsStore implements SecretsStore {
  public constructor(private readonly filePath: string) {}

  public async get(key: string): Promise<string | undefined> {
    const encoded = this.readAll()[key];
    if (!encoded) {
      return undefined;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      // A blob may have been encrypted under a previous app identity (for
      // example, before the Praxis rename). Treat it as unavailable and let
      // the user replace it; never let one stale credential prevent the app
      // from loading provider/connection settings.
      return undefined;
    }
  }

  public async store(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('OS-backed secret encryption is not available on this machine.');
    }
    const all = this.readAll();
    all[key] = safeStorage.encryptString(value).toString('base64');
    await this.writeAll(all);
  }

  public async delete(key: string): Promise<void> {
    const all = this.readAll();
    delete all[key];
    await this.writeAll(all);
  }

  private readAll(): Record<string, string> {
    try {
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  private async writeAll(all: Record<string, string>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(this.filePath, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await fs.promises.chmod(this.filePath, 0o600);
  }
}
