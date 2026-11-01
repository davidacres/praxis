import test from 'node:test';
import assert from 'node:assert/strict';
import { changedHunkText, coChangedTests, isTestFile, parsePlannedTests, sourceHooks, testReferences } from './affectedTests';

test('test files are recognised by the common runners\' conventions', () => {
  for (const file of ['e2e/notes.spec.ts', 'src/a.test.tsx', 'src/__tests__/b.js', 'tests/test_api.py', 'pkg/api_test.go']) assert.ok(isTestFile(file), file);
  for (const file of ['src/Shelf.tsx', 'node_modules/x/a.test.js', 'docs/testing.md']) assert.ok(!isTestFile(file), file);
});

test('a plan\'s tests to keep passing are read from under their heading only', () => {
  const plan = [
    '# Plan', '1. Change `src/Shelf.tsx`.', '',
    '## Tests to keep passing',
    '- `apps/main/e2e/sessionShelfNotes.spec.ts` — uses note-save-state',
    '- apps/main/e2e/sidebarNotes.spec.ts:41 (groups)',
    '- `src/Shelf.tsx` is not a test',
    '', '## Risks', '- `e2e/other.spec.ts` is mentioned here, not listed', '', 'Plan status: ready'
  ].join('\n');
  assert.deepEqual(parsePlannedTests(plan), ['apps/main/e2e/sessionShelfNotes.spec.ts', 'apps/main/e2e/sidebarNotes.spec.ts']);
  assert.deepEqual(parsePlannedTests('# Plan\nNo tests section.'), []);
});

test('UI hooks come from test ids, distinctive labels and classes; a one-word label does not count', () => {
  const hooks = sourceHooks('<div className="session-shelf__rail active"><button data-testid="shelf-new" aria-label="Close">x</button><input placeholder="Search notes" /></div>\nexport function NotesSection() {}\nexport { helperOne as renamedHelper };');
  assert.deepEqual(hooks.uiHooks, ['shelf-new', 'Search notes']);
  assert.deepEqual(hooks.classNames, ['session-shelf__rail']);
  assert.deepEqual(hooks.exports, ['NotesSection', 'renamedHelper']);
});

test('a test is linked by a hook it uses, a class it selects, or a module it imports — not by a shared word', () => {
  const changed = [{ file: 'src/notes/NoteEditor.tsx', hooks: { uiHooks: ['note-save-state'], classNames: ['note-editor__title'], exports: ['NoteEditor', 'menu'] } }];
  assert.deepEqual(testReferences("await page.getByTestId('note-save-state')", changed), ['uses "note-save-state" from src/notes/NoteEditor.tsx']);
  assert.deepEqual(testReferences("page.locator('.note-editor__title')", changed), ['selects .note-editor__title from src/notes/NoteEditor.tsx']);
  assert.deepEqual(testReferences("import { NoteEditor } from '../src/notes/NoteEditor';\nrender(<NoteEditor />)", changed), ['imports src/notes/NoteEditor.tsx and uses NoteEditor']);
  assert.deepEqual(testReferences("const menu = page.getByRole('menu'); // NoteEditor mentioned in a comment", changed), []);
  assert.deepEqual(testReferences("page.locator('.note-editor__title-row')", changed), [], 'a longer class is a different class');
});

test('hooks are read from the changed hunks, not the diff headers', () => {
  const diff = ['diff --git a/x.tsx b/x.tsx', '--- a/x.tsx', '+++ b/x.tsx', '@@ -1,3 +1,3 @@', ' <div>', '-  <b data-testid="old-id" />', '+  <b data-testid="new-id" />', ' </div>'].join('\n');
  assert.deepEqual(sourceHooks(changedHunkText(diff)).uiHooks, ['old-id', 'new-id']);
});

test('tests that keep changing with a file are picked, but a sweeping commit says nothing', () => {
  const commits = [
    ['src/Shelf.tsx', 'e2e/shelf.spec.ts'],
    ['src/Shelf.tsx', 'e2e/shelf.spec.ts', 'src/other.ts'],
    ['src/Shelf.tsx', 'e2e/shelf.spec.ts'],
    ['src/Shelf.tsx', 'e2e/board.spec.ts'],
    Array.from({ length: 30 }, (_, i) => (i === 0 ? 'src/Shelf.tsx' : `e2e/sweep${i}.spec.ts`))
  ];
  assert.deepEqual(coChangedTests(commits, ['src/Shelf.tsx']), [{ file: 'e2e/shelf.spec.ts', reasons: ['changed with these files in 3 commits'] }]);
});
