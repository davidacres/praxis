// Actual full-volume qualification: the index lives on a private, size-limited
// volume that is filled until the OS reports ENOSPC. Source files stay outside
// it. Never fills or touches any other volume. macOS uses an APFS sparse image
// (hdiutil), Linux a loop-mounted ext4 image (sudo mount), Windows an NTFS VHDX
// mounted on an empty folder (diskpart, which needs an elevated shell).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, open, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const execute = promisify(execFile);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--executable', '--output'].includes(key) || !value || options.has(key)) throw Error('Invalid arguments');
  options.set(key, value);
}
for (const key of ['--executable', '--output']) if (!options.has(key)) throw Error(`Missing ${key}`);
const executable = path.resolve(options.get('--executable')), output = path.resolve(options.get('--output'));
if (!output.endsWith('.praxis.json')) throw Error('Output must end in .praxis.json');
try { await access(output); throw Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const work = await mkdtemp(path.join(os.tmpdir(), 'pci-disk-full-'));
// Windows replaces the volume path with the attached drive letter.
let volume = path.join(work, 'volume'), data;
const source = path.join(work, 'source');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => text === undefined ? null : 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
async function cli(...args) {
  try { const { stdout } = await execute(executable, [...args, '--data', data], { timeout: 120_000 }); return { exitCode: 0, json: JSON.parse(stdout) }; }
  catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { exitCode: error.code, json: error.stdout ? JSON.parse(error.stdout) : null, stderr: error.stderr };
  }
}
async function fillVolume() {
  const filler = path.join(volume, 'filler.bin'); const handle = await open(filler, 'w'); const block = Buffer.alloc(1 << 20); let written = 0;
  try {
    // Shrink the write size near the end so the volume is genuinely exhausted.
    for (let size = block.length; size >= 512;) {
      try { await handle.write(block, 0, size); written += size; }
      catch (error) { if (error.code !== 'ENOSPC') throw error; size >>= 1; }
    }
    await handle.sync();
  } finally { await handle.close(); }
  return { filler, written };
}
// Each platform mounts a 64 MiB volume at `volume` and returns how to detach it.
const volumes = {
  darwin: {
    description: '64 MiB APFS sparse image',
    async attach() {
      const image = path.join(work, 'index');
      await execute('hdiutil', ['create', '-size', '64m', '-fs', 'APFS', '-type', 'SPARSE', '-volname', 'PciDiskFull', image]);
      await mkdir(volume); await execute('hdiutil', ['attach', '-nobrowse', '-mountpoint', volume, image + '.sparseimage']);
      return () => execute('hdiutil', ['detach', volume, '-force']);
    }
  },
  linux: {
    description: '64 MiB loop-mounted ext4 image with no reserved blocks',
    async attach() {
      const image = path.join(work, 'index.ext4');
      await execute('truncate', ['-s', '64M', image]);
      await execute('mkfs.ext4', ['-q', '-F', '-m', '0', image]);
      await mkdir(volume); await execute('sudo', ['-n', 'mount', '-o', 'loop', image, volume]);
      const detach = () => execute('sudo', ['-n', 'umount', '-l', volume]);
      await execute('sudo', ['-n', 'chown', `${process.getuid()}:${process.getgid()}`, volume]).catch(async error => { await detach(); throw error; });
      return detach;
    }
  },
  win32: {
    // A drive letter, not a folder mount: a volume mount folder is a reparse point the
    // owner's data-directory canonicalisation cannot resolve yet (see release evidence).
    description: '64 MiB NTFS VHDX on its own drive letter',
    async attach() {
      const image = path.join(work, 'index.vhdx'), script = path.join(work, 'diskpart.txt');
      const diskpart = async lines => {
        await writeFile(script, lines.join('\r\n') + '\r\n');
        // diskpart reports its reason on stdout; keep it in the error.
        try { return await execute('diskpart', ['/s', script], { timeout: 120_000 }); }
        catch (error) { throw Error(`diskpart failed (${lines[0]}): ${(error.stdout ?? '').trim().slice(-2000)}`); }
      };
      await diskpart([`create vdisk file="${image}" maximum=64 type=expandable`, `select vdisk file="${image}"`, 'attach vdisk',
        'create partition primary', 'format fs=ntfs quick label=PciDiskFull', 'assign']);
      // diskpart picks a free letter; find it by the volume label.
      const { stdout } = await execute('powershell', ['-NoProfile', '-Command', "(Get-Volume -FileSystemLabel PciDiskFull).DriveLetter"]);
      const letter = stdout.trim();
      if (!/^[A-Z]$/.test(letter)) throw Error('Attached VHDX has no drive letter: ' + stdout);
      volume = letter + ':\\';
      return () => diskpart([`select vdisk file="${image}"`, 'detach vdisk']);
    }
  }
};
const platformVolume = volumes[process.platform];
if (!platformVolume) throw Error(`No disk-full volume recipe for ${process.platform}`);
const report = { version: 1, platform: process.platform, architecture: process.arch, timestampUtc: new Date().toISOString(),
  measurement: `Packaged CLI and owner; index database on a ${platformVolume.description} filled until ENOSPC`, steps: [] };
