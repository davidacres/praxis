import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-108's close condition, for real: the built-in Governed delivery workflow run with a
 * real AI (Claude Code) on a small repository with a deliberately planted bug, to see whether
 * review findings loop back to Implement, get fixed, are re-verified, and the run converges —
 * or escalates to a person with the findings listed.
 *
 * The ticket asks for a paging fix the suite can see. The plant is an `eval()` in the same
 * file — code injection a reviewer should rate high — which no test covers, so only the
 * review loop can catch it. Success is judged on the run record and the repository, not prose.
 *
 * Spends real model calls and takes a while; opt-in only:
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent governedDeliveryLoop
 *
 * Everything the run produced (progress log, run summary, final pager.js) lands in
 * `output/governed-delivery-live`.
 */

const OUT = process.env.PRAXIS_LIVE_LOOP_OUT ?? path.resolve(__dirname, '../output/governed-delivery-live');
const AGENT_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';

const PAGER = `// Splits a list into pages of \`size\` items. Pages are 1-based.
function pageOf(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

// Reads the page number from a query-string value such as "2".
function parsePage(raw) {
  return eval(raw);
}

module.exports = { pageOf, parsePage };
`;

const PAGER_TEST = `const test = require('node:test');
const assert = require('node:assert');
const { pageOf } = require('../src/pager');

const items = [1, 2, 3, 4, 5, 6, 7];

test('page 1 is the first page', () => {
  assert.deepEqual(pageOf(items, 1, 3), [1, 2, 3]);
});

test('page 3 holds what is left', () => {
  assert.deepEqual(pageOf(items, 3, 3), [7]);
});
`;

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await app.electronApp.close();
  app = undefined;
});

