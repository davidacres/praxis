import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// All mutable data lives in a disposable directory, never in the checkout.
export async function smokeNativeIpc(executable) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'pci-'));
  const data = path.join(temporary, 'data');
  const source = path.join(temporary, 'source');
  let owner;
  let ownerOutput = '';
  const invoke = async (args, { input, expectedExit = 0 } = {}) => {
    let result;
    try {
      const pending = execute(executable, [...args, '--data', data], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      pending.child.stdin.end(input);
      result = await pending;
      result.code = 0;
    } catch (error) {
      if (error.killed || typeof error.code !== 'number') throw error;
      result = error;
    }
    assert.equal(result.code, expectedExit, `${args[0]}: ${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const start = async () => {
    ownerOutput = '';
    owner = spawn(executable, ['serve', '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    const current = owner;
    current.on('error', error => { ownerOutput += error.message; });
    for (const stream of [current.stdout, current.stderr]) stream.on('data', chunk => { ownerOutput = (ownerOutput + chunk).slice(-8192); });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (current.exitCode !== null || current.signalCode !== null) throw new Error(`Owner exited: ${ownerOutput}`);
      try { await access(path.join(data, 'owner.json')); return; } catch { await delay(100); }
    }
    throw new Error(`Owner startup timed out: ${ownerOutput}`);
  };
  const stop = async () => {
    if (!owner) return;
    const current = owner; owner = undefined;
    if (current.exitCode === null && current.signalCode === null) {
      const closed = once(current, 'close');
      current.kill('SIGINT');
      const force = setTimeout(() => current.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(force); }
    }
    // Remove a rendezvous left by forced termination only after this owner exits.
    await rm(path.join(data, 'owner.json'), { force: true });
  };
  try {
    await mkdir(source);
    await writeFile(path.join(source, 'Example.cs'), 'public class SmokeExample { public int Compute() => 42; }\n');
    await start();
    const registered = await invoke(['register', source]);
    const repositoryId = registered.data.repositoryId;
    assert.equal(typeof repositoryId, 'string');
    const indexed = await invoke(['index', repositoryId]);
    assert.ok(indexed.data, JSON.stringify(indexed));
    const query = { tool: 'search_code', arguments: { repositoryId, query: 'SmokeExample', mode: 'lexical' } };
    const search = () => invoke(['query', query.tool, JSON.stringify(query.arguments)]);
    const assertMatch = response => assert.ok(response.data?.matches?.some(match => match.symbol?.qualifiedName?.includes('SmokeExample')), JSON.stringify(response));
    for (const response of await Promise.all(Array.from({ length: 4 }, search))) assertMatch(response);
    const rpc = expectedExit => invoke(['rpc', '--client', 'codex'], { input: JSON.stringify(query), expectedExit });
    assert.equal((await rpc(5)).error.code, 'ACCESS_DENIED');
    await invoke(['grant', repositoryId, '--client', 'codex']);
    assertMatch(await rpc(0));
    await invoke(['revoke', repositoryId, '--client', 'codex']);
    assert.equal((await rpc(5)).error.code, 'ACCESS_DENIED');
    const before = await invoke(['status', repositoryId]);
    assert.ok(before.indexGeneration > 0);
    const backup = path.join(temporary, 'backup.db');
    await invoke(['backup', backup]);
    assert.ok((await stat(backup)).size > 0);
    assert.equal((await readFile(backup)).subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.deepEqual((await invoke(['doctor'])).data.checks, []);
    await stop();
    await start();
    assert.equal((await invoke(['status', repositoryId])).indexGeneration, before.indexGeneration);
    assertMatch(await search());
    assert.equal((await rpc(5)).error.code, 'ACCESS_DENIED');
    await invoke(['unregister', repositoryId]);
    assert.deepEqual((await invoke(['list'])).data, []);
    process.stdout.write('Native IPC smoke passed: indexing, concurrent search, consent, backup, restart and unregister.\n');
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node smoke-native-ipc.mjs <packaged executable>');
  await smokeNativeIpc(path.resolve(process.argv[2]));
}
