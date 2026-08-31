import * as fs from 'node:fs/promises';

/**
 * The file-access surface the live-folder parser and writers need — reads and
 * writes the markdown planning files under a project's plans tree. Backed by
 * `node:fs`; every core test uses the same implementation.
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

const nodeLiveFolderFs: LiveFolderFs = {
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

/** The filesystem the live-folder module uses for all IO. */
export function liveFolderFs(): LiveFolderFs {
  return nodeLiveFolderFs;
}
