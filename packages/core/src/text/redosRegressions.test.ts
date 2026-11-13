import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseNextLinkEntry, trimEdgeChars, trimLeadingChars, trimTrailingChars } from './linearText';
import { isTestFile, parsePlannedTests, sourceHooks } from '../workflows/affectedTests';
import { readEnvironmentBlock, readPlanStatus } from '../workflows/workflowStageTask';
import { parsePublishablePlan } from '../workflows/workflowPlanPublishing';
import {
  extractBranchRaw,
  extractComplexityRaw,
  extractMainHeading,
  extractPlanningDates,
  extractStatusRaw
} from '../folder/markdownPlanParser';
import { writeStatusToMarkdownFile } from '../folder/markdownStatusWriter';
import { workspaceFileName } from '../workspaces/workspaceTypes';
import { suggestedProjectName } from '../projects/projectImportPlanner';
import { resolveSharedSettingsPath } from '../config/appSettings';
import { parseNextLink } from '../marketplace/registryClient';
import { parseGitHubNextLink } from '../github/githubApiService';

/** Fails when `run` takes long enough to show super-linear backtracking on a 50,000 character input. */
function finishesQuickly<T>(run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${Math.round(elapsed)}ms`);
  return result;
}

const N = 50_000;

test('linear text helpers trim only the listed characters', () => {
  assert.equal(trimLeadingChars('--a-', '-'), 'a-');
  assert.equal(trimTrailingChars('--a--', '-'), '--a');
  assert.equal(trimEdgeChars('*`_x_`*', '*`_'), 'x');
  assert.equal(trimEdgeChars('abc', '-'), 'abc');
  assert.equal(trimEdgeChars('---', '-'), '');
  assert.equal(trimTrailingChars('a//\\', '\\/'), 'a');
  finishesQuickly(() => trimEdgeChars('-'.repeat(N) + 'x' + '-'.repeat(N), '-'));
  finishesQuickly(() => trimTrailingChars('/'.repeat(N) + 'x', '/'));
});

