import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-108's other two close conditions, for real, with Claude Code:
 *
 * 1. **Improve until target** on a real repository with a numeric goal ends at its
 *    best-scoring commit and records the score of every pass.
 * 2. A **map** stage fans a findings list out to parallel items, each in its own
 *    worktree, and merges their changes back into the run's branch.
 *
 * Spends real model calls; opt-in only:
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent improveAndMap
 */

const OUT = process.env.PRAXIS_LIVE_IMPROVE_OUT ?? path.resolve(__dirname, '../output/improve-and-map-live');
const AGENT_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await app.electronApp.close();
  app = undefined;
});

function seedRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'live', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'live', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'live', version: '1.0.0' } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: dir });
}

async function launch(out: string, repo: string): Promise<Page> {
  const profileDir = path.join(out, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  app = await launchTestApp(
    { ai: { activeProvider: 'claude-code-cli', workingDirectory: repo, providers: { 'claude-code-cli': { cliPath: AGENT_COMMAND } } } },
    { userDataDir: profileDir, settingsPath: path.join(profileDir, 'test-settings.json') },
    undefined,
    { openNewSession: false }
  );
  return app.window;
}

function logger(out: string) {
  return (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(stamped);
    fs.appendFileSync(path.join(out, 'progress.log'), `${stamped}\n`);
  };
}

async function waitForRun(page: Page, runId: string, log: (line: string) => void, done: (run: Awaited<ReturnType<typeof window.praxis.workflows.getRun>>) => boolean) {
  let last = '';
  const retries = new Map<string, number>();
  for (;;) {
    const run = await page.evaluate(id => window.praxis.workflows.getRun(id), runId);
    const line = `${run?.status}${run?.needsDecision ? ' (needs decision)' : ''} | ${(run?.stages ?? [])
      .map(stage => `${stage.nodeId}:${stage.outcome}${stage.pause ? `(${stage.pause})` : ''}${stage.loopIteration && stage.loopIteration.iteration > 1 ? `#${stage.loopIteration.iteration}` : ''}`)
      .join(' ')}`;
    if (line !== last) {
      log(line);
      for (const stage of run?.stages ?? []) if (stage.lastError && stage.outcome === 'failed') log(`  ${stage.nodeId}: ${stage.lastError.split('\n')[0].slice(0, 300)}`);
      last = line;
    }
    if (done(run) || run?.stages.some(stage => stage.pause)) return run;
    // A failed stage waits for a person; retry it as one would, at most twice, and say so.
    for (const stage of run?.stages ?? []) {
      if (run?.status !== 'running' || stage.outcome !== 'failed') continue;
      const used = retries.get(stage.nodeId) ?? 0;
      if (used >= 2) return run;
      retries.set(stage.nodeId, used + 1);
      log(`retrying ${stage.nodeId} (${used + 1}/2) after: ${(stage.lastError ?? '').split('\n')[0].slice(0, 200)}`);
      await page.evaluate(({ id, node }) => window.praxis.workflows.retryStage(id, node), { id: runId, node: stage.nodeId });
    }
    await page.waitForTimeout(15000);
  }
}

test('Improve until target with a real AI ends on its best-scoring commit and records every pass', async () => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'live agent runs are opt-in: set PRAXIS_LIVE_AGENT=1');
  test.setTimeout(90 * 60 * 1000);
  const out = path.join(OUT, 'improve');
  fs.rmSync(out, { recursive: true, force: true });
  const repo = path.join(out, 'repo');
  seedRepo(repo, {
    'src/strings.js': `function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
function countWords(s) { return s.split(' ').length; }
function reverse(s) { return s.split('').reverse().join(''); }
module.exports = { capitalize, truncate, countWords, reverse };
`,
    'test/strings.test.js': `const test = require('node:test');
const assert = require('node:assert');
const { capitalize, truncate, countWords, reverse } = require('../src/strings');
test('capitalize', () => assert.equal(capitalize('hello'), 'Hello'));
test('truncate', () => assert.equal(truncate('hello world', 5), 'hello...'));
test('countWords', () => assert.equal(countWords('a b c'), 3));
test('reverse', () => assert.equal(reverse('abc'), 'cba'));
`
  });
  const log = logger(out);
  const page = await launch(out, repo);

  const runId = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      { name: 'Strings', key: 'STR', type: 'software', purpose: 'A small string utility library.', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath, storage: 'app', workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }], starterTickets: [], defaultAiToolMode: 'read-only' },
      workspace.id
    );
    await window.praxis.agentRuntime.refresh();
    const definition = await window.praxis.workflows.instantiate(project.id, 'improve-until-target');
    const summary = await window.praxis.workflows.startRun(project.id, definition.id, 'Harden src/strings.js', undefined, undefined, undefined, {
      permissionMode: 'auto',
      aiProvider: 'claude-code-cli',
      uncommittedChanges: 'omit',
      parameters: {
        goal: 'Every function in src/strings.js handles empty strings, non-string input and edge cases (n <= 0, multiple spaces, surrogate pairs) without throwing unexpectedly, and each behaviour is pinned by a test.',
        rubric: 'Score 0-100: 25 points per function that handles all of its edge cases correctly and has tests for them. Deduct for any behaviour that throws on reasonable input.',
        target: 98,
        iterations: 2
      }
    });
    return summary.runId;
  }, repo);
  log(`run ${runId} started`);

  let run = await waitForRun(page, runId, log, current => !!current && (current.status === 'awaiting-approval' || !!current.needsDecision || ['failed', 'cancelled', 'succeeded'].includes(current.status)));
  if (run?.needsDecision) {
    log(`needs a decision: ${run.needsDecision.message}`);
    await page.evaluate(({ id, edge }) => window.praxis.workflows.decideLoop(id, edge, 'live-improve', 'accept', 'Live test: accept the best pass at the iteration ceiling'), { id: runId, edge: run.needsDecision.edgeId });
    run = await waitForRun(page, runId, log, current => !!current && (current.status === 'awaiting-approval' || ['failed', 'cancelled', 'succeeded'].includes(current.status)));
  }
  fs.writeFileSync(path.join(out, 'run-summary.json'), JSON.stringify(run, null, 2));

  const loop = run?.loops.find(candidate => candidate.edgeId === 'e-improve-again');
  log(`loop: ${loop?.iterationsTaken}/${loop?.budget}, stopped because ${loop?.stoppedBecause ?? '(still firing)'}; best ${loop?.keepBest?.bestScore} (pass ${loop?.keepBest?.bestIteration}); latest ${loop?.keepBest?.currentScore}`);
  for (const row of loop?.history ?? []) log(`  pass ${row.iteration}: score ${row.score}${row.restoredTo ? ` (undone → ${row.restoredTo.slice(0, 7)})` : ''}`);
  for (const event of (run?.events ?? []).filter(event => event.kind.startsWith('loop-'))) log(`  ${event.kind}: ${event.message}`);
  expect(run?.status, 'the run stops on its best version and waits for approval').toBe('awaiting-approval');
  expect(loop?.history.length ?? 0, 'at least one improve pass went round the loop').toBeGreaterThan(0);
  expect((loop?.history ?? []).every(row => typeof row.score === 'number'), 'every recorded pass has a score').toBe(true);

  // The run's code is its best-scoring pass: if the last pass scored below the best, the best was restored.
  const scores = [...(loop?.history ?? []).map(row => row.score as number), loop?.keepBest?.currentScore].filter((score): score is number => typeof score === 'number');
  const best = Math.max(...scores);
  const branch = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/WF-*'], { cwd: repo }).toString().trim().split('\n')[0];
  log(`branch ${branch}; scores ${scores.join(' → ')}; best ${best}`);
  if (loop?.keepBest?.currentScore !== undefined && loop.keepBest.currentScore < best) {
    const bestRow = loop.history.find(row => row.score === best);
    expect(run?.events.some(event => event.kind === 'loop-restored' && /Restored the code/.test(event.message)), 'the best pass was restored').toBe(true);
    if (bestRow) log(`best pass ${bestRow.iteration} restored`);
  }

  await page.evaluate(id => window.praxis.workflows.approveRun(id, 'live-improve'), runId);
  const finished = await waitForRun(page, runId, log, current => !!current && ['succeeded', 'failed'].includes(current.status));
  log(`finished: ${finished?.status} — ${finished?.explanation}`);
  expect(finished?.status).toBe('succeeded');

  // The delivered code still passes its own suite.
  const check = path.join(out, 'check');
  execFileSync('git', ['worktree', 'add', '-q', check, branch], { cwd: repo });
  const tests = spawnSync('npm', ['test'], { cwd: check, encoding: 'utf8' });
  log(`delivered suite: ${tests.status === 0 ? 'passing' : 'FAILING'}`);
  expect(tests.status, tests.stdout + tests.stderr).toBe(0);
});

