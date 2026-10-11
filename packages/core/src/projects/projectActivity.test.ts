import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../host/stateStore';
import { GIT_ACTIVITY_LOG_FORMAT, mergeActivity, parseGitActivity, ProjectActivityStore } from './projectActivity';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
}
const entry = (projectId: string, targetKey = 'A-1') => ({ projectId, targetKey, kind: 'issue' as const, action: 'Created', summary: 'Test' });

test('records only observed history and preserves recording start across reopening', async () => {
  const state = memoryStore();
  let now = Date.UTC(2026, 0, 1);
  const store = new ProjectActivityStore(state, () => now);
  const first = await store.open('a');
  assert.deepEqual(first.entries, []);
  now += 86_400_000;
  const reopened = await new ProjectActivityStore(state, () => now).open('a');
  assert.equal(first.startedAt, reopened.startedAt);
});
test('isolates projects and retains the latest 1000 entries', async () => {
  const store = new ProjectActivityStore(memoryStore());
  await Promise.all(Array.from({ length: 1003 }, (_, index) => store.append(entry('a', `A-${index}`))));
  await store.append(entry('b', 'B-1'));
  assert.equal(store.list('a').entries.length, 1000);
  assert.equal(store.list('a').entries[0].targetKey, 'A-1002');
  assert.deepEqual(store.list('b').entries.map(row => row.targetKey), ['B-1']);
});
test('prunes entries older than 30 days from persisted storage on opening', async () => {
  const state = memoryStore();
  let now = Date.UTC(2026, 0, 1);
  const store = new ProjectActivityStore(state, () => now);
  await store.append(entry('a'));
  now += 31 * 86_400_000;
  assert.equal((await store.open('a')).entries.length, 0);
  assert.equal(state.get<{ entries: unknown[] }>('activity:a')?.entries.length, 0);
});
test('concurrent opens and mutations never overwrite recorded entries', async () => {
  const store = new ProjectActivityStore(memoryStore());
  await Promise.all([store.open('a'), store.append(entry('a', 'A-1')), store.open('a'), store.append(entry('a', 'A-2'))]);
  assert.deepEqual(store.list('a').entries.map(row => row.targetKey), ['A-2', 'A-1']);
});
test('attributes commits to you, an agent, or a named outside author from real git output', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-activity-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'Me');
  const commit = (message: string, author: string) => git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message, '--author', author);
  commit('Mine', 'Me <me@example.com>');
  commit('Pair work\n\nCo-authored-by: Claude <noreply@anthropic.com>', 'Me <me@example.com>');
  commit('Theirs', 'Sam Lee <sam@example.com>');
  const entries = parseGitActivity(git('log', `--format=${GIT_ACTIVITY_LOG_FORMAT}`), 'p', 'ME@example.com');
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(entries.map(row => [row.summary, row.kind, row.actor, row.actorName]), [
    ['Theirs', 'commit', 'external', 'Sam Lee'],
    ['Pair work', 'commit', 'agent', undefined],
    ['Mine', 'commit', 'you', undefined]
  ]);
  assert.match(entries[0].targetKey, /^[0-9a-f]{40}$/);
});
test('skips malformed git records and merges derived entries newest first', () => {
  assert.deepEqual(parseGitActivity('not-a-hash\x1fx\x1fy\x1fnope\x1fs\x1f\x1e', 'p'), []);
  const stored = { startedAt: '2026-01-01T00:00:00.000Z', entries: [{ id: 's', projectId: 'p', kind: 'issue' as const, targetKey: 'A-1', summary: 'S', action: 'Created', timestamp: '2026-01-02T00:00:00.000Z' }] };
  const merged = mergeActivity(stored, [{ id: 'c', projectId: 'p', kind: 'commit', targetKey: 'abc1234', summary: 'C', action: 'Committed', timestamp: '2026-01-03T00:00:00.000Z' }]);
  assert.deepEqual(merged.entries.map(row => row.id), ['c', 's']);
  assert.equal(mergeActivity(stored, []), stored);
});
