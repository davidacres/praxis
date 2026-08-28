import type * as vscode from 'vscode';
import type { SecretsStore } from '@praxis/core';

/** Wraps vscode.SecretStorage as the host-agnostic SecretsStore port. */
export class VsCodeSecretsStore implements SecretsStore {
  public constructor(private readonly secrets: vscode.SecretStorage) {}

  public async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  public async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