test('a map stage with a real AI fixes each finding in its own worktree and merges them back', async () => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'live agent runs are opt-in: set PRAXIS_LIVE_AGENT=1');
  test.setTimeout(90 * 60 * 1000);
  const out = path.join(OUT, 'map');
  fs.rmSync(out, { recursive: true, force: true });
  const repo = path.join(out, 'repo');
  // Three independent defects in three files, so parallel fixes merge cleanly.
  seedRepo(repo, {
    'src/add.js': `function add(a, b) { return a - b; }\nmodule.exports = { add };\n`,
    'src/max.js': `function max(list) { return Math.min(...list); }\nmodule.exports = { max };\n`,
    'src/greet.js': `function greet(name) { return 'Goodbye ' + name; }\nmodule.exports = { greet };\n`,
    'test/all.test.js': `const test = require('node:test');
const assert = require('node:assert');
test('add', () => assert.equal(require('../src/add').add(2, 3), 5));
test('max', () => assert.equal(require('../src/max').max([1, 9, 4]), 9));
test('greet', () => assert.equal(require('../src/greet').greet('Ada'), 'Hello Ada'));
`
  });
  const log = logger(out);
  const page = await launch(out, repo);

  const runId = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      { name: 'Fan', key: 'FAN', type: 'software', purpose: 'Small maths and greeting helpers.', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath, storage: 'app', workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }], starterTickets: [], defaultAiToolMode: 'read-only' },
      workspace.id
    );
    await window.praxis.agentRuntime.refresh();
    const reviewer = { agentId: 'praxis-reviewer', profileId: 'praxis-reviewer', hostId: 'praxis-reviewer', scope: 'global' as const, toolMode: 'read-only' as const };
    const implementer = { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global' as const, toolMode: 'full' as const };
    const definition = {
      schemaVersion: 1, id: `fan-${project.id}`, name: 'Fix each finding', scope: 'project' as const, projectId: project.id, version: 1, entryNodeId: 'review',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        {
          type: 'agent-task' as const, id: 'review', name: 'Find the bugs', x: 0, y: 0, inputs: [], agent: reviewer,
          instructions: 'Read src/ and test/. Report each function whose behaviour contradicts the tests as one high finding, with the file and a concrete fix. Report nothing else.',
          outputs: [{ id: 'bugs', kind: 'findings' as const, required: true }], mutatesWorktree: false
        },
        {
          type: 'map' as const, id: 'fix', name: 'Fix each bug', x: 240, y: 0, inputs: ['bugs'], over: 'bugs', itemSource: 'findings' as const, agent: implementer,
          instructions: 'Fix the one bug you are given in its file only, run `node --test`, and commit. Do not touch other files.',
          mutatesWorktree: true, concurrency: 3, maxItems: 5, onItemFailure: 'collect' as const,
          outputs: [{ id: 'fixes', kind: 'diff' as const, required: true }]
        },
        { type: 'check' as const, id: 'test', name: 'Tests', x: 480, y: 0, inputs: ['fixes'], command: 'npm', args: ['test'], successExitCodes: [0], outputs: [{ id: 'results', kind: 'test-results' as const, required: true }], satisfiesGate: 'qa' as const },
        { type: 'approval' as const, id: 'approve', name: 'Approve', x: 720, y: 0, inputs: ['results'], prompt: 'Ship the fixes?', requiredGates: ['qa' as const], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'review', to: 'fix', on: 'success' as const, required: true },
        { id: 'e2', from: 'fix', to: 'test', on: 'success' as const, required: true },
        { id: 'e3', from: 'test', to: 'approve', on: 'success' as const, required: true }
      ]
    };
    await window.praxis.workflows.save(project.id, definition as never);
    const summary = await window.praxis.workflows.startRun(project.id, definition.id, 'Fix the failing helpers', undefined, undefined, undefined, {
      permissionMode: 'auto',
      aiProvider: 'claude-code-cli',
      uncommittedChanges: 'omit'
    });
    return summary.runId;
  }, repo);
  log(`run ${runId} started`);

  const run = await waitForRun(page, runId, log, current => !!current && (current.status === 'awaiting-approval' || ['failed', 'cancelled', 'succeeded'].includes(current.status)));
  fs.writeFileSync(path.join(out, 'run-summary.json'), JSON.stringify(run, null, 2));
  const fix = run?.stages.find(stage => stage.nodeId === 'fix');
  const raw = await page.evaluate(async id => {
    const projects = await window.praxis.projects.list();
    const runs = await window.praxis.workflows.listRuns(projects[0].id);
    return runs.find(candidate => candidate.runId === id)?.events.filter(event => event.nodeId === 'fix').map(event => event.message);
  }, runId);
  for (const message of raw ?? []) log(`  fix: ${message.slice(0, 300)}`);
  log(`map stage: ${fix?.outcome}; findings handed out: ${run?.stages.find(stage => stage.nodeId === 'review')?.findings?.findings.length}`);
  expect(fix?.outcome, fix?.lastError).toBe('succeeded');
  expect(run?.status).toBe('awaiting-approval');

  const branch = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/WF-*'], { cwd: repo }).toString().trim().split('\n')[0];
  const merges = execFileSync('git', ['log', '--format=%s', branch], { cwd: repo }).toString().split('\n').filter(line => line.startsWith('Merge map item:'));
  const itemBranches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/wfitem-*'], { cwd: repo }).toString().trim().split('\n').filter(Boolean);
  log(`item branches: ${itemBranches.join(', ')}; merged into ${branch}: ${merges.length}`);
  expect(itemBranches.length, 'each item ran on its own branch').toBeGreaterThanOrEqual(2);
  expect(merges.length, 'item changes were merged back into the run branch').toBeGreaterThanOrEqual(2);

  await page.evaluate(id => window.praxis.workflows.approveRun(id, 'live-map'), runId);
  const finished = await waitForRun(page, runId, log, current => !!current && ['succeeded', 'failed'].includes(current.status));
  log(`finished: ${finished?.status}`);
  expect(finished?.status).toBe('succeeded');
  const check = path.join(out, 'check');
  execFileSync('git', ['worktree', 'add', '-q', check, branch], { cwd: repo });
  const tests = spawnSync('npm', ['test'], { cwd: check, encoding: 'utf8' });
  log(`delivered suite: ${tests.status === 0 ? 'passing' : 'FAILING'}`);
  expect(tests.status, tests.stdout + tests.stderr).toBe(0);
});
