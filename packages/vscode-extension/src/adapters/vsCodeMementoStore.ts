import type * as vscode from 'vscode';
import type { KeyValueStore } from '@ticket-manager/core';

/** Wraps a vscode.Memento (context.globalState / workspaceState) as the host-agnostic KeyValueStore port. */
export class VsCodeMementoStore implements KeyValueStore {
  public constructor(private readonly memento: vscode.Memento) {}

  public get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }

  public async update(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
  }
}
