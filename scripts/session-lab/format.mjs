import fs from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

export const VERSION = 1;
export const now = () => Number(process.hrtime.bigint()) / 1e6;
export function readJson(file) { return JSON.parse((String(file).endsWith('.br') ? brotliDecompressSync(fs.readFileSync(file)) : fs.readFileSync(file)).toString('utf8')); }
export function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
export function parseTap(rows) {
  const decoders = new Map();
  const buffers = new Map();
  const frames = [];
  for (const row of rows) {
    if (row.kind !== 'bytes' || row.direction === 'stderr') continue;
    const key = row.direction;
    if (!decoders.has(key)) decoders.set(key, new StringDecoder('utf8'));
    const buffer = (buffers.get(key) || '') + decoders.get(key).write(Buffer.from(row.bytes, 'base64'));
    const lines = buffer.split('\n');
    buffers.set(key, lines.pop());
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { throw new Error('Non-JSON ACP line in capture'); }
      frames.push({ at: row.at, direction: key, message });
    }
  }
  if ([...buffers.values()].some(value => value.trim())) throw new Error('Truncated ACP frame');
  return frames;
}

// Deliberately preserve token counts and usage, while removing credentials and local endpoints.
export function sanitizer(replacements = []) {
  const replace = text => {
    let result = text;
    for (const [original, substitute] of replacements.filter(([value]) => value).sort((a,b) => b[0].length-a[0].length)) {
      result = result.split(original).join(substitute);
    }
    return result
      .replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer <REDACTED>')
      .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, '<REDACTED>')
      .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"<>]*/g, 'http://127.0.0.1:1/redacted');
  };
  const visit = value => {
    if (typeof value === 'string') return replace(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      // ACP HTTP headers are sometimes {name, value} pairs.
      const secretHeader = /^(authorization|x-api-key|cookie)$/i.test(value.name || '');
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|token)$/i.test(key)
          || (secretHeader && key === 'value') ? '<REDACTED>' : visit(child)]));
    }
    return value;
  };
  return visit;
}

export function materialize(previous, change) {
  if (!change.eventsDelta) return structuredClone(change);
  const { eventsDelta, ...rest } = change;
  const old = previous?.events || [];
  if (old.length < eventsDelta.base) throw new Error('Session timeline has an event gap');
  const covered = Math.max(0, old.length - eventsDelta.base);
  return { ...rest, events: old.concat(eventsDelta.appended.slice(covered)) };
}

export function validateBundle(bundle) {
  if (bundle.schemaVersion !== VERSION) throw new Error('Unsupported recording schema');
  if (bundle.status !== 'complete') throw new Error('Recording is incomplete');
  if (!bundle.timeline?.length || bundle.checkpoints?.length !== 2) throw new Error('Missing timeline/checkpoints');
  let last = -Infinity;
  let state;
  for (const row of bundle.timeline) {
    if (!Number.isFinite(row.at) || row.at < last) throw new Error('Timeline is not ordered');
    last = row.at;
    state = materialize(state, row.payload);
  }
  if (state.state !== 'completed') throw new Error('Final session did not complete');
  return bundle;
}

export function loadTaps(directory) {
  return fs.readdirSync(directory).filter(name => /^tap-.*\.jsonl$/.test(name)).map(name => {
    const rows = fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const probe = rows[0]?.args?.some(arg => ['--version', '--help'].includes(arg));
    return { name, rows, frames: probe ? [] : parseTap(rows) };
  });
}
