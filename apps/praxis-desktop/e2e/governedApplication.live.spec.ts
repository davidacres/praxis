import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchTestApp } from './launchTestApp';

// No source implementation is seeded. QA runs the built CLI, so skipping Build
// cannot produce a green run. Independent acceptance checks live in this harness.
const QA = `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
for (const [args, output] of [[['add', '2', '3'], '5'], [['subtract', '9', '4'], '5']]) {
  test(args.join(' '), () => {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), output);
  });
}
test('invalid input fails', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'add', 'bad', '3'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.trim());
});
`;

test('a real AI creates a calculator application through Governed delivery and passes QA', async ({}, testInfo) => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'set PRAXIS_LIVE_AGENT=1 to spend real model calls');
  test.setTimeout(45 * 60 * 1000);

  // Unique, retained output: never erase a previous run or use a product checkout.
  const root = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(root, { recursive: true });
  const output = fs.mkdtempSync(path.join(root, 'governed-application-'));
  const repo = path.join(output, 'repo');
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  const write = (name: string, value: string) => fs.writeFileSync(path.join(repo, name), value);
  write('package.json', JSON.stringify({ name: 'live-calculator', version: '1.0.0', private: true,
    scripts: { build: 'node build.cjs', test: 'node --test' } }, null, 2) + '\n');
  write('package-lock.json', JSON.stringify({ name: 'live-calculator', version: '1.0.0', lockfileVersion: 3,
    requires: true, packages: { '': { name: 'live-calculator', version: '1.0.0' } } }, null, 2) + '\n');
  write('build.cjs', "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.copyFileSync('src/cli.js', 'dist/cli.js'); console.log('Calculator built');\n");
  write('test/calculator.test.cjs', QA);
  write('.gitignore', 'node_modules/\ndist/\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Live Test');
  git('config', 'user.email', 'live-test@example.com');
  git('add', '.');
  git('commit', '-qm', 'Seed application scaffold and acceptance tests');
  const base = git('rev-parse', 'HEAD');
  expect(spawnSync('node', ['--test'], { cwd: repo }).status).not.toBe(0);

  const profile = path.join(output, 'profile');
  fs.mkdirSync(profile);
  const app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', workingDirectory: repo,
    providers: { 'claude-code-cli': { cliPath: process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp' } } } },
  { userDataDir: profile, settingsPath: path.join(profile, 'test-settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  let runId: string | undefined;
  try {
    runId = await page.evaluate(async repoPath => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create({
        name: 'Live calculator', key: 'CALC', type: 'software', purpose: 'A small command-line calculator.', brief: {},
        startingPoint: 'existing-folder', folderPath: repoPath, storage: 'app',
        workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspace.id);
      await window.praxis.agentRuntime.refresh();
      const definition = await window.praxis.workflows.instantiate(project.id, 'governed-delivery');
      const run = await window.praxis.workflows.startRun(project.id, definition.id,
        'Create a dependency-free calculator CLI in src/cli.js. Usage: node dist/cli.js add <a> <b> or subtract <a> <b>. ' +
        'Accept finite decimal and negative numbers; print only the numeric result followed by a newline. ' +
        'Unknown operations, missing/extra operands and non-finite or invalid numbers must print an error to stderr and exit 1. ' +
        'Document usage in README.md. Preserve package.json, build.cjs and test/calculator.test.cjs. ' +
        'Use npm run build then npm test. Add meaningful tests for edge cases. No eval, dependencies or network services.',
        undefined, undefined, undefined, { permissionMode: 'auto', aiProvider: 'claude-code-cli', uncommittedChanges: 'omit' });
      return run.runId;
    }, repo);
    console.log(`Live governed application: ${runId}; evidence: ${output}`);
    let previous = '';
    await expect.poll(async () => {
      const run = await page.evaluate(id => window.praxis.workflows.getRun(id), runId!);
      fs.writeFileSync(path.join(output, 'run-summary.json'), JSON.stringify(run, null, 2));
      const progress = `${run?.status} | ${run?.stages.map(stage => `${stage.nodeId}:${stage.outcome}#${stage.attempts}${stage.pause ? `(${stage.pause})` : ''}`).join(' ')}`;
      if (progress !== previous) {
        console.log(progress);
        fs.appendFileSync(path.join(output, 'progress.log'), `${new Date().toISOString()} ${progress}\n`);
        previous = progress;
      }
      return !!run && (['awaiting-approval', 'failed', 'cancelled', 'succeeded'].includes(run.status) || !!run.needsDecision || !!run.paused);
    }, { timeout: 40 * 60 * 1000, intervals: [5000] }).toBe(true);

    const run = await page.evaluate(id => window.praxis.workflows.getRun(id), runId);
    expect(run?.status, `Inspect ${output}/run-summary.json`).toBe('awaiting-approval');
    expect(run?.needsDecision).toBeUndefined();
    for (const id of ['plan', 'implement', 'review', 'test-contracts', 'install', 'build', 'qa', 'security']) {
      const stage = run?.stages.find(row => row.nodeId === id);
      expect(stage?.outcome, `${id}: ${stage?.lastError ?? ''}`).toBe('succeeded');
      expect(stage?.artifacts.length, `${id} must retain evidence`).toBeGreaterThan(0);
      if (['install', 'build', 'qa', 'security'].includes(id)) expect(stage?.exitCode, id).toBe(0);
    }
    const qa = run!.stages.find(row => row.nodeId === 'qa')!;
    expect(qa.artifacts.some(artifact => artifact.contractId === 'qa-results')).toBe(true);

    const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    const worktree = worktrees.find(folder => folder !== repo && fs.existsSync(path.join(folder, 'src/cli.js')));
    expect(worktree, 'the governed worktree contains the new application').toBeTruthy();
    expect(fs.readFileSync(path.join(worktree!, 'test/calculator.test.cjs'), 'utf8')).toBe(QA);
    for (const [args, expected] of [[['add', '-2.5', '4'], '1.5'], [['subtract', '0', '-3'], '3']] as const) {
      const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: worktree, encoding: 'utf8', timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    }
    for (const args of [['multiply', '2', '3'], ['add', '1'], ['add', 'Infinity', '2'], ['add', '1', '2', '3']]) {
      const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: worktree, encoding: 'utf8', timeout: 10000 });
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr.trim()).not.toBe('');
    }
    expect(git('rev-parse', 'HEAD'), 'delivery must still await human approval').toBe(base);
    expect(fs.existsSync(path.join(repo, 'src/cli.js'))).toBe(false);
  } finally {
    if (runId) {
      for (const stage of ['plan', 'implement', 'review', 'test-contracts', 'build', 'qa', 'qa-repair-agent', 'security']) {
        const report = await page.evaluate(({ id, stage }) => window.praxis.workflows.stageReport(id, stage), { id: runId, stage }).catch(String);
        if (report) fs.writeFileSync(path.join(output, `${stage}.md`), report);
      }
      const run = await page.evaluate(id => window.praxis.workflows.getRun(id), runId).catch(String);
      fs.writeFileSync(path.join(output, 'run-summary.json'), JSON.stringify(run, null, 2));
      await testInfo.attach('governed-application-run', { path: path.join(output, 'run-summary.json'), contentType: 'application/json' });
    }
    // Retain the isolated profile, repository and worktree for diagnosis. No approval or merge.
    await app.electronApp.close();
  }
});
