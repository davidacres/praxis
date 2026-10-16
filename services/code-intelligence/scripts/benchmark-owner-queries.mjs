// Owner-path query latency: a real native owner indexes a synthetic corpus with
// its own durable jobs, then timed queries cross the local owner protocol
// (socket, token handshake, admission queue, dispatch and JSON framing) from
// persistent client code rather than a process per query. Also samples the
// owner process's resident memory, which is the production process budget.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
const execute = promisify(execFile);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--executable', '--model', '--reference', '--output', '--symbols', '--queries'].includes(key) || !value || options.has(key)) throw Error('Invalid benchmark arguments');
  options.set(key, value);
}
for (const key of ['--executable', '--model', '--reference', '--output']) if (!options.has(key)) throw Error(`Missing ${key}`);
if (process.platform === 'win32') throw Error('This runner speaks the Unix-socket owner endpoint; Windows named pipes are not implemented here');
const executable = path.resolve(options.get('--executable')), model = path.resolve(options.get('--model'));
const reference = path.resolve(options.get('--reference')), output = path.resolve(options.get('--output'));
const symbols = Number(options.get('--symbols') ?? 49999), queries = Number(options.get('--queries') ?? 200);
if (!output.endsWith('.praxis.json')) throw Error('Output must end in .praxis.json');
if (!Number.isInteger(symbols) || symbols < 100 || symbols > 49999 || !Number.isInteger(queries) || queries < 20 || queries > 1000 || queries % 4) throw Error('Symbols 100–49999; queries 20–1000 divisible by four');
try { await access(output); throw Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pci-owner-benchmark-'));
const root = path.join(fixture, 'source'), data = path.join(fixture, 'data');
await mkdir(root);
const cli = async (...args) => JSON.parse((await execute(executable, [...args, '--data', data], { timeout: 125000, maxBuffer: 4 << 20 })).stdout);
let owner, rssSampler; const rss = [];

// One request per connection, exactly as the native client does.
function request(token, body) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(data, 'owner.sock')); const chunks = []; let received = 0, expected = null;
    socket.once('error', reject);
    socket.on('connect', () => {
      const payload = Buffer.from(JSON.stringify({ token, request: body })); const header = Buffer.alloc(4); header.writeInt32LE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on('data', chunk => {
      chunks.push(chunk); received += chunk.length;
      const all = Buffer.concat(chunks);
      if (expected === null && all.length >= 4) expected = all.readInt32LE(0);
      if (expected !== null && all.length >= expected + 4) { socket.end(); resolve(JSON.parse(all.subarray(4, 4 + expected).toString('utf8'))); }
    });
    socket.on('end', () => { if (expected === null || received < expected + 4) reject(Error('Owner closed the connection without a complete response')); });
  });
}

const report = { version: 1, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length,
  memoryBytes: os.totalmem(), timestampUtc: new Date().toISOString(), symbols, queriesPerMode: queries,
  measurement: 'Native owner over its local Unix-socket protocol from a persistent client; includes connect, token handshake, admission, dispatch and framing. Setup is untimed.' };
