import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchTestApp, type TestApp } from './launchTestApp';

/**
 * The Security Review marketplace workflow, run for real on a clone of this repository with a real
 * AI (Claude Code). Spends model calls and takes a long time; opt-in only:
 *
 *   PRAXIS_LIVE_AGENT=1 PRAXIS_SELF_REVIEW_OUT=/some/dir npx playwright test --project=live-agent securityReviewSelf
 *
 * Works on a fresh clone of HEAD, never this working tree: a folder-backed project rewrites plan
 * markdown on load and the approved plan is written into the clone's plans folder. Everything the
 * run produced — report, findings, plan overview, plan files, screenshots — lands in the out dir.
 */

const OUT = process.env.PRAXIS_SELF_REVIEW_OUT ?? path.resolve(__dirname, '../../../../output/security-review-self');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TEMPLATE = path.join(REPO_ROOT, 'addons/workflows/security-review/addon/template.json');

let app: TestApp | undefined;

test.afterEach(async () => {
  // Close without `closeTestApp`, which deletes the profile: this one is kept in the out dir.
  if (app) await app.electronApp.close();
  app = undefined;
});

test('Security Review on this repository with a real AI', async () => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'live agent runs are opt-in: set PRAXIS_LIVE_AGENT=1');
  test.setTimeout(4 * 60 * 60 * 1000);

  // PRAXIS_SELF_REVIEW_RESUME=<runId> reopens the kept profile and carries that run on — e.g. after
  // the AI's usage limit paused it — instead of starting (and paying for) a new one.
  const resume = process.env.PRAXIS_SELF_REVIEW_RESUME;
  const clone = path.join(OUT, 'praxis');
  if (!resume) {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, clone]);
  }
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(stamped);
    fs.appendFileSync(path.join(OUT, 'progress.log'), `${stamped}\n`);
  };
  if (!resume) log(`cloned ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: clone }).toString().trim()} into ${clone}`);

  // The profile lives in the out dir, so a failure part-way keeps the run to inspect or resume.
  const profileDir = path.join(OUT, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  app = await launchTestApp(
    { ai: { activeProvider: 'claude-code-cli', workingDirectory: clone, providers: { 'claude-code-cli': { cliPath: 'claude-agent-acp' } } } },
    { userDataDir: profileDir, settingsPath: path.join(profileDir, 'test-settings.json') },
    // Scanners installed outside the system PATH (e.g. a scratch venv) are passed in here.
    { PATH: `${process.env.PRAXIS_SCANNER_PATH ? `${process.env.PRAXIS_SCANNER_PATH}:` : ''}${process.env.PATH}` },
    { openNewSession: false }
  );
  const page = app.window;
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));

  const { runId } = resume ? { runId: resume } : await page.evaluate(
    async ({ repoPath, definition }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Praxis (self review)',
          key: 'PRAXIS',
          type: 'software',
          purpose: '',
          brief: {},
          startingPoint: 'existing-folder',
          folderPath: repoPath,
          storage: 'folder',
          workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
          starterTickets: [],
          defaultAiToolMode: 'read-only'
        },
        workspace.id
      );
      await window.praxis.agentRuntime.refresh();
      await window.praxis.workflows.save(project.id, { ...definition, id: `security-review-${project.id}`, scope: 'project', projectId: project.id } as never);
      const summary = await window.praxis.workflows.startRun(project.id, `security-review-${project.id}`, 'Security Review', undefined, undefined, undefined, {
        permissionMode: 'auto',
        aiProvider: 'claude-code-cli',
        uncommittedChanges: 'omit'
      });
      localStorage.setItem(
        `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
        JSON.stringify({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: summary.runId })
      );
      return { runId: summary.runId };
    },
    { repoPath: clone, definition: template }
  );
  log(resume ? `resuming run ${runId}` : `run ${runId} started`);
  if (resume) {
    const paused = await page.evaluate(id => window.praxis.workflows.getRun(id).then(run => (run?.stages ?? []).filter(stage => stage.pause).map(stage => stage.nodeId)), runId);
    for (const nodeId of paused) {
      log(`retrying paused stage ${nodeId}`);
      await page.evaluate(({ id, node }) => window.praxis.workflows.retryStage(id, node), { id: runId, node: nodeId });
    }
  }

  const snapshot = () => page.evaluate(id => window.praxis.workflows.getRun(id), runId);
  let last = '';
  const waitFor = async (done: (status: string | undefined) => boolean) => {
    for (;;) {
      const run = await snapshot();
      const line = `${run?.status} | ${(run?.stages ?? []).map(stage => `${stage.nodeId}:${stage.outcome}${stage.pause ? `(${stage.pause})` : ''}`).join(' ')}`;
      if (line !== last) {
        log(line);
        for (const stage of run?.stages ?? []) if (stage.lastError && stage.outcome !== 'succeeded') log(`  ${stage.nodeId}: ${stage.lastError.split('\n')[0]}`);
        last = line;
      }
      if (done(run?.status) || run?.stages.some(stage => stage.pause)) return run;
      await page.waitForTimeout(15000);
    }
  };

  const atDecision = await waitFor(status => status === 'awaiting-approval' || status === 'failed' || status === 'cancelled');
  const save = async (nodeId: string, file: string) => {
    const text = await page.evaluate(({ id, node }) => window.praxis.workflows.stageReport(id, node), { id: runId, node: nodeId });
    if (text) fs.writeFileSync(path.join(OUT, file), text);
    return text;
  };
  await save('recon', 'attack-surface.md');
  await save('review', 'security-report.md');
  const review = atDecision?.stages.find(stage => stage.nodeId === 'review');
  if (review?.findings) fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(review.findings, null, 2));
  expect(atDecision?.status, 'the review reaches the plan decision').toBe('awaiting-approval');

  const panel = page.getByTestId('wf-run-panel');
  // Screenshots are a record, never a reason to stop the run.
  const shoot = async (step: string, file: string) => {
    try {
      await page.reload();
      await panel.getByTestId(`wf-vpipe-step-${step}`).click({ timeout: 10000 });
    } catch {
      log(`(screenshot ${file}: stage panel not shown)`);
    }
    await page.screenshot({ path: path.join(OUT, file) }).catch(() => undefined);
  };
  await shoot('review', 'run-findings.png');

  log('approving the remediation plan');
  await page.evaluate(id => window.praxis.workflows.approveRun(id, 'security-review-self'), runId);
  const finished = await waitFor(status => status === 'succeeded' || status === 'failed' || status === 'cancelled');
  await save('remediation-plan', 'remediation-plan.md');
  fs.writeFileSync(path.join(OUT, 'run-summary.json'), JSON.stringify(finished, null, 2));

  const reference = finished?.stages.find(stage => stage.nodeId === 'remediation-plan')?.artifacts[0]?.reference;
  log(`finished: ${finished?.status}${reference ? ` — plan ${reference.key} with ${reference.itemKeys.length} items` : ''}`);
  const created = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: clone }).toString();
  fs.writeFileSync(path.join(OUT, 'plan-files.txt'), created);

  await shoot('remediation-plan', 'run-plan.png');
  expect(finished?.status).toBe('succeeded');
  expect(reference?.key).toBeTruthy();
});
