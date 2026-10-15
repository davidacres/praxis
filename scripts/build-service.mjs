import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, access, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { smokeNativeIpc } from '../services/code-intelligence/scripts/smoke-native-ipc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = path.join(root, 'services', 'code-intelligence');
const project = path.join(service, 'src', 'Praxis.CodeIntelligence', 'Praxis.CodeIntelligence.csproj');
const cli = process.env.PRAXIS_DOTNET || 'dotnet';
const arguments_ = process.argv.slice(2);
const packaging = arguments_.includes('--package');
const testing = arguments_.includes('--test');
const ridIndex = arguments_.indexOf('--rid');
const platformIndex = arguments_.indexOf('--platform');
const platform = platformIndex >= 0 ? arguments_[platformIndex + 1] : process.platform;
const hostPlatform = { linux: 'linux', darwin: 'osx', win32: 'win' }[platform];
const rid = ridIndex >= 0 ? arguments_[ridIndex + 1] : `${hostPlatform}-${process.arch}`;
const supported = new Set(['linux-x64', 'linux-arm64', 'osx-x64', 'osx-arm64', 'win-x64']);

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: service, stdio: 'inherit', shell: false });
    child.on('error', error => reject(new Error(`Cannot run ${executable}: install the .NET SDK pinned in services/code-intelligence/global.json or set PRAXIS_DOTNET. ${error.message}`)));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with ${code}`)));
  });
}
try {
  if (!packaging) {
    await run(cli, ['restore', 'Praxis.CodeIntelligence.slnx', '--locked-mode', '--disable-parallel', '-m:1']);
    await run(cli, [testing ? 'test' : 'build', 'Praxis.CodeIntelligence.slnx', '--no-restore', '--nologo', '-m:1', '-p:UseSharedCompilation=false']);
  } else {
    if (!supported.has(rid)) throw new Error(`Unsupported code intelligence runtime: ${rid}. Supported: ${[...supported].join(', ')}`);
    const artifacts = path.join(service, 'artifacts'); await mkdir(artifacts, { recursive: true });
    const stage = await mkdtemp(path.join(artifacts, 'package-')); const destination = path.join(artifacts, 'package'); const previous = path.join(artifacts, 'package.previous');
    let hadPrevious = false;
    try {
      await run(cli, ['publish', project, '--configuration', 'Release', '--runtime', rid, '--self-contained', 'true', '--output', stage, '-m:1', '-p:UseSharedCompilation=false', '-p:RestoreLockedMode=true']);
      const executable = path.join(stage, `Praxis.CodeIntelligence${rid.startsWith('win-') ? '.exe' : ''}`);
      await access(executable); await access(path.join(stage, 'contracts.json'));
      await copyFile(path.join(service, 'models', 'minilm-manifest.json'), path.join(stage, 'baseline-model-manifest.json'));
      await writeFile(path.join(stage, 'package-manifest.json'), JSON.stringify({ runtime: rid, schemaVersion: '1.2', selfContained: true, modelWeightsIncluded: false }, null, 2) + '\n');
      const hostRid = `${{ linux: 'linux', darwin: 'osx', win32: 'win' }[process.platform]}-${process.arch}`;
      if (rid === hostRid) {
        await run(executable, ['help']);
        const smoke = await mkdtemp(path.join(tmpdir(), 'praxis-native-smoke-'));
        try { await run(executable, ['init', path.join(smoke, 'index.db')]); } finally { await rm(smoke, { recursive: true, force: true }); }
        if (process.env.PRAXIS_MODEL_BUNDLE) await run(executable, ['model-check', process.env.PRAXIS_MODEL_BUNDLE]);
        await smokeNativeIpc(executable);
      }
      await rm(previous, { recursive: true, force: true });
      try { await rename(destination, previous); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(stage, destination); } catch (error) { if (hadPrevious) await rename(previous, destination); throw error; }
      await rm(previous, { recursive: true, force: true });
      process.stdout.write(`Packaged code intelligence for ${rid}.\n`);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
