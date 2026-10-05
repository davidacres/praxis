import * as path from 'node:path';
import chokidar from 'chokidar';

/**
 * Watches a folder plans root for markdown changes. `FolderService`
 * owns the debounce and self-write suppression; this only has to deliver "an
 * `.md` file under `rootPath` changed", by absolute path. Backed by `chokidar`;
 * core tests use the same implementation.
 */
export interface FolderWatcher {
  /** Stop watching and release resources. */
  close(): void | Promise<void>;
}

export type FolderWatch = (
  rootPath: string,
  /** Called with the absolute path of any added, changed, or removed `*.md` file. */
  onChange: (absolutePath: string) => void
) => FolderWatcher;

const nodeFolderWatch: FolderWatch = (rootPath, onChange) => {
  const watcher = chokidar.watch('**/*.md', {
    cwd: rootPath,
    // Must stay persistent: chokidar 3 on macOS delivers no events at all with
    // `persistent: false`, so the board never saw external changes. Shutdown is
    // handled by `FolderService.dispose()` closing the watcher, not by letting
    // it go unreferenced.
    persistent: true,
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

/** The watch implementation the folder module uses. */
export function folderWatch(): FolderWatch {
  return nodeFolderWatch;
}
