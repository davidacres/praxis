#!/usr/bin/env node
// Transparent stdio tee. Only this explicitly configured executable records ACP traffic.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { now, readJson } from './format.mjs';
const config = readJson(process.env.PRAXIS_SESSION_LAB_CONFIG);
const file = path.join(config.privateDir, `tap-${process.pid}.jsonl`);
const fd = fs.openSync(file, 'wx', 0o600);
let seq = 0;
const record = value => fs.writeSync(fd, JSON.stringify({ seq: seq++, at: now() - config.origin, ...value }) + '\n');
const args = [...(config.args || []), ...process.argv.slice(2)];
record({ kind: 'spawn', command: config.command, args });
const child = spawn(config.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const tee = direction => new Transform({ transform(chunk, encoding, done) {
  try { record({ kind: 'bytes', direction, bytes: chunk.toString('base64') }); done(null, chunk); }
  catch (error) { done(error); }
} });
process.stdin.pipe(tee('to-agent')).pipe(child.stdin);
child.stdout.pipe(tee('from-agent')).pipe(process.stdout);
child.stderr.pipe(tee('stderr')).pipe(process.stderr);
child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error.message); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { record({ kind: 'spawn-error', message: error.message }); console.error(error.message); process.exitCode = 1; });
child.on('close', (code, signal) => {
  record({ kind: 'exit', code, signal });
  fs.closeSync(fd);
  process.stdin.destroy();
  process.exitCode = code ?? 1;
});
