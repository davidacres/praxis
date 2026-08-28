import * as vscode from 'vscode';
import type { LiveFolderFs, LiveFolderWatch } from '@praxis/core';

/**
 * Backs core's live-folder ports with VS Code's workspace filesystem instead of
 * `node:fs` + `chokidar`.
 *
 * The extension is declared `"extensionKind": ["ui"]`, so it runs on the local
 * machine even when the workspace is remote (SSH, dev container, WSL,
 * github.dev). `vscode.workspace.fs` and `createFileSystemWatcher` proxy to
 * wherever the workspace actually lives; `node:fs` would look at the wrong disk.
 * Registering these at startup (see `extension.ts`) lets the extension share
 * core's single copy of the parser and writers while keeping remote support.
 *
 * Core works entirely in string paths; this layer converts to and from
 * `vscode.Uri` at the boundary.
 */

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export const vsCodeLiveFolderFs: LiveFolderFs = {
  async readFile(filePath) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return decoder.decode(bytes);
  },
  async writeFile(filePath, content) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), encoder.encode(content));
  },
  async readDirectory(dirPath) {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
    // Core's contract: anything not a directory is reported as 'file', matching
    // the previous `Dirent.isDirectory() ? 'directory' : 'file'` behaviour.
    return entries.map(([name, type]) => [
      name,
      type === vscode.FileType.Directory ? 'directory' : 'file'
    ]);
  },
  async mkdir(dirPath) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
  }
};

export const vsCodeLiveFolderWatch: LiveFolderWatch = (rootPath, onChange) => {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(rootPath), '**/*.md');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const handle = (uri: vscode.Uri): void => onChange(uri.fsPath);
  watcher.onDidChange(handle);
  watcher.onDidCreate(handle);
  watcher.onDidDelete(handle);
  return {
    close: () => watcher.dispose()
  };
};
