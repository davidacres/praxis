/**
 * Live proof that a real AI can hand a Praxis session to another real AI.
 *
 * The mock-gateway e2e covers the dialogs. This is the spendy half: two signed-in
 * CLI agents, one ticket, one worktree.
 *
 * 1. Fix addition, then the receiver finishes multiplication.
 * 2. Implement `clean()`, then the receiver finishes `display()` which depends on it.
 *
 * Excluded from every ordinary Playwright project. Refuses to run without:
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent e2e/aiLiveHandover.live.spec.ts
 *
 * Providers (both must be signed in):
 *   PRAXIS_LIVE_AGENT_CMD          first CLI (default `claude-agent-acp` → claude-code-cli)
 *   PRAXIS_LIVE_HANDOVER_TO        second provider id (default `codex-cli`)
 *   PRAXIS_LIVE_HANDOVER_CMD       second CLI (default `codex-acp`, or `copilot` for copilot-cli)
 *
 * Success is `node --test` after handover, plus a `provider_handover` epoch —
 * not the agents' prose.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const SOURCE_PROVIDER = 'claude-code-cli';
const SOURCE_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';
const TARGET_PROVIDER = process.env.PRAXIS_LIVE_HANDOVER_TO ?? 'codex-cli';
const TARGET_COMMAND = process.env.PRAXIS_LIVE_HANDOVER_CMD
  ?? (TARGET_PROVIDER === 'copilot-cli' ? 'copilot'
    : TARGET_PROVIDER === 'claude-code-cli' ? SOURCE_COMMAND
      : 'codex-acp');

const ADD_SOURCE = `function add(a, b) {
  return a - b;
}

module.exports = { add };
`;

const MUL_SOURCE = `function mul(a, b) {
  return a + b;
}

module.exports = { mul };
`;

const ADD_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { add } = require('./add');

test('adds', () => {
  assert.equal(add(2, 3), 5);
});
`;

const MUL_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { mul } = require('./mul');

test('multiplies', () => {
  assert.equal(mul(2, 3), 6);
});
`;

const CLEAN_SOURCE = `function clean(text) {
  return text;
}

module.exports = { clean };
`;

const DISPLAY_SOURCE = `const { clean } = require('./clean');

function display(first, last) {
  return first + ' ' + last;
}

module.exports = { display };
`;

const CLEAN_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { clean } = require('./clean');

test('trims and collapses spaces', () => {
  assert.equal(clean('  Ada   Lovelace  '), 'Ada Lovelace');
});
`;

const DISPLAY_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { display } = require('./display');

test('formats Last, First after cleaning', () => {
  assert.equal(display('  Ada ', ' Lovelace '), 'Lovelace, Ada');
});
`;

const TURN_MS = 240000;

let app: TestApp | undefined;
let repo: string | undefined;

function commandAvailable(command: string): boolean {
  if (!command) return false;
  if (path.isAbsolute(command)) return fs.existsSync(command);
  const probe = process.platform === 'win32' ? ['where', command] : ['which', command];
  return spawnSync(probe[0], probe.slice(1), { encoding: 'utf8' }).status === 0;
}

function runRepoTests(cwd: string, files?: string[]): { ok: boolean; output: string } {
  const args = ['--test', ...(files ?? [])];
  const result = spawnSync('node', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const CLI_PROVIDERS = new Set(['claude-code-cli', 'codex-cli', 'copilot-cli']);

type SessionSnap = {
  issueKey: string;
  state?: string;
  provider?: string;
  model?: string;
  handoverBrief?: { revision: number; freshness?: string; nextSteps?: string; progress?: string };
  runtimeEpochs?: Array<{ reason?: string; provider?: string; endedAt?: string }>;
  events?: Array<{ type?: string; summary?: string }>;
  responseText?: string;
  acpCurrentModeId?: string;
  acpAvailableModes?: Array<{ id: string; name?: string }>;
};

async function sessionByKey(win: Page, key: string): Promise<SessionSnap | undefined> {
  return win.evaluate(
    k => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === k) as SessionSnap | undefined),
    key
  );
}

async function waitForBriefIdle(win: Page, key: string): Promise<SessionSnap | undefined> {
  for (let i = 0; i < 30; i++) {
    const record = await sessionByKey(win, key);
    if (record?.handoverBrief && record.handoverBrief.freshness !== 'updating') return record;
    await win.waitForTimeout(500);
  }
  return sessionByKey(win, key);
}

async function preferImplementationMode(win: Page, key: string): Promise<void> {
  const record = await sessionByKey(win, key);
  const modes = record?.acpAvailableModes ?? [];
  if (modes.length === 0) return;
  const preferred = modes.find(mode => /^(code|agent|default)$/i.test(mode.id))
    ?? modes.find(mode => /code|agent|implement/i.test(`${mode.id} ${mode.name ?? ''}`));
  if (!preferred || preferred.id === record?.acpCurrentModeId) return;
  await win.evaluate(
    ({ issueKey, modeId }) => window.praxis.ai.setAcpMode(issueKey, modeId),
    { issueKey: key, modeId: preferred.id }
  ).catch(() => undefined);
}

async function waitForTerminal(win: Page, key: string, budgetMs: number): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs;
  let state: string | undefined;
  let askedForCodeMode = false;
  for (;;) {
    const record = await sessionByKey(win, key);
    state = record?.state;
    if (state === 'completed' || state === 'failed' || state === 'aborted') return state;
    if (Date.now() > deadline) return state;
    if (!askedForCodeMode && (record?.acpAvailableModes?.length ?? 0) > 0) {
      askedForCodeMode = true;
      await preferImplementationMode(win, key);
    }
    if (state === 'awaiting_approval') {
      await win.evaluate(k => window.praxis.ai.respondToPermission(k, 'allow_always'), key);
    }
    await win.waitForTimeout(2000);
  }
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

test('a real agent hands the session to another real agent that finishes the work', async () => {
  test.skip(
    !commandAvailable(SOURCE_COMMAND),
    `First agent CLI not on PATH: ${SOURCE_COMMAND} (PRAXIS_LIVE_AGENT_CMD).`
  );
  test.skip(
    !CLI_PROVIDERS.has(TARGET_PROVIDER),
    `PRAXIS_LIVE_HANDOVER_TO must be a CLI agent (claude-code-cli, codex-cli, copilot-cli); got ${TARGET_PROVIDER}.`
  );
  test.skip(
    !commandAvailable(TARGET_COMMAND),
    `Handover target CLI not on PATH: ${TARGET_COMMAND}. Set PRAXIS_LIVE_HANDOVER_TO / PRAXIS_LIVE_HANDOVER_CMD.`
  );

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-handover-'));
  fs.writeFileSync(path.join(repo, 'add.js'), ADD_SOURCE);
  fs.writeFileSync(path.join(repo, 'mul.js'), MUL_SOURCE);
  fs.writeFileSync(path.join(repo, 'add.test.js'), ADD_TEST);
  fs.writeFileSync(path.join(repo, 'mul.test.js'), MUL_TEST);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  expect(runRepoTests(repo).ok, 'seeded suite should start failing').toBe(false);
  expect(runRepoTests(repo, ['add.test.js']).ok, 'addition should start failing').toBe(false);
  expect(runRepoTests(repo, ['mul.test.js']).ok, 'multiplication should start failing').toBe(false);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(
    ({ sourceProvider, sourceCommand, targetProvider, targetCommand }) =>
      window.praxis.settings.set({
        ai: {
          providers: {
            [sourceProvider]: { cliPath: sourceCommand },
            [targetProvider]: { cliPath: targetCommand }
          }
        }
      }),
    {
      sourceProvider: SOURCE_PROVIDER,
      sourceCommand: SOURCE_COMMAND,
      targetProvider: TARGET_PROVIDER,
      targetCommand: TARGET_COMMAND
    }
  );

  const purpose = [
    'add.js subtracts instead of adding, and mul.js adds instead of multiplying.',
    'The suite `node --test` must pass. Do not modify add.test.js or mul.test.js.'
  ].join(' ');
  const firstTurn = [
    purpose,
    '',
    'This first turn: fix only add.js so `node --test add.test.js` passes, then stop.',
    'Leave mul.js for the next agent.'
  ].join('\n');

  const session = await win.evaluate(
    async ({ goal, purpose, cwd, provider, timeoutMs }) => window.praxis.ai.delegate({
      provider,
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: {
        goal: purpose,
        scope: 'Both add.js and mul.js. Tests are read-only.',
        definitionOfDone: '`node --test` passes.',
        maxSteps: 30,
        timeoutMs
      }
    }),
    { goal: firstTurn, purpose, cwd: repo, provider: SOURCE_PROVIDER, timeoutMs: TURN_MS }
  );
  const key = session.issueKey;

  const firstState = await waitForTerminal(win, key, TURN_MS);
  const afterFirst = runRepoTests(repo);
  const addPass = runRepoTests(repo, ['add.test.js']);
  const mulPass = runRepoTests(repo, ['mul.test.js']);
  const firstChanged = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();

  console.log('--- live handover: first agent --------------------------------');
  console.log(`state:    ${firstState}`);
  console.log(`provider: ${SOURCE_PROVIDER}`);
  console.log(`files:    ${firstChanged.trim().replace(/\n/g, ' | ') || '(none)'}`);
  console.log(`add:      ${addPass.ok ? 'PASS' : 'FAIL'}`);
  console.log(`mul:      ${mulPass.ok ? 'PASS (too much)' : 'still failing (expected)'}`);
  console.log('---------------------------------------------------------------');

  expect(firstState, 'first agent should finish its turn').toBe('completed');
  expect(addPass.ok, `addition still failing:\n${addPass.output.slice(0, 1500)}`).toBe(true);
  expect(firstChanged).toContain('add.js');
  expect(firstChanged).not.toContain('add.test.js');
  expect(firstChanged).not.toContain('mul.test.js');
  expect(
    mulPass.ok,
    'first agent fixed mul.js — handover has nothing left to prove. The first turn must leave multiplication broken.'
  ).toBe(false);

  const beforeHandover = await waitForBriefIdle(win, key);
  expect(beforeHandover?.provider).toBe(SOURCE_PROVIDER);

  const handed = await win.evaluate(
    async ({ issueKey, provider, revision }) => window.praxis.ai.handoverSession(issueKey, {
      provider,
      expectedBriefRevision: revision,
      briefEdits: {
        nextSteps: 'Addition is done. Edit mul.js so it multiplies, then run `node --test`. Do the file change in this turn — do not stop at a plan. Do not modify tests or add.js.'
      }
    }),
    {
      issueKey: key,
      provider: TARGET_PROVIDER,
      revision: beforeHandover?.handoverBrief?.revision ?? 0
    }
  );

  expect(handed.issueKey).toBe(key);
  expect(handed.provider).toBe(TARGET_PROVIDER);

  const secondState = await waitForTerminal(win, key, TURN_MS);
  const after = runRepoTests(repo);
  const record = await sessionByKey(win, key);
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();
  const handoverEvents = (record?.events ?? []).filter(event => event.type === 'provider_handover');
  const handoverEpochs = (record?.runtimeEpochs ?? []).filter(epoch => epoch.reason === 'provider_handover');

  console.log('--- live handover: second agent -------------------------------');
  console.log(`state:    ${secondState}`);
  console.log(`provider: ${record?.provider}`);
  console.log(`epochs:   ${(record?.runtimeEpochs ?? []).map(e => e.reason).join(' → ')}`);
  console.log(`files:    ${changed.trim().replace(/\n/g, ' | ') || '(none)'}`);
  console.log(`suite:    ${after.ok ? 'PASSING' : 'still failing'}`);
  console.log(`reply:    ${(record?.responseText ?? '').slice(0, 400)}`);
  if (!after.ok) console.log(after.output.slice(0, 2000));
  console.log('---------------------------------------------------------------');

  expect(secondState, 'receiving agent should finish its turn').toBe('completed');
  expect(record?.issueKey).toBe(key);
  expect(record?.provider).toBe(TARGET_PROVIDER);
  expect(handoverEvents.length, 'session should record a provider_handover event').toBeGreaterThan(0);
  expect(handoverEpochs.length, 'session should record a provider_handover epoch').toBeGreaterThan(0);
  expect(changed).toContain('mul.js');
  expect(changed).not.toContain('add.test.js');
  expect(changed).not.toContain('mul.test.js');
  expect(after.ok, `node --test still failing after handover:\n${after.output.slice(0, 2000)}`).toBe(true);
  expect(afterFirst.ok, 'the suite must still have been failing before handover').toBe(false);
});

test('one agent does a single part of a task then another agent completes it', async () => {
  test.skip(
    !commandAvailable(SOURCE_COMMAND),
    `First agent CLI not on PATH: ${SOURCE_COMMAND} (PRAXIS_LIVE_AGENT_CMD).`
  );
  test.skip(
    !CLI_PROVIDERS.has(TARGET_PROVIDER),
    `PRAXIS_LIVE_HANDOVER_TO must be a CLI agent (claude-code-cli, codex-cli, copilot-cli); got ${TARGET_PROVIDER}.`
  );
  test.skip(
    !commandAvailable(TARGET_COMMAND),
    `Handover target CLI not on PATH: ${TARGET_COMMAND}. Set PRAXIS_LIVE_HANDOVER_TO / PRAXIS_LIVE_HANDOVER_CMD.`
  );

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-live-handover-part-'));
  fs.writeFileSync(path.join(repo, 'clean.js'), CLEAN_SOURCE);
  fs.writeFileSync(path.join(repo, 'display.js'), DISPLAY_SOURCE);
  fs.writeFileSync(path.join(repo, 'clean.test.js'), CLEAN_TEST);
  fs.writeFileSync(path.join(repo, 'display.test.js'), DISPLAY_TEST);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

  expect(runRepoTests(repo).ok, 'seeded suite should start failing').toBe(false);
  expect(runRepoTests(repo, ['clean.test.js']).ok).toBe(false);
  expect(runRepoTests(repo, ['display.test.js']).ok).toBe(false);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(
    ({ sourceProvider, sourceCommand, targetProvider, targetCommand }) =>
      window.praxis.settings.set({
        ai: {
          providers: {
            [sourceProvider]: { cliPath: sourceCommand },
            [targetProvider]: { cliPath: targetCommand }
          }
        }
      }),
    {
      sourceProvider: SOURCE_PROVIDER,
      sourceCommand: SOURCE_COMMAND,
      targetProvider: TARGET_PROVIDER,
      targetCommand: TARGET_COMMAND
    }
  );

  const purpose = [
    'clean() must trim and collapse spaces. display(first, last) must return "Last, First"',
    'after running both names through clean(). `node --test` must pass.',
    'Do not modify clean.test.js or display.test.js.'
  ].join(' ');
  const firstTurn = [
    purpose,
    '',
    'This first turn: implement only clean.js so `node --test clean.test.js` passes, then stop.',
    'Leave display.js for the next agent.'
  ].join('\n');

  const session = await win.evaluate(
    async ({ goal, purpose, cwd, provider, timeoutMs }) => window.praxis.ai.delegate({
      provider,
      goal,
      workingDirectory: cwd,
      toolMode: 'full',
      task: {
        goal: purpose,
        scope: 'clean.js then display.js. Tests are read-only.',
        definitionOfDone: '`node --test` passes.',
        maxSteps: 30,
        timeoutMs
      }
    }),
    { goal: firstTurn, purpose, cwd: repo, provider: SOURCE_PROVIDER, timeoutMs: TURN_MS }
  );
  const key = session.issueKey;

  const firstState = await waitForTerminal(win, key, TURN_MS);
  const afterFirst = runRepoTests(repo);
  const cleanPass = runRepoTests(repo, ['clean.test.js']);
  const displayPass = runRepoTests(repo, ['display.test.js']);
  const firstChanged = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();

  console.log('--- live partial: first agent ---------------------------------');
  console.log(`state:    ${firstState}`);
  console.log(`provider: ${SOURCE_PROVIDER}`);
  console.log(`files:    ${firstChanged.trim().replace(/\n/g, ' | ') || '(none)'}`);
  console.log(`clean:    ${cleanPass.ok ? 'PASS' : 'FAIL'}`);
  console.log(`display:  ${displayPass.ok ? 'PASS (too much)' : 'still failing (expected)'}`);
  console.log('---------------------------------------------------------------');

  expect(firstState, 'first agent should finish its slice').toBe('completed');
  expect(cleanPass.ok, `clean() still failing:\n${cleanPass.output.slice(0, 1500)}`).toBe(true);
  expect(firstChanged).toContain('clean.js');
  expect(firstChanged).not.toContain('clean.test.js');
  expect(firstChanged).not.toContain('display.test.js');
  expect(
    displayPass.ok,
    'first agent finished display.js — the second agent has nothing left to complete.'
  ).toBe(false);

  const beforeHandover = await waitForBriefIdle(win, key);
  expect(beforeHandover?.provider).toBe(SOURCE_PROVIDER);

  const handed = await win.evaluate(
    async ({ issueKey, provider, revision }) => window.praxis.ai.handoverSession(issueKey, {
      provider,
      expectedBriefRevision: revision,
      briefEdits: {
        nextSteps: 'clean() is done. Edit display.js so it cleans both names and returns "Last, First". Run `node --test`. Do the file change in this turn — do not stop at a plan. Do not modify tests or clean.js.'
      }
    }),
    {
      issueKey: key,
      provider: TARGET_PROVIDER,
      revision: beforeHandover?.handoverBrief?.revision ?? 0
    }
  );

  expect(handed.issueKey).toBe(key);
  expect(handed.provider).toBe(TARGET_PROVIDER);

  const secondState = await waitForTerminal(win, key, TURN_MS);
  const after = runRepoTests(repo);
  const record = await sessionByKey(win, key);
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();
  const handoverEvents = (record?.events ?? []).filter(event => event.type === 'provider_handover');

  console.log('--- live partial: second agent --------------------------------');
  console.log(`state:    ${secondState}`);
  console.log(`provider: ${record?.provider}`);
  console.log(`epochs:   ${(record?.runtimeEpochs ?? []).map(e => e.reason).join(' → ')}`);
  console.log(`files:    ${changed.trim().replace(/\n/g, ' | ') || '(none)'}`);
  console.log(`suite:    ${after.ok ? 'PASSING' : 'still failing'}`);
  console.log(`reply:    ${(record?.responseText ?? '').slice(0, 400)}`);
  if (!after.ok) console.log(after.output.slice(0, 2000));
  console.log('---------------------------------------------------------------');

  expect(secondState, 'receiving agent should finish the remaining part').toBe('completed');
  expect(record?.issueKey).toBe(key);
  expect(record?.provider).toBe(TARGET_PROVIDER);
  expect(handoverEvents.length).toBeGreaterThan(0);
  expect(changed).toContain('display.js');
  expect(changed).not.toContain('clean.test.js');
  expect(changed).not.toContain('display.test.js');
  expect(after.ok, `node --test still failing after handover:\n${after.output.slice(0, 2000)}`).toBe(true);
  expect(afterFirst.ok, 'the suite must still have been failing before handover').toBe(false);
});
