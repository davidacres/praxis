// Build with all renderer checks, but preserve timestamps of identical assets so Cargo's
// renderer/dist dependency does not force a native rebuild on every unchanged launch.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, mkdir, copyFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function syncAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const entry of await readdir(destination)) {
    if (!names.has(entry)) await rm(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    const existing = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory()) await rm(output, { recursive: true, force: true });
      await syncAssets(input, output);
    } else {
      if (!entry.isFile()) throw new Error(`Unsupported renderer asset: ${input}`);
      if (existing?.isFile() && (await readFile(input)).equals(await readFile(output))) continue;
      if (existing) await rm(output, { recursive: true, force: true });
      await copyFile(input, output);
    }
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const renderer = path.join(root, 'apps/praxis-desktop/renderer');
  // Keep staging outside dist, which Cargo watches recursively.
  const stage = await mkdtemp(path.join(renderer, '.run-build-'));
  try {
    const result = spawnSync('npm', ['run', 'build', '--', '--outDir', stage], {
      cwd: renderer, stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Renderer build failed (${result.signal || result.status})`);
    await syncAssets(stage, path.join(renderer, 'dist'));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
