import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const dotnet = process.env.PRAXIS_DOTNET ?? 'dotnet';
const binary = path.resolve('services/code-intelligence/benchmarks/Praxis.CodeIntelligence.Benchmarks/bin/Release/net10.0/Praxis.CodeIntelligence.Benchmarks.dll');
const output = await mkdtemp(path.join(tmpdir(), 'pci-retained-smoke-'));
let fixture;
const invoke = async args => {
  try { const result = await execute(dotnet, [binary, ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); return { ...result, code: 0 }; }
  catch (error) { if (error.killed || (error.code === undefined && !error.signal)) throw error; return error; }
};
try {
  const generated = await invoke(['--symbols', '100', '--queries', '10', '--retain-fixture', 'true',
    '--output', path.join(output, 'initial.praxis.json'),
    ...(process.env.PRAXIS_MODEL_BUNDLE ? ['--model', process.env.PRAXIS_MODEL_BUNDLE] : [])]);
  assert.ok(generated.code === 0 || generated.code === 2, generated.stderr);
  fixture = generated.stderr.split(/\r?\n/).find(line => line.startsWith('Retained synthetic fixture: '))?.slice('Retained synthetic fixture: '.length);
  assert.ok(fixture && /^praxis-benchmark-[a-f0-9]{32}$/.test(path.basename(fixture)));
  assert.equal(await realpath(path.dirname(fixture)), await realpath(tmpdir()));
  const marker = path.join(fixture, 'benchmark-fixture.praxis.json');
  const originalMarker = await readFile(marker, 'utf8'); const metadata = JSON.parse(originalMarker);
  const run = async name => {
    const destination = path.join(output, `${name}.praxis.json`);
    const result = await invoke(['--reuse-fixture', fixture, '--queries', '10', '--output', destination]);
    assert.ok(result.code === 0 || result.code === 2, result.stderr);
    return JSON.parse(await readFile(destination, 'utf8'));
  };
  const first = await run('first'); const second = await run('second');
  assert.equal(first.SnapshotHash, second.SnapshotHash);
  assert.equal(first.Generation, metadata.Generation); assert.equal(first.QueryEpoch, metadata.QueryEpoch);
  assert.equal(second.Generation, first.Generation); assert.equal(second.QueryEpoch, first.QueryEpoch);
  assert.equal(first.Lexical.Count, 40);
  if (process.env.PRAXIS_MODEL_BUNDLE) assert.equal(first.Hybrid.Count, 40);
  assert.ok(first.Unmeasured.includes('cold startup/index/embedding'));
  const refuse = async (name, message) => {
    const destination = path.join(output, `${name}.praxis.json`);
    const result = await invoke(['--reuse-fixture', fixture, '--queries', '10', '--output', destination]);
    assert.ok(result.code !== 0 && result.code !== 2, result.stderr);
    assert.match(result.stderr, message);
    await assert.rejects(access(destination));
  };
  const source = path.join(fixture, 'source', Object.keys(metadata.Files).find(file => file.endsWith('.cs')));
  const original = await readFile(source);
  try { await writeFile(source, Buffer.concat([original, Buffer.from('\n')])); await refuse('changed-source', /source bytes changed/); }
  finally { await writeFile(source, original); }
  const extra = path.join(fixture, 'source', 'Unexpected.cs');
  try { await writeFile(extra, 'class Unexpected {}'); await refuse('membership', /source membership changed/); }
  finally { await rm(extra, { force: true }); }
  try { await writeFile(marker, JSON.stringify({ ...metadata, QueryEpoch: metadata.QueryEpoch + 1 })); await refuse('epoch', /index snapshot changed/); }
  finally { await writeFile(marker, originalMarker); }
  await run('restored');
  console.log('Retained benchmark smoke passed: real queries, repeatable snapshot, source/membership/epoch rejection and restoration.');
} finally {
  // Delete only a fixture with this harness's known generated identity and parent.
  if (fixture && /^praxis-benchmark-[a-f0-9]{32}$/.test(path.basename(fixture))
      && await realpath(path.dirname(fixture)) === await realpath(tmpdir())) await rm(fixture, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
}
