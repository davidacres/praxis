#!/usr/bin/env node
// Publishes the .NET code-intelligence service (self-contained, host platform) and stages it at
// apps/praxis-desktop/src-tauri/resources/code-intelligence for the Tauri bundle
// (src-tauri/tauri.bundle.conf.json maps that folder to `code-intelligence` in the app's
// resource directory, where application/code_intelligence.rs looks first).
//
//   node scripts/bundle-code-intelligence.mjs [--rid osx-arm64] [--skip-publish] [--dry-run] [--help]
//
// Publishing is delegated to scripts/build-service.mjs --package (dotnet publish, TypeScript
// sidecar, contracts, model manifest, smoke test); this script only stages the result.
import { spawn } from 'node:child_process';
import { access, cp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = path.join(root, 'services', 'code-intelligence', 'artifacts', 'package');
const target = path.join(root, 'apps', 'praxis-desktop', 'src-tauri', 'resources', 'code-intelligence');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`Usage: node scripts/bundle-code-intelligence.mjs [options]

Publish the code-intelligence service and stage it for the Tauri bundle.

  --rid <rid>       .NET runtime id (default: host, e.g. osx-arm64, linux-x64, win-x64)
  --skip-publish    reuse services/code-intelligence/artifacts/package as-is
  --dry-run         print the plan without publishing or copying
  --help            show this text

Set PRAXIS_DOTNET to use a specific dotnet CLI. Output (gitignored):
  ${path.relative(root, target)}
`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const ridIndex = args.indexOf('--rid');
const forwarded = ridIndex >= 0 ? ['--rid', args[ridIndex + 1]] : [];
const steps = [];
if (!args.includes('--skip-publish')) steps.push(['node', [path.join(root, 'scripts', 'build-service.mjs'), '--package', ...forwarded]]);

function run(executable, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable === 'node' ? process.execPath : executable, argv, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${path.basename(argv[0])} exited with ${code}`))));
  });
}

try {
  if (dryRun) {
    for (const [, argv] of steps) process.stdout.write(`would run: node ${path.relative(root, argv[0])} ${argv.slice(1).join(' ')}\n`);
    process.stdout.write(`would stage: ${path.relative(root, packaged)} -> ${path.relative(root, target)}\n`);
  } else {
    for (const [exe, argv] of steps) await run(exe, argv);
    await access(path.join(packaged, 'contracts.json')).catch(() => {
      throw new Error(`No published service at ${packaged}; run without --skip-publish (needs the .NET SDK).`);
    });
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(packaged, target, { recursive: true });
    process.stdout.write(`Staged code intelligence at ${target}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
