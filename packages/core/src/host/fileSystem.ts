/**
 * Replaces vscode.workspace.fs.
 * VS Code adapter wraps vscode.workspace.fs directly; Electron adapter
 * wraps node:fs/promises + a chokidar/fs.watch-backed watch().
 */
export interface HostFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readDirectory(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  stat(path: string): Promise<{ exists: boolean; mtimeMs?: number }>;
  createDirectory(path: string): Promise<void>;
  watch(path: string, onChange: () => void): () => void;
}
