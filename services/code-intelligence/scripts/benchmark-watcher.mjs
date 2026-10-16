// Actual owner/watcher timings in an owned synthetic fixture; no explicit index
// command follows timed edits. Observation bounds deliberately include CLI cost.
import { spawn, execFile } from 'node:child_process';
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
  if (!['--executable', '--model', '--reference', '--output', '--symbols', '--edits'].includes(key) || !value || options.has(key)) throw Error('Invalid benchmark arguments');
  options.set(key, value);
}
for (const key of ['--executable', '--model', '--reference', '--output']) if (!options.has(key)) throw Error(`Missing ${key}`);
const executable = path.resolve(options.get('--executable'));
const model = path.resolve(options.get('--model')), reference = path.resolve(options.get('--reference'));
const output = path.resolve(options.get('--output'));
if (!output.endsWith('.praxis.json')) throw Error('Output must end in .praxis.json');
await Promise.all([access(executable), access(reference), access(path.join(model, 'manifest.json')), access(path.join(path.dirname(executable), 'Praxis.CodeIntelligence.dll'))]);
const symbols = Number(options.get('--symbols') ?? 5000), edits = Number(options.get('--edits') ?? 25);
if (!Number.isInteger(symbols) || symbols < 100 || symbols > 5000 || !Number.isInteger(edits) || edits < 5 || edits > 100) throw Error('Symbols must be 100–5000; edits 5–100');
try { await access(output); throw Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pci-watch-benchmark-'));
const root = path.join(fixture, 'source'), data = path.join(fixture, 'data');
await mkdir(root);
let owner, ownerFailure;
const samples = [], failures = [];
let corpusHash, referenceHash, modelFingerprint, before;
const cli = async (...args) => {
  const result = await execute(executable, [...args, '--data', data], { timeout: 125000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout);
};
let repository;
const query = (tool, args = {}) => cli('query', tool, JSON.stringify({ ...args, repositoryId: repository, responseBudgetTokens: 8000 }));
const status = () => query('get_index_status');
const hasJobs = response => {
  const jobs = response.data?.jobsByState ?? {};
  return jobs.pending || jobs.leased;
};
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? null;
try {
  const paths = [], originals = [], hashes = [];
  let remaining = symbols - 1, ordinal = 0;
  while (remaining > 0) {
    const name = `Corpus${String(paths.length).padStart(4, '0')}`, relative = name + '.cs';
    let text = `public class ${name} {\n`;
    const count = Math.min(99, remaining - 1);
    for (let index = 0; index < count; index++) {
      text += `/// <summary>Parse authentication token category ${ordinal}.</summary>\npublic static int TokenParser${String(ordinal).padStart(5, '0')}(int value) => value + ${ordinal};\n`;
      ordinal++;
    }
    text += '}\n';
    await writeFile(path.join(root, relative), text);
    paths.push(relative); originals.push(text); hashes.push(relative + ':' + hash(Buffer.from(text)));
    remaining -= count + 1;
  }
  corpusHash = hash(Buffer.from(hashes.join('\n')));
  referenceHash = hash(await readFile(reference));
  await writeFile(path.join(root, 'context.praxis.json'), JSON.stringify({ version: 1, projects: [{ key: 'benchmark', assemblyName: 'Benchmark', sources: paths, metadata: [{ path: reference, contentHash: referenceHash }] }] }));
  owner = spawn(executable, ['serve', '--data', data], { stdio: 'ignore' });
  owner.once('error', error => { ownerFailure = error; });
  for (let retry = 0; retry < 150; retry++) {
    if (ownerFailure) throw ownerFailure;
    if (owner.exitCode !== null) throw Error('Owned service exited before readiness');
    try { await access(path.join(data, 'owner.json')); break; } catch { await wait(100); }
  }
  repository = (await cli('register', root, '--manifest', 'context.praxis.json')).data.repositoryId;
  // Initial setup is untimed. Register's durable job performs actual analysis.
  for (let retry = 0; retry < 300; retry++) {
    before = await status();
    if (before.freshness?.state === 'current' && !hasJobs(before)) break;
    await wait(250);
  }
  if (before.freshness?.state !== 'current') throw Error('Initial compiler analysis did not become current');
  modelFingerprint = (await cli('model-install', model)).data.fingerprint;
  await cli('model-activate', repository, modelFingerprint);
  let covered = false;
  for (let retry = 0; retry < 600; retry++) {
    const response = await query('search_code', { query: 'TokenParser00000', mode: 'vector' }).catch(() => null);
    if (response?.data?.eligibleSymbolCount === symbols && response.data.vectorCoveredSymbolCount === symbols && !hasJobs(await status())) { covered = true; break; }
    await wait(250);
  }
  if (!covered) throw Error('Initial vector coverage did not settle');
  const target = (await query('find_symbol', { name: 'TokenParser00000' })).data.items[0].symbolId;
  console.error(`Measuring ${edits} watcher-observed body edits on ${symbols} symbols.`);
  for (let edit = 1; edit <= edits; edit++) {
    const prior = await status();
    const text = originals[0].replace('value + 0;', `value + ${100000 + edit};`);
    if (text === originals[0]) throw Error('Edit marker missing');
    const expectedHash = hash(Buffer.from(text));
    await writeFile(path.join(root, paths[0]), text);
    const start = performance.now(); // close of the final stable write
    let structuralMs = null, semanticMs = null, lastOldReadStart = 0;
    let sample;
    try {
      while (performance.now() - start < 30000) {
        const pollStart = performance.now() - start;
        // SOURCE_CHANGED during the stale window is expected, not swallowed.
        let source;
        try { source = await query('get_source', { symbolId: target }); }
        catch (error) {
          const response = JSON.parse(error.stdout || '{}');
          if (!['SOURCE_CHANGED', 'INDEX_STALE'].includes(response.error?.code)) throw error;
          source = response;
        }
        if (source.indexGeneration > prior.indexGeneration && source.data?.fragments?.[0]?.currentHash === expectedHash) {
          structuralMs = performance.now() - start;
          break;
        }
        lastOldReadStart = pollStart;
        await wait(25);
      }
      if (structuralMs === null) throw Error('Watcher publication timeout');
      while (performance.now() - start < 45000) {
        const response = await query('search_code', { query: 'TokenParser00000', mode: 'vector' });
        if (response.indexGeneration > prior.indexGeneration && response.data?.eligibleSymbolCount === symbols && response.data.vectorCoveredSymbolCount === symbols) {
          semanticMs = performance.now() - start;
          break;
        }
        await wait(25);
      }
      if (semanticMs === null) throw Error('Semantic refresh timeout');
      sample = { edit, structuralUpperBoundMs: structuralMs, editToVectorsUpperBoundMs: semanticMs,
        semanticRefreshUpperBoundMs: semanticMs - lastOldReadStart, expectedSourceHash: expectedHash, errors: 0 };
      // Let lease completion/heartbeat settle outside the next timed write.
      for (let retry = 0; retry < 120; retry++) { if (!hasJobs(await status())) break; await wait(50); }
    } catch (error) {
      sample = { edit, structuralUpperBoundMs: structuralMs, editToVectorsUpperBoundMs: semanticMs,
        elapsedMs: performance.now() - start, errors: 1, error: error.message };
      failures.push(error.message);
    }
    samples.push(sample);
    console.error(JSON.stringify(sample));
    if (sample.errors) break; // preserve failure; do not mix a backlog into later edits
  }
} catch (error) { failures.push(error.message); }
finally {
  if (owner?.pid && owner.exitCode === null && owner.signalCode === null) {
    // Signal-terminated children have a null exitCode even after close (Windows).
    // Subscribe before signalling, and bound both waits so reports still persist.
    const closed = new Promise(resolve => owner.once('close', resolve));
    owner.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    await Promise.race([closed, wait(5000)]);
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGKILL');
      await Promise.race([closed, wait(5000)]);
      if (owner.exitCode === null && owner.signalCode === null) failures.push('Owned service did not stop after kill escalation');
    }
  }
  const complete = samples.length === edits && samples.every(sample => !sample.errors) && failures.length === 0;
  const distribution = key => {
    const values = samples.map(sample => sample[key]).filter(value => value !== null && value !== undefined);
    return { count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99), maxMs: values.length ? Math.max(...values) : null };
  };
  const structural = distribution('structuralUpperBoundMs'), semantic = distribution('semanticRefreshUpperBoundMs');
  const gates = { noErrorsAndAllEditsMeasured: complete,
    fiveThousandSymbolWatcherBodyP95AtMost2Seconds: symbols === 5000 ? complete && structural.p95Ms <= 2000 : null,
    fiveThousandSymbolSemanticRefreshP95AtMost10Seconds: symbols === 5000 ? complete && semantic.p95Ms <= 10000 : null };
  const report = { version: 1, generatorVersion: 1, timestampUtc: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(), symbols, edits, corpusHash, referenceHash, modelFingerprint,
    serviceAssemblyHash: hash(await readFile(path.join(path.dirname(executable), 'Praxis.CodeIntelligence.dll'))),
    measurement: 'Owned native service, actual watcher/durable jobs; no explicit indexing after timed writes. CLI observation/IPC costs included. Structural detection and semantic refresh are conservative upper bounds, not exact publication timestamps.',
    structural, semanticRefresh: semantic, editToVectors: distribution('editToVectorsUpperBoundMs'), samples, failures, gates,
    passedMeasuredGates: Object.values(gates).every(value => value !== false),
    unmeasured: ['full concurrent-edit query workload', 'initial indexing/embedding latency', 'queue/inference/SQL/serialization percentiles', 'process peak RSS', 'five independent process runs'] };
  await mkdir(path.dirname(output), { recursive: true });
  try { await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  finally { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  if (!report.passedMeasuredGates) process.exitCode = 2;
  console.error(JSON.stringify({ output, gates }));
}
