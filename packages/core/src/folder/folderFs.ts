import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

/**
 * What this process last wrote to each file, and which files it moved away. A watcher uses
 * this to tell its own echo from someone else's edit by content rather than by timing:
 * an outside edit landing a moment after one of ours is still an outside edit.
 */
const lastWritten = new Map<string, string>();
const movedAway = new Set<string>();

/** True when `content` (undefined = the file is gone) is exactly what this process left at `filePath`. */
export function isOwnFolderWrite(filePath: string, content: string | undefined): boolean {
  const key = path.resolve(filePath);
  return content === undefined ? movedAway.has(key) : lastWritten.get(key) === content;
}

const nodeFolderFs: FolderFs = {
  readFile(filePath) {
    return fs.readFile(filePath, 'utf-8');
  },
  async writeFile(filePath, content) {
    await fs.writeFile(filePath, content, 'utf-8');
    lastWritten.set(path.resolve(filePath), content);
    movedAway.delete(path.resolve(filePath));
  },
  async readDirectory(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map(e => [e.name, e.isDirectory() ? 'directory' : 'file']);
  },
  async mkdir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
  },
  async moveFile(sourcePath, targetPath) {
    await fs.rename(sourcePath, targetPath);
    const [source, target] = [path.resolve(sourcePath), path.resolve(targetPath)];
    const content = lastWritten.get(source);
    lastWritten.delete(source);
    movedAway.add(source);
    if (content !== undefined) lastWritten.set(target, content);
    movedAway.delete(target);
  }
};

/** The filesystem the folder module uses for all IO. */
export function folderFs(): FolderFs {
  return nodeFolderFs;
}
