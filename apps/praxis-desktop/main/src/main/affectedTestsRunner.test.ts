import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkflowCheckNode } from '@praxis/core';
import { runAffectedTests, selectAffectedTests } from './affectedTestsRunner';

function repo(files: Record<string, string>): { root: string; commit: (message: string, changes: Record<string, string>) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-affected-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  const commit = (message: string, changes: Record<string, string>) => {
    for (const [file, text] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  commit('initial', files);
  return { root, commit };
}

const shelf = (label: string) => `export function Shelf() {\n  return <div>\n    <button data-testid="shelf-new">+</button>\n    <span data-testid="note-save-state">${label}</span>\n  </div>;\n}\n`;

test('an end-to-end test that drives a changed element is picked by its test id, and one that does not is not', async () => {
  const { root, commit } = repo({
    'src/Shelf.tsx': shelf('Saved'),
    'e2e/shelfNotes.spec.ts': "test('saves', async () => { await page.getByTestId('note-save-state').waitFor(); });\n",
    'e2e/board.spec.ts': "test('board', async () => { await page.getByTestId('board-column').waitFor(); });\n"
  });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  commit('change the save state', { 'src/Shelf.tsx': shelf('Saved just now') });

  const selection = await selectAffectedTests(root, base);
  assert.deepEqual(selection.tests.map(t => t.file), ['e2e/shelfNotes.spec.ts']);
  assert.match(selection.tests[0].reasons[0], /uses "note-save-state" from src\/Shelf\.tsx/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the plan\'s tests to keep passing are picked even when nothing in the diff points at them', async () => {
  const { root, commit } = repo({ 'src/a.ts': 'export const one = 1;\n', 'test/flow.test.ts': 'it("x", () => {});\n' });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  commit('change', { 'src/a.ts': 'export const one = 2;\n' });
  const plan = '# Plan\n\n## Tests to keep passing\n- `test/flow.test.ts` — drives the flow a.ts feeds\n- `test/missing.test.ts` — gone\n\nPlan status: ready\n';
  const selection = await selectAffectedTests(root, base, plan);
  assert.deepEqual(selection.tests, [{ file: 'test/flow.test.ts', reasons: ['listed in the plan'] }], 'a listed file that does not exist is ignored');
  fs.rmSync(root, { recursive: true, force: true });
});

test('each test file runs once, in the first Playwright project that includes it, and a failure fails the result', async () => {
  const { root, commit } = repo({
    'app/playwright.config.ts': 'export default {};\n',
    'app/package.json': '{}',
    'app/e2e/one.spec.ts': "getByTestId('shelf-new')\n",
    'src/Shelf.tsx': shelf('Saved')
  });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  commit('change', { 'src/Shelf.tsx': shelf('Saved').replace('+', 'New') });
  const selection = await selectAffectedTests(root, base);
  assert.deepEqual(selection.tests.map(t => t.file), ['app/e2e/one.spec.ts']);

  const ran: string[] = [];
  const result = await runAffectedTests(root, selection, {
    spawn: async (node: WorkflowCheckNode, cwd: string) => {
      ran.push(`${path.relative(root, cwd)}: ${node.command} ${node.args?.join(' ')}`);
      if (node.args?.includes('--list')) {
        return {
          code: 0, timedOut: false,
          output: JSON.stringify({
            config: { projects: [{ name: 'functional' }, { name: 'smoke' }] },
            suites: [{ file: 'one.spec.ts', specs: [{ file: 'one.spec.ts', tests: [{ projectName: 'smoke' }, { projectName: 'functional' }] }] }]
          })
        };
      }
      return { code: 1, timedOut: false, output: '1 failed' };
    }
  });
  assert.deepEqual(ran, [
    'app: npx playwright test --list --reporter=json e2e/one.spec.ts',
    'app: npx playwright test --project=functional e2e/one.spec.ts'
  ]);
  assert.equal(result.code, 1);
  assert.match(result.output, /== Tests for this change ==\n- app\/e2e\/one\.spec\.ts: uses "shelf-new"/);
  assert.match(result.output, /1 failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a test no runner claims is listed, not run, and does not fail the result', async () => {
  const { root, commit } = repo({ 'src/Shelf.tsx': shelf('Saved'), 'test/shelf.test.ts': "getByTestId('note-save-state')\n" });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  commit('change', { 'src/Shelf.tsx': shelf('Done') });
  const result = await runAffectedTests(root, await selectAffectedTests(root, base), { spawn: async () => { throw new Error('should not run'); } });
  assert.equal(result.code, 0);
  assert.match(result.output, /Not run here .*test\/shelf\.test\.ts/);
  fs.rmSync(root, { recursive: true, force: true });
});
