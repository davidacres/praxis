import * as fs from 'node:fs/promises';

/**
 * The file-access surface the folder parser and writers need — reads and
 * writes the markdown planning files under a project's plans tree. Backed by
 * `node:fs`; every core test uses the same implementation.
 */
export interface FolderFs {
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
  /** Move a managed markdown file to another path in the plans tree. */
  moveFile(sourcePath: string, targetPath: string): Promise<void>;
}

const nodeFolderFs: FolderFs = {
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
  },
  moveFile(sourcePath, targetPath) {
    return fs.rename(sourcePath, targetPath);
  }
};

/** The filesystem the folder module uses for all IO. */
export function folderFs(): FolderFs {
  return nodeFolderFs;
}
