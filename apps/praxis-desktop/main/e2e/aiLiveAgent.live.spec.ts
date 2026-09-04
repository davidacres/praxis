/**
 * The one test that uses a real model.
 *
 * Everything else in this suite proves the harness with a scripted ACP fixture:
 * the ticket reaches an agent, the agent's file I/O is sandboxed and gated, the
 * edit lands on disk. What that cannot show is whether a real agent, given a
 * real ticket, does something useful with it. This does.
 *
 * It spends real model calls on whichever account the CLI agent is signed in
 * to, and takes minutes. It is excluded from every other Playwright project and
 * refuses to run without an explicit opt-in:
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent
 *
 * Override the adapter with PRAXIS_LIVE_AGENT_CMD (default `claude-agent-acp`).
 * The task is deliberately small and self-verifying: the repository ships a
 * failing `node --test` suite, and the ticket asks for it to pass. Success is
 * measured by running that suite afterwards, not by reading the agent's prose.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const AGENT_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';

/** A slugifier that only handles the easy case; three of the four tests fail. */
const BROKEN_SOURCE = `function slugify(title) {
  return title.toLowerCase().replace(/ /g, '-');
}

module.exports = { slugify };
`;

const TEST_SOURCE = `const test = require('node:test');
const assert = require('node:assert');
const { slugify } = require('./slugify');

test('lowercases and hyphenates', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses repeated spaces', () => {
  assert.equal(slugify('Hello   World'), 'hello-world');
});

test('trims leading and trailing whitespace', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
});

test('drops punctuation', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});
`;

let app: TestApp | undefined;
let repo: string | undefined;

/** Runs the repository's own test suite; the ticket is done when this passes. */
function runRepoTests(cwd: string): { ok: boolean; output: string } {
  const result = spawnSync('node', ['--test'], { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test.beforeAll(() => {
  test.skip(
    process.env.PRAXIS_LIVE_AGENT !== '1',
    'Live agent test: set PRAXIS_LIVE_AGENT=1 to spend real model calls.'
  );
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

test('a real agent takes a ticket and makes the failing suite pass', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-agent-'));
  fs.writeFileSync(path.join(repo, 'slugify.js'), BROKEN_SOURCE);
  fs.writeFileSync(path.join(repo, 'slugify.test.js'), TEST_SOURCE);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  // The suite really is failing before the agent touches it.
  const before = runRepoTests(repo);
  expect(before.ok, 'the seeded repository should start with a failing suite').toBe(false);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(
    command => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: command } } } }),
    AGENT_COMMAND
  );

  const goal = [
    'slugify() in slugify.js produces malformed slugs.',
    'It does not collapse repeated spaces, does not trim surrounding whitespace,',
    'and leaves punctuation in the output.',
    '',
    'Fix slugify.js so the existing suite passes: `node --test`.',
    'Do not modify slugify.test.js.'
  ].join('\n');

  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: { goal, maxSteps: 40, timeoutMs: 480000 }
    }),
    { goal, cwd: repo }
  );
  const key = session.issueKey;

  // Approve tool use as a watching user would, and wait for the turn to end.
  const deadline = Date.now() + 480000;
  let state: string | undefined;
  for (;;) {
    state = await win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state),
      key
    );
    if (state === 'completed' || state === 'failed' || state === 'aborted') break;
    if (Date.now() > deadline) break;
    if (state === 'awaiting_approval') {
      await win.evaluate(k => window.praxis.ai.respondToPermission(k, 'allow_always'), key);
    }
    await win.waitForTimeout(2000);
  }

  const record = await win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)),
    key
  );
  const after = runRepoTests(repo);
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim();

  // Everything needed to judge the run, whether it passed or not.
  console.log('--- live agent run ---------------------------------------');
  console.log(`state:      ${state}`);
  console.log(`steps:      ${record?.stepCount ?? 0}`);
  console.log(`files:      ${changed || '(none)'}`);
  console.log(`suite:      ${after.ok ? 'PASSING' : 'still failing'}`);
  console.log(`reply:      ${(record?.responseText ?? '').slice(0, 800)}`);
  console.log('slugify.js:\n' + fs.readFileSync(path.join(repo, 'slugify.js'), 'utf8'));
  if (!after.ok) console.log(after.output.slice(0, 2000));
  console.log('----------------------------------------------------------');

  expect(state, 'the session should reach a terminal state').toBe('completed');
  // The measure of success: the repository's own suite, not the agent's prose.
  expect(after.ok, `node --test still failing:\n${after.output.slice(0, 2000)}`).toBe(true);
  // And it fixed the source rather than deleting the test that caught it.
  expect(changed).toContain('slugify.js');
  expect(changed).not.toContain('slugify.test.js');
});

