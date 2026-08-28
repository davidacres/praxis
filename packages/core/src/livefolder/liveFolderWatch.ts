import * as path from 'node:path';
import chokidar from 'chokidar';

/**
 * Watches a live-folder plans root for markdown changes.
 *
 * Split from the parser/writer port because it is a different host capability:
 * the Electron app watches local disk with `chokidar`, while the VS Code
 * extension uses `vscode.workspace.createFileSystemWatcher` so notifications
 * arrive even when the workspace is remote. `LiveFolderService` owns the
 * debounce and self-write suppression; an implementation here only has to
 * deliver "an `.md` file under `rootPath` changed", by absolute path.
 */
export interface LiveFolderWatcher {
  /** Stop watching and release resources. */
  close(): void | Promise<void>;
}

export type LiveFolderWatch = (
  rootPath: string,
  /** Called with the absolute path of any added, changed, or removed `*.md` file. */
  onChange: (absolutePath: string) => void
) => LiveFolderWatcher;

/** The default `chokidar` implementation — what the Electron app and core tests use. */
export const nodeLiveFolderWatch: LiveFolderWatch = (rootPath, onChange) => {
  const watcher = chokidar.watch('**/*.md', {
    cwd: rootPath,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });
  const handle = (relativePath: string): void => onChange(path.join(rootPath, relativePath));
  watcher.on('change', handle);
  watcher.on('add', handle);
  watcher.on('unlink', handle);
  return {
    close: () => watcher.close()
  };
};

let activeWatch: LiveFolderWatch = nodeLiveFolderWatch;

/**
 * Replace the watch implementation the live-folder module uses. Call once at
 * host startup; `undefined` restores the `chokidar` default.
 */
export function setLiveFolderWatch(next: LiveFolderWatch | undefined): void {
  activeWatch = next ?? nodeLiveFolderWatch;
}

/** The watch implementation the live-folder module should use. */
export function liveFolderWatch(): LiveFolderWatch {
  return activeWatch;
}
