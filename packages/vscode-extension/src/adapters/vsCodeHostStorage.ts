import type * as vscode from 'vscode';
import type { HostStorage } from '@ticket-manager/core';
import { VsCodeMementoStore } from './vsCodeMementoStore';

/**
 * Wraps a `vscode.ExtensionContext` as core's host-agnostic `HostStorage` port.
 *
 * Core's stores (BoardStore, BoardColumnStore, FilterStore) used to exist twice:
 * once here typed against `vscode.ExtensionContext`, and once in core typed
 * against `HostStorage`. The two copies were identical apart from that binding,
 * so the copies were deleted and this adapter supplies the binding instead.
 */
export function vsCodeHostStorage(context: vscode.ExtensionContext): HostStorage {
  return {
    global: new VsCodeMementoStore(context.globalState),
    workspace: new VsCodeMementoStore(context.workspaceState)
  };
}
