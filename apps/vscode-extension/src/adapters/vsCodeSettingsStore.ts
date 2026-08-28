import * as vscode from 'vscode';
import type { KeyValueStore } from '@praxis/core';

/** Wraps a single vscode.workspace.getConfiguration(section) as the host-agnostic KeyValueStore port. */
export class VsCodeSettingsStore implements KeyValueStore {
  public constructor(private readonly section: string) {}

  public get<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration(this.section).get<T>(key);
  }

  public async update(key: string, value: unknown): Promise<void> {
    const target = this.configTarget();
    await vscode.workspace.getConfiguration(this.section).update(key, value, target);
  }

  private configTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }
}
