import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTestRunSummary, summarizeTestRun } from './testRunnerSummary';

/** The shape of a real smoke run (WF-C1A4F13F QA): evidence capped at its head, so failure 1) is gone. */
function playwrightOutput(failures: Array<[string, string]>, passed: number): string {
  const blocks = failures.map(([title, waiting], i) => [
    `  ${i + 38}) [smoke] › ${title} ──────────────`,
    '',
    '    Error: locator.click: Target page, context or browser has been closed',
    '    Call log:',
    `      - waiting for ${waiting}`,
    '',
    '    Retry #1 ───────────────────',
    ''
  ].join('\n'));
  return [
    ...blocks,
    `  ${failures.length} failed`,
    ...failures.map(([title]) => `    [smoke] › ${title} ──────────`),
    `  ${passed} passed (20.3m)`,
    'npm error Lifecycle script `test:e2e` failed with error:',
    'npm error code 1'
  ].join('\n');
}

test('a large Playwright failure leads with the count, the specs and the shared cause', () => {
  const failures: Array<[string, string]> = [];
  for (let i = 0; i < 9; i++) failures.push([`e2e/app.spec.ts:${100 + i}:5 › app test ${i}`, "getByTestId('board-nav-item').first()"]);
  for (let i = 0; i < 4; i++) failures.push([`e2e/folder.spec.ts:${60 + i}:5 › folder test ${i}`, `locator('[data-testid="board-nav-item"]').filter({ hasText: 'Folder' })`]);
  failures.push(['e2e/gitGraph.spec.ts:113:5 › renders the graph', "getByTestId('project-tree')"]);

  const summary = summarizeTestRun(playwrightOutput(failures, 110));
  assert.ok(summary);
  assert.equal(summary.failed, 14);
  assert.equal(summary.passed, 110);
  assert.equal(summary.failures.length, 14);
  assert.equal(summary.failures[0], 'e2e/app.spec.ts:100:5 › app test 0');
  assert.deepEqual(summary.causes[0], { cause: 'waiting for test id "board-nav-item"', count: 13 });

  const text = formatTestRunSummary(summary)!;
  assert.match(text, /^14 of 124 tests failed \(110 passed\)\./);
  assert.match(text, /Failed in 3 spec files: app\.spec\.ts \(9\), folder\.spec\.ts \(4\), gitGraph\.spec\.ts \(1\)\./);
  assert.match(text, /13× waiting for test id "board-nav-item"/);
});

test('a few failures are listed by name', () => {
  const summary = summarizeTestRun(playwrightOutput([['e2e/folder.spec.ts:64:5 › folder board lists the fixture feature task', "getByTestId('x')"]], 12))!;
  const text = formatTestRunSummary(summary)!;
  assert.match(text, /^1 of 13 tests failed \(12 passed\)\./);
  assert.match(text, /• e2e\/folder\.spec\.ts:64 › folder board lists the fixture feature task/);
});

test('flaky and did-not-run counts are reported but a flaky-only run is not a failure summary', () => {
  const out = '  2 flaky\n    [smoke] › e2e/a.spec.ts:1:1 › a\n  3 did not run\n  40 passed (1m)\n';
  const summary = summarizeTestRun(out)!;
  assert.equal(summary.flaky, 2);
  assert.equal(summary.didNotRun, 3);
  assert.equal(summary.failures.length, 0);
  assert.equal(formatTestRunSummary(summary), undefined);
});

test('node:test spec reporter counts are read', () => {
  const summary = summarizeTestRun('✖ failing tests:\n\nℹ tests 5\nℹ pass 3\nℹ fail 2\n')!;
  assert.equal(summary.failed, 2);
  assert.equal(summary.passed, 3);
  assert.match(formatTestRunSummary(summary)!, /^2 of 5 tests failed \(3 passed\)\./);
});

test('output with no runner summary is left to the raw tail', () => {
  assert.equal(summarizeTestRun('error TS2304: Cannot find name foo.\n'), undefined);
});
