import * as fs from 'node:fs';
import * as path from 'node:path';

/** Local builds only. Packaged releases deliberately stay on TypeScript (TASK-535). */
export function selectRustHostBinary(
  repoRoot: string,
  override = process.env.PRAXIS_RUST_HOST_BIN,
  platform = process.platform
): string {
  if (override) {
    if (fs.statSync(override).isFile()) return override;
    throw new Error('PRAXIS_RUST_HOST_BIN must point to a file.');
  }
  const name = platform === 'win32' ? 'praxis-host.exe' : 'praxis-host';
  const candidates = ['release', 'debug'].map(profile => path.join(repoRoot, 'target', profile, name));
  const existing = candidates.filter(file => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (existing[0]) return existing[0];
  throw new Error('No local praxis-host binary. Run npm run build:rust.');
}

/** Ignore symlinks and include manifests/lockfile as well as Rust source files. */
export function isRustHostBinaryStale(binary: string, repoRoot: string): boolean {
  const binaryTime = fs.statSync(binary).mtimeMs;
  function newer(directory: string): boolean {
    return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? newer(file) : entry.isFile() && fs.statSync(file).mtimeMs > binaryTime;
    });
  }
  return newer(path.join(repoRoot, 'crates')) || ['Cargo.toml', 'Cargo.lock'].some(name => {
    const file = path.join(repoRoot, name);
    return fs.existsSync(file) && fs.statSync(file).mtimeMs > binaryTime;
  });
}