test('a real agent handles a multi-file change and uses the shell', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-multi-'));

  // Three files, one shared defect: each formats a name its own way, and none
  // handles a missing middle name. The suite pins the behaviour they should
  // share, so fixing it properly means touching all three.
  fs.writeFileSync(path.join(repo, 'greet.js'), `function greet(first, middle, last) {
  return 'Hello ' + first + ' ' + middle + ' ' + last;
}

module.exports = { greet };
`);
  fs.writeFileSync(path.join(repo, 'sign.js'), `function sign(first, middle, last) {
  return 'Regards, ' + first + ' ' + middle + ' ' + last;
}

module.exports = { sign };
`);
  fs.writeFileSync(path.join(repo, 'label.js'), `function label(first, middle, last) {
  return first + ' ' + middle + ' ' + last;
}

module.exports = { label };
`);
  fs.writeFileSync(path.join(repo, 'names.test.js'), `const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('./greet');
const { sign } = require('./sign');
const { label } = require('./label');

test('greet skips a missing middle name', () => {
  assert.equal(greet('Ada', undefined, 'Lovelace'), 'Hello Ada Lovelace');
});

test('sign skips a missing middle name', () => {
  assert.equal(sign('Ada', '', 'Lovelace'), 'Regards, Ada Lovelace');
});

test('label skips a missing middle name', () => {
  assert.equal(label('Ada', null, 'Lovelace'), 'Ada Lovelace');
});

test('all three keep a middle name when present', () => {
  assert.equal(greet('Ada', 'B', 'Lovelace'), 'Hello Ada B Lovelace');
  assert.equal(sign('Ada', 'B', 'Lovelace'), 'Regards, Ada B Lovelace');
  assert.equal(label('Ada', 'B', 'Lovelace'), 'Ada B Lovelace');
});
`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  expect(runRepoTests(repo).ok, 'the seeded repository should start failing').toBe(false);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(
    command => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: command } } } }),
    AGENT_COMMAND
  );

  const goal = [
    'greet(), sign() and label() each build a full name, and all three break when',
    'the middle name is missing — they leave a double space.',
    '',
    'Fix all three so a missing middle name is skipped. Run `node --test` to check',
    'your work; the suite must pass. Do not modify names.test.js.'
  ].join('\n');

  const session = await win.evaluate(
    async ({ goal, cwd }) => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: { goal, maxSteps: 60, timeoutMs: 480000 }
    }),
    { goal, cwd: repo }
  );
  const key = session.issueKey;

  const deadline = Date.now() + 480000;
  let state: string | undefined;
  for (;;) {
    state = await win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state),
      key
    );
    if (state === 'completed' || state === 'failed' || state === 'aborted') break;
    if (Date.now() > deadline) break;
    if (state === 'awaiting_approval') {
      await win.evaluate(k => window.praxis.ai.respondToPermission(k, 'allow_always'), key);
    }
    await win.waitForTimeout(2000);
  }

  const record = await win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)),
    key
  );
  const after = runRepoTests(repo);
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim();
  // Did it actually run anything itself, rather than editing blind?
  const ranShell = (record?.events ?? []).some(event =>
    event.type === 'tool_start' && /bash|shell|terminal|execute|run/i.test(event.summary ?? '')
  );

  console.log('--- live agent: multi-file ---------------------------------');
  console.log(`state:   ${state}`);
  console.log(`steps:   ${record?.stepCount ?? 0}`);
  console.log(`files:   ${changed.replace(/\n/g, ' | ') || '(none)'}`);
  console.log(`suite:   ${after.ok ? 'PASSING' : 'still failing'}`);
  console.log(`shell:   ${ranShell ? 'used' : 'not used'}`);
  console.log(`tools:   ${(record?.events ?? []).filter(e => e.type === 'tool_start').map(e => e.summary).join(' | ')}`);
  if (!after.ok) console.log(after.output.slice(0, 1500));
  console.log('------------------------------------------------------------');

  expect(state, 'the session should reach a terminal state').toBe('completed');
  expect(after.ok, `node --test still failing:\n${after.output.slice(0, 1500)}`).toBe(true);
  // All three sources changed, and the test file left alone.
  for (const file of ['greet.js', 'sign.js', 'label.js']) {
    expect(changed, `${file} should have been modified`).toContain(file);
  }
  expect(changed).not.toContain('names.test.js');
});
