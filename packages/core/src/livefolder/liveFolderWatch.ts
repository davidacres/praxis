import * as path from 'node:path';
import chokidar from 'chokidar';

/**
 * Watches a live-folder plans root for markdown changes. `LiveFolderService`
 * owns the debounce and self-write suppression; this only has to deliver "an
 * `.md` file under `rootPath` changed", by absolute path. Backed by `chokidar`;
 * core tests use the same implementation.
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

const nodeLiveFolderWatch: LiveFolderWatch = (rootPath, onChange) => {
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

/** The watch implementation the live-folder module uses. */
export function liveFolderWatch(): LiveFolderWatch {
  return nodeLiveFolderWatch;
}
