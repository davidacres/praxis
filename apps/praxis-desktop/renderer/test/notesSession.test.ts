import test from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).window = globalThis;
const { notesSession, flush, restoreUnsavedDraft, UNSAVED_DRAFT_KEY } = await import('../src/notes/notesSession.ts');

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

test('forget resets the draft only when the deleted note is the open one', async () => {
  await reset();
  notesSession.edit({ body: 'keep me' }, 'p');
  await flush();
  assert.equal(state().draft.noteId, 'n1');
  notesSession.forget('other');
  assert.equal(state().draft.body, 'keep me');
  notesSession.forget('n1');
  assert.deepEqual(state().draft, { projectId: 'p', title: '', body: '' });
  assert.equal(state().dirty, false);
});

test('renameOpen saves the new title through the shared draft', async () => {
  await reset();
  notesSession.edit({ body: 'text' }, 'p');
  await flush();
  calls.length = 0;
  await notesSession.renameOpen('n1', 'Renamed');
  assert.deepEqual(calls, ['update:text']);
  assert.equal(state().draft.title, 'Renamed');
  assert.equal(state().save, 'saved');
});

test('unsaved text is mirrored to storage and restored after a restart', async () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); }
  };
  try {
    await reset();
    failing = true;
    notesSession.edit({ body: 'survive restart' }, 'p');
    await flush();
    assert.equal(JSON.parse(store.get(UNSAVED_DRAFT_KEY)!).body, 'survive restart');
    failing = false;
    await flush();
    assert.equal(store.has(UNSAVED_DRAFT_KEY), false);

    await notesSession.startNew('p'); // a fresh launch begins blank
    store.set(UNSAVED_DRAFT_KEY, JSON.stringify({ projectId: 'p', title: '', body: 'from last run' }));
    assert.equal(restoreUnsavedDraft(), true);
    await flush();
    assert.equal(state().save, 'saved');
    assert.equal(calls.at(-1), 'create:from last run');
  } finally {
    delete (globalThis as any).localStorage;
  }
});
