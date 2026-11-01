import test from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).window = globalThis;
const { notesSession, flush } = await import('../src/notes/notesSession.ts');

type Outcome = { ok: true; value: { id: string; projectId: string; title: string; body: string } } | { ok: false; message: string };
const calls: string[] = [];
let gate: Promise<void> | undefined;
let failing = false;
const note = (id: string, title: string, body: string): Outcome => ({ ok: true, value: { id, projectId: 'p', title, body } });
(globalThis as any).__notesApi = {
  async create(_p: string, title: string, body: string): Promise<Outcome> {
    calls.push(`create:${body}`);
    await gate;
    return failing ? { ok: false, message: 'disk full' } : note('n1', title, body);
  },
  async update(_p: string, id: string, title: string, body: string): Promise<Outcome> {
    calls.push(`update:${body}`);
    await gate;
    return failing ? { ok: false, message: 'disk full' } : note(id, title, body);
  }
};

const state = () => notesSession.getSnapshot();
async function reset() {
  failing = false; gate = undefined; calls.length = 0;
  await flush();
  if (state().dirty) { notesSession.edit({ title: '', body: '' }); }
  await notesSession.startNew('p');
  if (state().dirty || state().draft.noteId) { failing = false; await flush(); await notesSession.startNew('p'); }
  calls.length = 0;
}

test('an edit made during an in-flight save is saved again afterwards', async () => {
  await reset();
  let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  notesSession.edit({ body: 'one' }, 'p');
  const first = flush();
  await Promise.resolve();
  notesSession.edit({ body: 'one two' });
  release(); gate = undefined;
  await first;
  await flush();
  assert.deepEqual(calls, ['create:one', 'update:one two']);
  assert.equal(state().dirty, false);
  assert.equal(state().save, 'saved');
});

test('a failed save keeps the draft and blocks open and startNew', async () => {
  await reset();
  failing = true;
  notesSession.edit({ body: 'precious' }, 'p');
  await flush();
  assert.equal(state().save, 'error');
  assert.equal(state().dirty, true);
  await notesSession.startNew('p');
  await notesSession.open({ id: 'other', projectId: 'p', title: 't', body: 'other body' } as never);
  assert.equal(state().draft.body, 'precious');
  failing = false;
  await flush();
  assert.equal(state().save, 'saved');
});

test('concurrent flush calls do not create the note twice', async () => {
  await reset();
  notesSession.edit({ body: 'once' }, 'p');
  await Promise.all([flush(), flush(), flush()]);
  assert.deepEqual(calls, ['create:once']);
  assert.equal(state().draft.noteId, 'n1');
});
