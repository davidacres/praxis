import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./benchmark-query-matrix.mjs', import.meta.url));

test('matrix retains failed runs, matches reader workloads and refuses fixture writes/overwrites', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pci-matrix-test-'));
  try {
    const fixture = path.join(temporary, 'fixture'); await mkdir(fixture);
    await writeFile(path.join(fixture, 'benchmark-fixture.praxis.json'), '{}');
    await writeFile(path.join(temporary, 'Praxis.CodeIntelligence.dll'), 'fixture');
    const mock = path.join(temporary, 'benchmark.cjs');
    await writeFile(mock, `const fs=require('node:fs');const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);const count=Number(args.get('--queries'))*Number(args.get('--readers'));const timing={Count:count,P95Ms:20,QueryPhases:{Count:count}};fs.writeFileSync(args.get('--output'),JSON.stringify({QueryCategory:args.get('--category'),Readers:Number(args.get('--readers')),RunCount:1,Lexical:timing,Hybrid:timing,QuerySetHash:'same-queries',SnapshotHash:'same-source',Generation:1,QueryEpoch:1,ModelFingerprint:'same-model',SearchPlanVersion:5,ReadMappingVersion:5,PassedMeasuredGates:false,pid:process.pid}));process.exitCode=2;`);
    const output = path.join(temporary, 'matrix.praxis.json');
    const args = [runner, '--dotnet', process.execPath, '--benchmark', mock, '--fixture', fixture,
      '--output', output, '--runs', '1', '--categories', 'exact'];
    await assert.rejects(execute(process.execPath, args), error => error.code === 2);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.completeRequestedMatrix, true);
    assert.equal(report.passedMeasuredGates, false);
    assert.equal(report.samples.length, 2);
    assert.equal(new Set(report.samples.map(sample => sample.report.pid)).size, 2);
    assert.ok(report.samples.every(sample => sample.report.Lexical.Count === 200));
    for (const sample of report.samples) await readFile(path.join(temporary, sample.rawReport));
    const original = await readFile(output, 'utf8');
    await assert.rejects(execute(process.execPath, args), /Output exists/);
    assert.equal(await readFile(output, 'utf8'), original);
    const protectedArgs = [...args]; protectedArgs[protectedArgs.indexOf('--output') + 1] = path.join(fixture, 'forbidden.praxis.json');
    await assert.rejects(execute(process.execPath, protectedArgs), /outside the retained fixture/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