test('a Link header entry yields its rel="next" target', () => {
  assert.equal(parseNextLinkEntry('<https://x/y?page=2>; rel="next"'), 'https://x/y?page=2');
  assert.equal(parseNextLinkEntry('<https://x/y>;rel="next"'), 'https://x/y');
  assert.equal(parseNextLinkEntry('<https://x/y>; rel="prev"'), undefined);
  assert.equal(parseNextLinkEntry('<>; rel="next"'), undefined);
  assert.equal(parseNextLinkEntry('<<a>; rel="next"'), '<a');
  assert.equal(parseNextLinkEntry('<a>b>; rel="next"'), undefined);
  assert.equal(parseNextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"'), 'https://a/3');
  assert.equal(parseGitHubNextLink('<https://a/1>; rel="prev", <https://a/3>; rel="next"'), 'https://a/3');
  assert.equal(parseGitHubNextLink(null), undefined);
  for (const hostile of ['<'.repeat(N), '>'.repeat(N), '<a>'.repeat(N / 3), `<${'a'.repeat(N)}>;${' '.repeat(N)}x`]) {
    assert.equal(finishesQuickly(() => parseNextLinkEntry(hostile)), undefined);
    assert.equal(finishesQuickly(() => parseNextLink(hostile)), undefined);
    assert.equal(finishesQuickly(() => parseGitHubNextLink(hostile)), undefined);
  }
});

test('slugs, paths and base urls trim their edges the way the regexes did', () => {
  assert.equal(workspaceFileName('  My Team!! '), 'my-team.workspace.praxis.json');
  assert.equal(workspaceFileName('---'), 'workspace.workspace.praxis.json');
  assert.equal(suggestedProjectName('/home/me/my-app//'), 'my app');
  assert.equal(suggestedProjectName('C:\\work\\thing_one\\'), 'thing one');
  assert.equal(resolveSharedSettingsPath('linux', { home: '/home/me', XDG_CONFIG_HOME: '/cfg//' }), '/cfg///praxis/settings.json');
  assert.equal(resolveSharedSettingsPath('win32', { home: 'C:\\Users\\me', APPDATA: 'C:\\A\\' }), 'C:\\A\\\\praxis\\settings.json');
  assert.equal(finishesQuickly(() => workspaceFileName('-'.repeat(N) + 'a' + '-'.repeat(N))), 'a.workspace.praxis.json');
  assert.equal(finishesQuickly(() => workspaceFileName('!'.repeat(N))), 'workspace.workspace.praxis.json');
  assert.equal(finishesQuickly(() => suggestedProjectName('/'.repeat(N))), 'Imported Project');
  finishesQuickly(() => resolveSharedSettingsPath('linux', { home: '/'.repeat(N) }));
});

test('test files under __tests__ are recognised, and long paths stay fast', () => {
  assert.ok(isTestFile('src/__tests__/b.js'));
  assert.ok(isTestFile('__tests__/deep/c.tsx'));
  assert.ok(!isTestFile('src/__tests__/.js'));
  assert.ok(!isTestFile('src/__tests__/readme.md'));
  assert.ok(!isTestFile('src/not__tests__/a.js'));
  assert.ok(isTestFile('src/__tests__/__tests__/a.ts'));
  assert.ok(!isTestFile('__tests__/a\n.ts'));
  assert.equal(finishesQuickly(() => isTestFile('__tests__/'.repeat(N / 10) + 'x')), false);
  assert.equal(finishesQuickly(() => isTestFile('__tests__/' + '.'.repeat(N))), false);
  assert.equal(finishesQuickly(() => isTestFile('__tests__/' + 'a.'.repeat(N / 2) + 'ts')), true);
});

test('planned tests are read from mentions, with headings in any decoration', () => {
  const plan = (heading: string, ...items: string[]): string => [heading, ...items, '## Risks', '- `e2e/other.spec.ts`'].join('\n');
  for (const heading of ['## Tests to keep passing', '**Tests to keep passing**', '  #   tests to keep passing:', 'Tests to keep passing']) {
    assert.deepEqual(parsePlannedTests(plan(heading, '- `a/b.spec.ts`')), ['a/b.spec.ts'], heading);
  }
  assert.deepEqual(parsePlannedTests(plan('## Tests to keep passing', '- tests/test_api.py and pkg/api_test.go, e2e/x.spec.tsx:41:2.')), ['tests/test_api.py', 'pkg/api_test.go', 'e2e/x.spec.tsx']);
  assert.deepEqual(parsePlannedTests(plan('## Tests to keep passing', '- ./src/a.test.js, `./b/c.spec.ts` and `not a path.spec.ts`')), ['src/a.test.js', 'b/c.spec.ts', 'path.spec.ts']);
  assert.deepEqual(parsePlannedTests(plan('## Tests to keep passing', '- a/b.spec.ts/c/d.test.js')), ['a/b.spec.ts/c/d.test.js'].filter(isTestFile));
  assert.deepEqual(parsePlannedTests(plan('## Tests to keep passing', '- mytest_foo.py x_test.go')), ['test_foo.py', 'x_test.go']);
  assert.deepEqual(parsePlannedTests(plan('## Tests to keep passing', '- x.spec.ts.')), ['x.spec.ts']);
  assert.deepEqual(parsePlannedTests('## Tests to keep passing\n- `src/Shelf.tsx` only'), []);

  const hostile = [
    ' '.repeat(N) + 'x',
    'a.'.repeat(N / 2),
    'a/'.repeat(N / 2),
    'a_'.repeat(N / 2),
    'a-'.repeat(N / 2) + '.py',
    'a.spec.tsa.spec.ts'.repeat(N / 18),
    'a_test.go'.repeat(N / 9),
    '` '.repeat(N / 2),
    '`'.repeat(N),
    'x/'.repeat(N / 2) + 'y.spec.ts'
  ];
  for (const line of hostile) {
    finishesQuickly(() => parsePlannedTests(`## Tests to keep passing\n- ${line}`));
  }
  finishesQuickly(() => parsePlannedTests(' '.repeat(N) + '#'));
  finishesQuickly(() => parsePlannedTests('\t'.repeat(N) + 'tests to keep passing\n' + ' '.repeat(N)));
  // Many segments, each with a test marker: one chained path, not N paths.
  assert.equal(finishesQuickly(() => parsePlannedTests(`## Tests to keep passing\n- ${'a.spec.ts/'.repeat(N / 10)}b.spec.ts`)).length, 1);
});

test('class names and export aliases are read from source, and hostile source stays fast', () => {
  const hooks = sourceHooks('<i className="row session-shelf__rail a-b ab_ x-y_z-long"/>\nexport { one as renamedHelper, two   as   spacedName, plain, three as as asName, bad as };');
  assert.deepEqual(hooks.classNames, ['session-shelf__rail', 'x-y_z-long']);
  assert.deepEqual(hooks.exports, ['renamedHelper', 'spacedName', 'plain']);
  finishesQuickly(() => sourceHooks(`<i className="${' '.repeat(190)}x"/>`));
  finishesQuickly(() => sourceHooks(`export { ${' '.repeat(N)}x };`));
  finishesQuickly(() => sourceHooks(`export { ${'a '.repeat(N / 2)} };`));
  finishesQuickly(() => sourceHooks(`export { ${'as '.repeat(N / 3)} };`));
  finishesQuickly(() => sourceHooks(`export { ${'a-'.repeat(N / 2)} };`));
});

test('a blocked-environment line gives its reason, however it is decorated', () => {
  assert.equal(readEnvironmentBlock('Done.\nStage status: blocked-environment: docker is missing'), 'docker is missing');
  assert.equal(readEnvironmentBlock('**Stage status: blocked-environment: need a token**'), 'need a token');
  assert.equal(readEnvironmentBlock('Progress made. `Stage status:   Blocked-Environment  :  no network` '), 'no network');
  assert.equal(readEnvironmentBlock('word Stage status: blocked-environment: nope'), undefined);
  assert.equal(readEnvironmentBlock('Stage status: blocked-environment'), 'no reason given');
  assert.equal(readEnvironmentBlock('Stage status: blocked-environment: work is incomplete'), undefined);
  assert.equal(readEnvironmentBlock('Stage status: blocked-environment: first\nStage status: blocked-environment: second'), 'second');
  assert.equal(readEnvironmentBlock('Stage status: ready'), undefined);
  for (const hostile of [
    'Stage status:'.repeat(N / 13),
    ' '.repeat(N) + 'x',
    `Stage status:${' '.repeat(N)}x`,
    `Stage status: blocked-environment${' '.repeat(N)}x${' '.repeat(N)}`,
    `${'*'.repeat(N)}x${'*'.repeat(N)}`,
    '.'.repeat(N),
    `.${' *'.repeat(N / 2)}Stage status: blocked-environment: why`
  ]) {
    finishesQuickly(() => readEnvironmentBlock(hostile));
  }
  assert.equal(readEnvironmentBlock(`Stage status: blocked-environment: ${'*'.repeat(N)}`), 'no reason given');
});

test('a plan status line is read through markdown decoration', () => {
  assert.deepEqual(readPlanStatus('plan\n**Plan status: ready**'), { ready: true });
  assert.deepEqual(readPlanStatus('`Plan status: blocked: no repo`'), { ready: false, reason: 'it reported itself blocked: no repo' });
  finishesQuickly(() => readPlanStatus(`${'`'.repeat(N)}x${'*'.repeat(N)}`));
  finishesQuickly(() => readPlanStatus(`${' '.repeat(N)}\n${'_'.repeat(N)}`));
});

test('the last praxis-plan block is found, and unclosed fences stay fast', () => {
  const plan = (body: string): string => `intro\n\`\`\`praxis-plan json\n${body}\n\`\`\`\ntail`;
  const first = '{"feature":{"title":"A"},"items":[{"title":"one"}]}';
  const second = '{"feature":{"title":"B"},"items":[{"title":"two"}]}';
  assert.equal(parsePublishablePlan(`${plan(first)}\n${plan(second)}`).feature.title, 'B');
  assert.throws(() => parsePublishablePlan('no block here'), /praxis-plan/);
  assert.throws(() => parsePublishablePlan('```praxis-plan\n'.repeat(N / 15)), /praxis-plan/);
  assert.throws(() => parsePublishablePlan('```praxis-plan' + 'x'.repeat(N)), /praxis-plan/);
});

test('plan fields are read from marker lines, including blank-valued ones', () => {
  assert.equal(extractMainHeading('# Title here\nbody'), 'Title here');
  assert.equal(extractMainHeading('#\n# Real\n'), '# Real');
  assert.equal(extractMainHeading('no heading'), 'Untitled');
  assert.equal(extractStatusRaw('**Status:**   In Progress  \n'), 'In Progress');
  assert.equal(extractStatusRaw('**Status:**\n**Branch:** x'), '**Branch:** x');
  assert.equal(extractBranchRaw('a\r\n**Branch:** feat/x\r\n'), 'feat/x');
  assert.equal(extractBranchRaw('**Branch:**   \n'), undefined);
  assert.equal(extractComplexityRaw('**Complexity:** M'), 'M');
  assert.equal(extractStatusRaw('---\nstatus: "Done"\n---\n**Status:** To Do'), 'Done');
  assert.equal(extractStatusRaw('---   \r\nstatus: Done\r\n---  \r\nbody'), 'Done');
  assert.equal(extractStatusRaw('---\n\n---\n**Status:** To Do'), 'To Do');
  assert.equal(extractStatusRaw('---\n\nstatus: Blocked\n\n---'), 'Blocked');
  assert.equal(extractStatusRaw('---status: x\n---\n'), '');
  assert.equal(extractStatusRaw('---\nstatus: x\n--- trailing\n'), '');
  assert.equal(extractStatusRaw('---\nstatus: x\n---'), 'x');
  const dates = extractPlanningDates('**Created:** 2026-01-02\n**Done:** 2026-02-03');
  assert.equal(dates.created?.slice(0, 10), '2026-01-02');
  assert.equal(dates.completed?.slice(0, 10), '2026-02-03');

  const hostile = [
    `**Status:**${' '.repeat(N)}`,
    `**Status:**${' '.repeat(N)}\n`,
    `#${' '.repeat(N)}`,
    `---${' '.repeat(N)}x`,
    `---${' '.repeat(N)}\nstatus: x\n---${' '.repeat(N)}x`,
    `---\n${'\n---x'.repeat(N / 5)}`,
    `---\nstatus: x${'\n---'.repeat(N / 4)} y`,
    `---${'\n'.repeat(N)}`,
    `${'**Status:**'.repeat(N / 11)}`,
    `${'**Depends on:**  \n'.repeat(N / 18)}`,
    `${'**Created:**  \n'.repeat(N / 14)}`
  ];
  for (const text of hostile) {
    finishesQuickly(() => extractStatusRaw(text));
    finishesQuickly(() => extractMainHeading(text));
    finishesQuickly(() => extractBranchRaw(text));
    finishesQuickly(() => extractPlanningDates(text));
  }
});

test('writing a status keeps front matter quoting, and long values stay fast', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'praxis-redos-'));
  try {
    const write = async (content: string): Promise<string> => {
      const file = path.join(dir, 'plan.md');
      await writeFile(file, content, 'utf8');
      await writeStatusToMarkdownFile(file, 'Done');
      return readFile(file, 'utf8');
    };
    assert.match(await write('---\nstatus: In Progress\n---\n**Status:** x\n'), /^---\nstatus: Done\n---\n\*\*Status:\*\* ✅ Complete/);
    assert.match(await write('---\nstatus: "In Progress"  \n---\n**Status:** x\n'), /^---\nstatus: "Done"\n---/);
    assert.match(await write("---\nstatus:   'a b'\r\n---\r\n**Status:** x\r\n"), /^---\nstatus:   'Done'\r\n---/);
    assert.match(await write('---\nstatus: "unterminated\n---\n**Status:** x\n'), /^---\nstatus: Done\n---/);
    assert.match(await write('---\nstatus: "\n---\n**Status:** x\n'), /^---\nstatus: Done\n---/);
    assert.match(await write('---\nstatus: a\' \n---\n**Status:** x\n'), /^---\nstatus: Done\n---/);
    assert.match(await write('---\ntitle: t\n---\n**Status:** x\n'), /^---\ntitle: t\n---\n\*\*Status:\*\* ✅ Complete/);
    for (const padded of [' '.repeat(N), '"' + ' '.repeat(N), '"a' + ' '.repeat(N) + '"', '\t '.repeat(N / 2) + 'x']) {
      const started = performance.now();
      const result = await write(`---\nstatus: ${padded}\n---\n**Status:** x\n`);
      assert.ok(performance.now() - started < 200);
      assert.match(result, /status: .*Done/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