try {
  const paths = [], hashes = []; let remaining = symbols - 1, ordinal = 0;
  while (remaining > 0) {
    const name = `Corpus${String(paths.length).padStart(4, '0')}`, relative = name + '.cs'; let text = `public class ${name} {\n`;
    const count = Math.min(99, remaining - 1);
    for (let index = 0; index < count; index++, ordinal++)
      text += `/// <summary>Parse authentication token category ${ordinal}.</summary>\npublic static int TokenParser${String(ordinal).padStart(5, '0')}(int value) => value + ${ordinal};\n`;
    text += '}\n'; await writeFile(path.join(root, relative), text); paths.push(relative); hashes.push(relative + ':' + hash(Buffer.from(text))); remaining -= count + 1;
  }
  report.corpusHash = hash(Buffer.from(hashes.join('\n')));
  const referenceHash = hash(await readFile(reference));
  await writeFile(path.join(root, 'context.praxis.json'), JSON.stringify({ version: 1, projects: [{ key: 'benchmark', assemblyName: 'Benchmark', sources: paths, metadata: [{ path: reference, contentHash: referenceHash }] }] }));
  owner = spawn(executable, ['serve', '--data', data], { stdio: 'ignore' });
  rssSampler = setInterval(async () => {
    try { const { stdout } = await execute('ps', ['-o', 'rss=', '-p', String(owner.pid)]); const kib = Number(stdout.trim()); if (kib) rss.push({ atMs: Math.round(performance.now()), bytes: kib * 1024 }); } catch { }
  }, 1000);
  for (let retry = 0; retry < 150; retry++) { try { await access(path.join(data, 'owner.json')); break; } catch { await wait(100); } }
  const repository = (await cli('register', root, '--manifest', 'context.praxis.json')).data.repositoryId;
  const status = async () => (await cli('query', 'get_index_status', JSON.stringify({ repositoryId: repository, responseBudgetTokens: 8000 })));
  const settled = response => response.freshness?.state === 'current' && !(response.data?.jobsByState?.pending || response.data?.jobsByState?.leased);
  let started = performance.now(), current;
  for (let retry = 0; retry < 2400 && !settled(current = await status()); retry++) await wait(250);
  if (!settled(current)) throw Error('Initial analysis did not become current');
  report.ownerInitialIndexMs = performance.now() - started;
  const fingerprint = (await cli('model-install', model)).data.fingerprint; report.modelFingerprint = fingerprint;
  await cli('model-activate', repository, fingerprint); started = performance.now();
  const { token } = JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8'));
  const search = (query, mode) => request(token, { action: 'query', tool: 'search_code', arguments: { repositoryId: repository, query, mode, limit: 10, responseBudgetTokens: 8000 } });
  let covered = false;
  for (let retry = 0; retry < 7200 && !covered; retry++) {
    const response = await search('TokenParser00000', 'vector').catch(() => null);
    covered = response?.data?.vectorCoveredSymbolCount === symbols && settled(await status());
    if (!covered) await wait(500);
  }
  if (!covered) throw Error('Vector coverage did not settle');
  report.ownerVectorsMs = performance.now() - started;
  const categories = { exact: index => `TokenParser${String(index % (symbols - 1)).padStart(5, '0')}`, terminology: index => `authentication token category ${index % 16}` };
  report.groups = [];
  for (const [category, queryFor] of Object.entries(categories))
    for (const clients of [1, 4])
      for (const mode of ['lexical', 'hybrid']) {
        for (let i = 0; i < 20; i++) await search(queryFor(i * 17), mode); // warmup
        const times = [], errors = [];
        await Promise.all(Array.from({ length: clients }, async (_, client) => {
          for (let i = 0; i < queries / clients; i++) {
            const begin = performance.now();
            try {
              const response = await search(queryFor((i * clients + client) * 17), mode);
              if (response.error || !Array.isArray(response.data?.matches)) errors.push(response.error?.code ?? 'MALFORMED');
              else if (mode === 'hybrid' && !response.data.channelsUsed?.includes('vector')) errors.push('NO_VECTOR_CHANNEL');
            } catch (error) { errors.push(error.message); }
            finally { times.push(performance.now() - begin); }
          }
        }));
        const group = { category, clients, mode, count: times.length, errors: errors.length, errorSamples: errors.slice(0, 5),
          p50Ms: percentile(times, .5), p95Ms: percentile(times, .95), p99Ms: percentile(times, .99), maximumMs: Math.max(...times) };
        report.groups.push(group); console.error(JSON.stringify(group));
      }
  report.gates = {
    noQueryErrors: report.groups.every(group => group.errors === 0),
    lexicalP95AtMost100Ms: report.groups.filter(group => group.mode === 'lexical').every(group => group.p95Ms <= 100),
    hybridP95AtMost500Ms: report.groups.filter(group => group.mode === 'hybrid').every(group => group.p95Ms <= 500)
  };
} finally {
  clearInterval(rssSampler);
  if (owner) { owner.kill(); await wait(1000); }
  await rm(fixture, { recursive: true, force: true });
}
report.ownerPeakRssSampledBytes = rss.length ? Math.max(...rss.map(sample => sample.bytes)) : null;
report.ownerRssSamplingNote = 'ps sampled once per second; short peaks between samples are not captured';
report.unmeasured = ['retrieval-only owner phases (owner reports no timings)', 'concurrent edits through the owner', 'Windows named-pipe transport', 'MCP stdio/provider framing'];
report.passedMeasuredGates = Object.values(report.gates ?? { failed: false }).every(Boolean);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, passedMeasuredGates: report.passedMeasuredGates, gates: report.gates }));
if (!report.passedMeasuredGates) process.exitCode = 2;