const step = (name, details) => { report.steps.push({ name, ...details }); console.error(name, JSON.stringify(details)); };
let detach, ownerProcess;
try {
  detach = await platformVolume.attach();
  data = path.join(volume, 'data');
  await mkdir(source);
  await writeFile(path.join(source, 'Example.cs'), Array.from({ length: 50 }, (_, i) => `public class Example${i} { public int Run${i}() => ${i}; }`).join('\n'));
  const registered = await cli('register', source); if (registered.exitCode) throw Error('Register failed: ' + JSON.stringify(registered));
  const id = registered.json.data.repositoryId;
  const indexed = await cli('index', id); if (indexed.exitCode) throw Error('Initial index failed: ' + JSON.stringify(indexed));
  const owner = JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8')); ownerProcess = owner.processId;
  const generation = async () => (await cli('status', id)).json?.indexGeneration ?? null;
  const search = async query => { const result = await cli('search', id, query); return result.json ?? { cliExitCode: result.exitCode, stderr: result.stderr?.slice(0, 2000) }; };
  const baseline = await search('Example7'); const baselineGeneration = await generation();
  step('baseline', { generation: baselineGeneration, searchHash: hash(JSON.stringify(baseline.data.matches)) });

  const { filler, written } = await fillVolume();
  step('volume filled', { fillerBytes: written });
  await writeFile(path.join(source, 'Large.cs'), Array.from({ length: 2000 }, (_, i) =>
    `/// <summary>Grows the index beyond the remaining space ${i}.</summary>\npublic class Large${i} { public int Value${i}() => ${i}; }`).join('\n'));
  const full = await cli('index', id);
  const fullDoctor = (await cli('doctor')).json?.data;
  const duringSearch = await search('Example7'); const duringGeneration = await generation();
  step('index on full volume', { exitCode: full.exitCode, error: full.json?.error ?? null, doctorStorage: fullDoctor?.storage ?? null,
    doctorChecks: fullDoctor?.checks ?? null, generation: duringGeneration, generationUnchanged: duringGeneration === baselineGeneration,
    searchUnchanged: hash(JSON.stringify(duringSearch?.data?.matches)) === hash(JSON.stringify(baseline.data.matches)),
    searchError: duringSearch?.error ?? (duringSearch?.cliExitCode === undefined ? null : duringSearch) });

  await rm(filler);
  let recovered = null; const started = Date.now();
  while (Date.now() - started < 120_000) {
    const result = await search('Large7');
    if (result?.data?.matches?.length) { recovered = { afterMs: Date.now() - started }; break; }
    await wait(2000);
  }
  const afterDoctor = (await cli('doctor')).json?.data;
  step('space returned', { recovered, doctorStorage: afterDoctor?.storage ?? null, doctorChecks: afterDoctor?.checks ?? null });

  const [, filled, onFull, afterSpace] = report.steps;
  report.gates = {
    diskActuallyFull: filled.fillerBytes > 0,
    diskFullErrorReturned: onFull.error?.code === 'DISK_FULL' && onFull.error?.retryable === true,
    writesPausedReported: onFull.doctorStorage?.writesPaused === true,
    committedStatePreserved: onFull.searchUnchanged === true && onFull.generationUnchanged === true && Array.isArray(onFull.doctorChecks) && onFull.doctorChecks.length === 0,
    recoveredWithoutRestart: afterSpace.recovered !== null && afterSpace.doctorStorage?.writesPaused === false && afterSpace.doctorChecks?.length === 0
  };
  report.passed = Object.values(report.gates).every(Boolean);
} finally {
  if (ownerProcess) try { process.kill(ownerProcess); await wait(1000); } catch { }
  if (detach) await detach().catch(error => console.error('Detach failed:', error.message));
  // A still-attached image must not hide the original failure.
  await rm(work, { recursive: true, force: true }).catch(error => console.error('Cleanup failed:', error.message));
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: report.passed, gates: report.gates }));
if (!report.passed) process.exitCode = 2;
