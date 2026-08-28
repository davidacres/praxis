import * as fs from 'node:fs/promises';

/**
 * The file-access surface the live-folder parser and writers need.
 *
 * Live folder reads and writes the markdown planning files under a project's
 * `docs/plans/` tree. Both UI surfaces use it, but they reach the filesystem
 * differently: the Electron app talks to local disk through `node:fs`, while
 * the VS Code extension must go through `vscode.workspace.fs` so the feature
 * keeps working when the workspace is remote (SSH, dev container, WSL,
 * github.dev). Rather than fork the parsing logic per host — which is what the
 * extension used to do, in a ~2,600-line duplicate — the logic lives here once
 * and the host swaps in its own implementation of this port.
 *
 * All paths are plain strings. The extension's adapter converts to and from
 * `vscode.Uri` at this boundary.
 */
export interface LiveFolderFs {
  /** Read a file as UTF-8. Rejects if the file does not exist. */
  readFile(filePath: string): Promise<string>;
  /** Write a file as UTF-8, creating or truncating it. */
  writeFile(filePath: string, content: string): Promise<void>;
  /**
   * List a directory's immediate children as `[name, kind]` pairs. Entries that
   * are neither a regular file nor a directory (symlinks, sockets) are reported
   * as `'file'`, matching the previous `Dirent.isDirectory() ? … : 'file'`
   * behaviour. Rejects if the directory does not exist.
   */
  readDirectory(dirPath: string): Promise<Array<[string, 'file' | 'directory']>>;
  /** Create a directory, including any missing parents. A no-op if it exists. */
  mkdir(dirPath: string): Promise<void>;
}

/** The default `node:fs` implementation — what the Electron app and every core test use. */
export const nodeLiveFolderFs: LiveFolderFs = {
  readFile(filePath) {
    return fs.readFile(filePath, 'utf-8');
  },
  async writeFile(filePath, content) {
    await fs.writeFile(filePath, content, 'utf-8');
  },
  async readDirectory(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map(e => [e.name, e.isDirectory() ? 'directory' : 'file']);
  },
  async mkdir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
  }
};

let activeFs: LiveFolderFs = nodeLiveFolderFs;

/**
 * Replace the filesystem the live-folder module uses. Call once at host
 * startup; passing `undefined` restores the `node:fs` default. Mirrors the
 * `setMcpOAuthProviderSource` pattern already used elsewhere in core — a single
 * host is active per process, so a module-level swap is sufficient and avoids
 * threading the port through ~40 function signatures.
 */
export function setLiveFolderFs(next: LiveFolderFs | undefined): void {
  activeFs = next ?? nodeLiveFolderFs;
}

/** The filesystem the live-folder module should use for all IO. */
export function liveFolderFs(): LiveFolderFs {
  return activeFs;
}
