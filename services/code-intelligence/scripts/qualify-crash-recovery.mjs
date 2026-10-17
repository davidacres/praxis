// Crash-recovery stress: repeatedly SIGKILL the native owner at random points
// while it publishes an edit or refreshes vectors, restart it through the normal
// client, and require integrity, the edited content and full vector coverage.
// On Windows, Node's process.kill(pid, 'SIGKILL') calls TerminateProcess: the
// same abrupt, no-cleanup termination.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
const execute = promisify(execFile);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--executable', '--model', '--reference', '--output', '--symbols', '--iterations', '--seed'].includes(key) || !value || options.has(key)) throw Error('Invalid arguments');
  options.set(key, value);
}
for (const key of ['--executable', '--model', '--reference', '--output']) if (!options.has(key)) throw Error(`Missing ${key}`);
const executable = path.resolve(options.get('--executable')), model = path.resolve(options.get('--model'));
const reference = path.resolve(options.get('--reference')), output = path.resolve(options.get('--output'));
const symbols = Number(options.get('--symbols') ?? 2000), iterations = Number(options.get('--iterations') ?? 20);
let seed = Number(options.get('--seed') ?? 4211);
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
if (!output.endsWith('.praxis.json')) throw Error('Output must end in .praxis.json');
try { await access(output); throw Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pci-crash-'));
const root = path.join(fixture, 'source'), data = path.join(fixture, 'data'); await mkdir(root);
const cli = async (...args) => {
  try { return JSON.parse((await execute(executable, [...args, '--data', data], { timeout: 125000, maxBuffer: 4 << 20 })).stdout); }
  catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error; }
};
const ownerPid = async () => { try { return JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8')).processId; } catch { return null; } };
const report = { version: 1, platform: process.platform, architecture: process.arch, timestampUtc: new Date().toISOString(), symbols, iterations,
  seed: Number(options.get('--seed') ?? 4211), measurement: `Packaged CLI and auto-started owner; ${process.platform === 'win32' ? 'TerminateProcess' : 'SIGKILL'} at a random delay (0–2.5 s) after each source edit`, samples: [] };
let repository;
try {
  const paths = [], originals = []; let remaining = symbols - 1, ordinal = 0;
  while (remaining > 0) {
    const name = `Corpus${String(paths.length).padStart(4, '0')}`, relative = name + '.cs'; let text = `public class ${name} {\n`;
    const count = Math.min(99, remaining - 1);
    for (let index = 0; index < count; index++, ordinal++)
      text += `/// <summary>Parse authentication token category ${ordinal}.</summary>\npublic static int TokenParser${String(ordinal).padStart(5, '0')}(int value) => value + ${ordinal};\n`;
    text += '}\n'; await writeFile(path.join(root, relative), text); paths.push(relative); originals.push(text); remaining -= count + 1;
  }
  const referenceHash = hash(await readFile(reference));
  await writeFile(path.join(root, 'context.praxis.json'), JSON.stringify({ version: 1, projects: [{ key: 'benchmark', assemblyName: 'Benchmark', sources: paths, metadata: [{ path: reference, contentHash: referenceHash }] }] }));
  // The CLI starts an owner on demand, exactly as a client would after a crash.
  repository = (await cli('register', root, '--manifest', 'context.praxis.json')).data.repositoryId;
  const status = () => cli('query', 'get_index_status', JSON.stringify({ repositoryId: repository, responseBudgetTokens: 8000 }));
  const vectorCoverage = async () => (await cli('search', repository, 'TokenParser00000'))?.data?.vectorCoveredSymbolCount ?? null;
  const settled = response => response.freshness?.state === 'current' && !(response.data?.jobsByState?.pending || response.data?.jobsByState?.leased);
  async function settle(timeoutMs, needVectors) {
    const begin = performance.now();
    while (performance.now() - begin < timeoutMs) {
      const response = await status().catch(() => null);
      if (response && settled(response) && (!needVectors || await vectorCoverage() === symbols)) return performance.now() - begin;
      await wait(250);
    }
    return null;
  }
  if (await settle(600000, false) === null) throw Error('Initial index did not settle');
  const fingerprint = (await cli('model-install', model)).data.fingerprint; await cli('model-activate', repository, fingerprint);
  if (await settle(900000, true) === null) throw Error('Initial vectors did not settle');
  const target = (await cli('query', 'find_symbol', JSON.stringify({ repositoryId: repository, name: 'TokenParser00000' }))).data.items[0].symbolId;
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const text = originals[0].replace('value + 0;', `value + ${200000 + iteration};`); const expectedHash = hash(Buffer.from(text));
    await writeFile(path.join(root, paths[0]), text);
    const delayMs = Math.round(random() * 2500); await wait(delayMs);
    const pid = await ownerPid(); let killed = false;
    if (pid) try { process.kill(pid, 'SIGKILL'); killed = true; } catch { }
    await wait(300);
    const doctor = (await cli('doctor')).data; // restarts the owner on demand
    const recoveryMs = await settle(180000, true);
    const source = await cli('query', 'get_source', JSON.stringify({ repositoryId: repository, symbolId: target, responseBudgetTokens: 8000 }));
    const finalDoctor = (await cli('doctor')).data;
    const sample = { iteration, delayMs, killed, integrityAfterRestart: doctor?.checks ?? null, recoveredMs: recoveryMs,
      currentHash: source.data?.fragments?.[0]?.currentHash ?? null, contentCurrent: source.data?.fragments?.[0]?.currentHash === expectedHash,
      integrityAfterRecovery: finalDoctor?.checks ?? null };
    report.samples.push(sample); console.error(JSON.stringify(sample));
  }
  report.gates = {
    everyIterationKilledAnOwner: report.samples.every(sample => sample.killed),
    integrityCleanAfterEveryRestart: report.samples.every(sample => Array.isArray(sample.integrityAfterRestart) && sample.integrityAfterRestart.length === 0
      && Array.isArray(sample.integrityAfterRecovery) && sample.integrityAfterRecovery.length === 0),
    everyIterationRecovered: report.samples.every(sample => sample.recoveredMs !== null),
    editedContentPublished: report.samples.every(sample => sample.contentCurrent)
  };
} finally {
  const pid = await ownerPid(); if (pid) try { process.kill(pid, 'SIGTERM'); } catch { }
  await wait(1000); await rm(fixture, { recursive: true, force: true });
}
report.passed = Object.values(report.gates ?? { failed: false }).every(Boolean);
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: report.passed, gates: report.gates }));
if (!report.passed) process.exitCode = 2;
