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

/** A markdown plan file, matched case-insensitively as chokidar 3's glob was. */
const isMarkdown = (absolutePath: string): boolean => /\.md$/i.test(absolutePath);

const nodeFolderWatch: FolderWatch = (rootPath, onChange) => {
  const watcher = chokidar.watch(rootPath, {
    // Must stay persistent: chokidar on macOS delivers no events at all with
    // `persistent: false`, so the board never saw external changes. Shutdown is
    // handled by `FolderService.dispose()` closing the watcher, not by letting
    // it go unreferenced.
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });
  // chokidar 4 dropped glob support (and, with it, the transitive `braces`,
  // which has an unpatched high-severity advisory), so we watch the root
  // recursively — its default unbounded `depth` — and filter to markdown here
  // instead. chokidar emits absolute paths when given one, so the old `cwd` +
  // `path.join` round-trip is no longer needed.
  //
  // Do NOT move the markdown filter into `ignored`: chokidar 4 will not
  // descend into a directory the predicate rejects, which silently drops every
  // nested plan file.
  //
  // One behavior change from chokidar 3: with `awaitWriteFinish`, a file whose
  // mtime lands inside the stability window when the scan starts is reported as
  // a `change` rather than suppressed by `ignoreInitial`. Plans roots are read
  // from disk well before we start watching, so in practice nothing is that
  // young; and if something is, `FolderService` debounces the reload and
  // suppresses its own writes, so the extra event is harmless.
  const handle = (absolutePath: string): void => {
    if (isMarkdown(absolutePath)) onChange(absolutePath);
  };
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
