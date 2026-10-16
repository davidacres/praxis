// Independent query-only processes against a verified retained snapshot.
// Never indexes, changes source, migrates storage or installs a model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const execute = promisify(execFile);
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--dotnet', '--benchmark', '--fixture', '--output', '--runs', '--queries', '--categories'].includes(process.argv[i])
      || !process.argv[i + 1] || options.has(process.argv[i])) throw Error('Invalid matrix arguments');
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ['--dotnet', '--benchmark', '--fixture', '--output']) if (!options.has(key)) throw Error(`Missing ${key}`);
const benchmark = path.resolve(options.get('--benchmark')), fixture = await realpath(options.get('--fixture'));
const requestedOutput = path.resolve(options.get('--output'));
const output = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
const relativeOutput = path.relative(fixture, output);
if (!relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput)) throw Error('Output must be outside the retained fixture');
if (!output.endsWith('.praxis.json')) throw Error('Output must end in .praxis.json');
const runs = Number(options.get('--runs') ?? 5), queries = Number(options.get('--queries') ?? 200);
if (!Number.isInteger(runs) || runs < 1 || runs > 5 || !Number.isInteger(queries) || queries < 200 || queries > 1000 || queries % 4) throw Error('Runs 1–5; queries 200–1000 divisible by four');
const categories = (options.get('--categories') ?? 'exact,terminology,behaviour,negative').split(',');
if (new Set(categories).size !== categories.length || categories.some(category => !['exact', 'terminology', 'behaviour', 'negative'].includes(category))) throw Error('Unsupported/duplicate categories');
try { await access(output); throw Error('Output exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await access(benchmark); await access(path.join(fixture, 'benchmark-fixture.praxis.json'));
const artifacts = output.slice(0, -'.praxis.json'.length) + '-runs';
await mkdir(path.dirname(output), { recursive: true });
await mkdir(artifacts); // Refuse existing artifacts; no previous measurement is overwritten.
const hash = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const assemblyHash = hash(await readFile(path.join(path.dirname(benchmark), 'Praxis.CodeIntelligence.dll')));
const samples = [], failures = [];
try {
  for (const category of categories) for (const readers of [1, 4]) for (let run = 1; run <= runs; run++) {
    const name = `${category}-${readers}-readers-run-${run}`;
    const reportPath = path.join(artifacts, name + '.praxis.json');
    const args = [benchmark, '--reuse-fixture', fixture, '--category', category, '--readers', String(readers),
      '--runs', '1', '--queries', String(queries / readers), '--output', reportPath];
    let exitCode = 0, stdout = '', stderr = '';
    console.error(`Measuring ${name}; ${queries} timed queries per mode.`);
    try { ({ stdout, stderr } = await execute(options.get('--dotnet'), args, { timeout: 600_000, maxBuffer: 512 * 1024 })); }
    catch (error) { exitCode = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; }
    await writeFile(path.join(artifacts, name + '.log'), stdout + stderr, { flag: 'wx' });
    let report;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch { failures.push({ name, exitCode, error: 'No valid raw report; see log' }); continue; }
    if (![0, 2].includes(exitCode)) failures.push({ name, exitCode, error: 'Unexpected process exit' });
    if (report.QueryCategory !== category || report.Readers !== readers || report.RunCount !== 1
        || report.Lexical.Count !== queries || report.Hybrid?.Count !== queries) failures.push({ name, error: 'Measurement shape mismatch' });
    if (report.Lexical.QueryPhases?.Count !== queries || report.Hybrid?.QueryPhases?.Count !== queries) failures.push({ name, error: 'Missing timed phase samples' });
    samples.push({ category, readers, run, exitCode, rawReport: path.relative(path.dirname(output), reportPath), report });
  }
} finally {
  const groups = categories.flatMap(category => [1, 4].map(readers => {
    const selected = samples.filter(sample => sample.category === category && sample.readers === readers);
    const range = mode => {
      const values = selected.map(sample => sample.report[mode]?.P95Ms).filter(Number.isFinite);
      return { minP95Ms: values.length ? Math.min(...values) : null, maxP95Ms: values.length ? Math.max(...values) : null };
    };
    return { category, readers, completedProcesses: selected.length, lexical: range('Lexical'), hybrid: range('Hybrid'),
      querySetHashes: [...new Set(selected.map(sample => sample.report.QuerySetHash))] };
  }));
  const snapshots = new Set(samples.map(sample => JSON.stringify([sample.report.Generation, sample.report.QueryEpoch,
    sample.report.SnapshotHash, sample.report.ModelFingerprint, sample.report.SearchPlanVersion, sample.report.ReadMappingVersion])));
  if (snapshots.size > 1) failures.push({ error: 'Mixed snapshot/model/search configuration' });
  for (const category of categories) {
    if (new Set(samples.filter(sample => sample.category === category).map(sample => sample.report.QuerySetHash)).size > 1)
      failures.push({ category, error: 'Reader counts used different query sets' });
  }
  const complete = samples.length === categories.length * 2 * runs && failures.length === 0;
  const report = { version: 1, timestampUtc: new Date().toISOString(), assemblyHash, runs, queriesPerModePerProcess: queries,
    freshProcessPerRun: true, queryScheduleVersion: 2, categories, groups, failures,
    completeRequestedMatrix: complete, passedMeasuredGates: complete && samples.every(sample => sample.report.PassedMeasuredGates),
    unmeasured: ['cross-project performance category', 'concurrent edit workload', 'owner admission queue', 'wire serialization', 'cold indexing and full-process RSS', 'reference-machine performance'],
    samples };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (!report.passedMeasuredGates) process.exitCode = 2;
  console.error(JSON.stringify({ output, complete, passedMeasuredGates: report.passedMeasuredGates }));
}
