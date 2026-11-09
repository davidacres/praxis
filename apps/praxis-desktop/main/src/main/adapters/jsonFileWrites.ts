import * as path from 'node:path';

/** One local writer queue per document, shared by settings and extension-key stores. */
const writes = new Map<string, Promise<void>>();

export async function withJsonFileWrite<T>(file: string, write: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const next = (writes.get(key) ?? Promise.resolve()).then(write);
  const settled = next.then(() => undefined, () => undefined);
  writes.set(key, settled);
  try { return await next; }
  finally { if (writes.get(key) === settled) writes.delete(key); }
}
