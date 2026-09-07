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
    // A live Electron window keeps the event loop active, so this watcher
    // does not need to keep a process alive by itself. In particular, macOS
    // FSEvents shutdown can otherwise outlive graceful Electron teardown.
    persistent: false,
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