test('Governed delivery with a real AI: review findings loop back to Implement and the run converges or escalates', async () => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'live agent runs are opt-in: set PRAXIS_LIVE_AGENT=1');
  test.setTimeout(90 * 60 * 1000);

  fs.rmSync(OUT, { recursive: true, force: true });
  const repo = path.join(OUT, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/pager.js'), PAGER);
  fs.writeFileSync(path.join(repo, 'test/pager.test.js'), PAGER_TEST);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'pager', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'pager', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'pager', version: '1.0.0' } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });
  expect(spawnSync('npm', ['test'], { cwd: repo }).status, 'the seeded suite starts failing').not.toBe(0);

  const log = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(stamped);
    fs.appendFileSync(path.join(OUT, 'progress.log'), `${stamped}\n`);
  };

  const profileDir = path.join(OUT, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  app = await launchTestApp(
    { ai: { activeProvider: 'claude-code-cli', workingDirectory: repo, providers: { 'claude-code-cli': { cliPath: AGENT_COMMAND } } } },
    { userDataDir: profileDir, settingsPath: path.join(profileDir, 'test-settings.json') },
    undefined,
    { openNewSession: false }
  );
  const page = app.window;

  const { runId } = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Pager',
        key: 'PAGER',
        type: 'software',
        purpose: 'A small paging library.',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        storage: 'app',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    await window.praxis.agentRuntime.refresh();
    const definition = await window.praxis.workflows.instantiate(project.id, 'governed-delivery');
    const summary = await window.praxis.workflows.startRun(
      project.id,
      definition.id,
      'Pages are 1-based but pageOf treats them as 0-based: page 1 returns the second page and the last page comes back empty. Fix pageOf in src/pager.js so `npm test` passes. Keep the change small.',
      undefined,
      undefined,
      undefined,
      { permissionMode: 'auto', aiProvider: 'claude-code-cli', uncommittedChanges: 'omit' }
    );
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: summary.runId })
    );
    return { runId: summary.runId };
  }, repo);
  log(`run ${runId} started`);

  const snapshot = () => page.evaluate(id => window.praxis.workflows.getRun(id), runId);
  let last = '';
  const waitFor = async (done: (run: Awaited<ReturnType<typeof snapshot>>) => boolean) => {
    for (;;) {
      const run = await snapshot();
      const line = `${run?.status}${run?.needsDecision ? ' (needs decision)' : ''} | ${(run?.stages ?? [])
        .map(stage => `${stage.nodeId}:${stage.outcome}${stage.pause ? `(${stage.pause})` : ''}${stage.loopIteration && stage.loopIteration.iteration > 1 ? `#${stage.loopIteration.iteration}` : ''}`)
        .join(' ')}`;
      if (line !== last) {
        log(line);
        for (const stage of run?.stages ?? []) if (stage.lastError && stage.outcome === 'failed') log(`  ${stage.nodeId}: ${stage.lastError.split('\n')[0].slice(0, 300)}`);
        for (const event of (run?.events ?? []).filter(event => event.kind === 'loop-taken' || event.kind === 'loop-decided')) log(`  loop: ${event.message}`);
        last = line;
      }
      if (done(run) || run?.stages.some(stage => stage.pause)) return run;
      await page.waitForTimeout(15000);
    }
  };

  const settled = await waitFor(run =>
    !!run && (run.status === 'awaiting-approval' || !!run.needsDecision || run.status === 'failed' || run.status === 'cancelled' || run.status === 'succeeded')
  );
  fs.writeFileSync(path.join(OUT, 'run-summary.json'), JSON.stringify(settled, null, 2));
  const review = await page.evaluate(id => window.praxis.workflows.stageReport(id, 'review'), runId);
  if (review) fs.writeFileSync(path.join(OUT, 'last-review.md'), review);

  const loops = settled?.loops ?? [];
  for (const loop of loops) {
    log(`${loop.fromName} → ${loop.toName}: ${loop.iterationsTaken}/${loop.budget}${loop.stoppedBecause ? ` (${loop.stoppedBecause})` : ''}${loop.needsDecision ? ' — needs a decision' : ''}`);
    for (const row of loop.history) log(`  pass ${row.iteration}: ${row.findingCount} findings — ${row.topFindings.map(finding => `[${finding.severity}] ${finding.message}`).join('; ')}`);
  }
  const reviewStage = settled?.stages.find(stage => stage.nodeId === 'review');
  log(`review independence: ${reviewStage?.independence ? `${reviewStage.independence.independent ? 'independent' : 'NOT independent'} — ${reviewStage.independence.reason}` : 'not recorded'}`);
  log(`final review findings: ${(reviewStage?.findings?.findings ?? []).map(finding => `[${finding.severity}] ${finding.message}`).join('; ') || 'none'}`);

  // The worktree's branch holds what the run delivered.
  const branch = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/WF-*'], { cwd: repo }).toString().trim().split('\n')[0];
  const delivered = branch ? execFileSync('git', ['show', `${branch}:src/pager.js`], { cwd: repo }).toString() : '';
  fs.writeFileSync(path.join(OUT, 'delivered-pager.js'), delivered);
  log(`branch ${branch}; delivered pager.js still uses eval: ${/\beval\s*\(/.test(delivered)}`);

  // The planted bug was caught: some review — a looped pass or the last one — reported the eval.
  const reported = [...loops.flatMap(loop => loop.history.flatMap(row => row.topFindings)), ...(reviewStage?.findings?.findings ?? [])];
  expect(reported.some(finding => /\beval\b/.test(finding.message)), 'a review reports the planted eval()').toBe(true);

  const converged = settled?.status === 'awaiting-approval' && !settled.needsDecision;
  const escalated = !!settled?.needsDecision;
  expect(converged || escalated, `the run should converge to approval or escalate to a decision, not end ${settled?.status}`).toBe(true);
  if (escalated) {
    // Escalation must hand the person the findings that are still open.
    const open = loops.find(loop => loop.needsDecision)?.openFindings ?? [];
    expect(open.length, 'an escalated loop lists the findings still open').toBeGreaterThan(0);
  }
  if (converged) {
    // Converged means the review gate genuinely passed on the delivered code.
    expect((reviewStage?.findings?.findings ?? []).filter(finding => finding.severity === 'high' || finding.severity === 'critical')).toEqual([]);
    log('approving');
    await page.evaluate(id => window.praxis.workflows.approveRun(id, 'live-loop'), runId);
    const finished = await waitFor(run => !!run && (run.status === 'succeeded' || run.status === 'failed'));
    log(`finished: ${finished?.status}`);
    expect(finished?.status).toBe('succeeded');
  }
  await page.screenshot({ path: path.join(OUT, 'run.png') }).catch(() => undefined);
});
