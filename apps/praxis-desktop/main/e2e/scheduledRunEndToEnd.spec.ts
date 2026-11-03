import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * FX-BF-047: a scheduled run, unattended, from its start time to its report.
 *
 * Five tickets in three steps — [A ‖ B] → C → [D ‖ E] — with up to two at once.
 * Every ticket runs a real workflow: an agent stage (a real agent session against
 * the in-process mock gateway), a check stage, then an approval gate the runner
 * must decide by itself. Nothing in the test touches the run after arming it: it
 * has to start at its time, keep the step order, overlap the parallel steps
 * within the cap, decide every gate, and finish `completed` with no pause.
 *
 * The board follows along: each ticket moves to In Progress when its workflow
 * starts and to Done when it finishes. It runs on both storages — app JSON and a
 * folder of markdown plans, where a status change is a commit in the repository
 * the next ticket must still find clean.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const roots: string[] = [];
const shots = path.resolve(__dirname, '../../.praxis/session-artifacts');

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const titles = ['Step one A', 'Step one B', 'Step two', 'Step three A', 'Step three B'];

/** One plan document per ticket, already in the shape Praxis writes, so loading it rewrites nothing. */
function writePlans(repo: string): void {
  titles.forEach((title, index) => {
    const dir = path.join(repo, 'docs', 'plans', 'features', `feature-0${index + 1}-${title.toLowerCase().replace(/\s+/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'feature.md'), [
      `# ${title}`, '', '**Status:** Backlog', '**Created:** 2026-11-01', '**Type:** Feature', '**Priority:** Medium', '',
      '## Description', '', `Scheduled work: ${title}.`, '', '## Comments', '',
      '## Items', '', '| Ref | Type | Name | Status |', '| --- | --- | --- | --- |', '', '', '## Dependencies', '', '', ''
    ].join('\n'));
  });
}

for (const storage of ['app', 'folder'] as const) test(`a mixed serial and parallel schedule starts at its time, runs to completion without anyone, and moves its ${storage} tickets across the board`, async () => {
  // Waiting for the next whole minute alone can take up to two.
  test.setTimeout(6 * 60_000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-schedule-e2e-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-schedule-e2e-repo-'));
  roots.push(profile, repo);
  const agentDir = path.join(profile, 'agents', 'scheduled-worker');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ schemaVersion: 1, id: 'scheduled-worker', name: 'Scheduled worker', type: 'gateway', entry: 'session' }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  if (storage === 'folder') writePlans(repo);
  git('add', '.');
  git('commit', '-qm', 'initial');

  mock = await startMockGatewayServer({ mode: 'complete', reply: 'Reviewed the ticket: the change is correct and complete.' });
  app = await launchTestApp({ ai: { activeProvider: 'vercel-gateway', workingDirectory: repo } }, { userDataDir: profile, settingsPath: path.join(profile, 'settings.json') }, {
    AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined,
    PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'vercel-gateway': 0.1 })
  }, { openNewSession: false });
  const page = app.window;

  const { projectId, runId, keys, startAt } = await page.evaluate(async ({ repo, titles, storage }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Unattended', key: 'UNA', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repo,
      ...(storage === 'folder' ? { storage: 'folder' as const } : {}),
      workflowStages: [{ id: 'backlog', name: 'Backlog', category: 'todo' }, { id: 'doing', name: 'In Progress', category: 'indeterminate' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: storage === 'folder' ? [] : titles.map(summary => ({ summary, description: '', issueType: 'Task', status: 'Backlog' })), defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.agentRuntime.refresh();
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: 'unattended', name: 'Review, check, approve', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'review', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [], agent: { agentId: 'scheduled-worker', scope: 'global', toolMode: 'read-only' }, instructions: 'Review the ticket and report your findings.', outputs: [{ id: 'review-report', kind: 'report', required: true }], mutatesWorktree: false },
        // Long enough that two tickets in one step are visibly in flight together.
        { type: 'check', id: 'check', name: 'Check', x: 240, y: 0, inputs: [], command: 'sleep', args: ['3'], successExitCodes: [0], outputs: [] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 480, y: 0, inputs: ['review-report'], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [
        { id: 'review-check', from: 'review', to: 'check', on: 'success', required: true },
        { id: 'check-approve', from: 'check', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    const connectionId = `project:${project.id}`;
    const issues = (await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 20, connectionId)).issues;
    const byTitle = titles.map(title => issues.find(issue => issue.summary === title)!);
    const tickets = byTitle.map(issue => ({ connectionId, issueKey: issue.key, title: issue.summary }));
    // [A ‖ B] → C → [D ‖ E]
    const withPrevious = [byTitle[1], byTitle[4]].map(issue => `${connectionId}\u0000${issue.key}`);
    // `HH:mm` has no seconds: arm for the first whole minute at least 15s away.
    const at = new Date(Math.ceil((Date.now() + 15_000) / 60_000) * 60_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const view = await window.praxis.scheduledRuns.save({
      projectId: project.id, name: 'Unattended night', timezone: 'UTC', tickets, withPrevious, maxConcurrency: 2, workflowId: 'unattended', arm: true,
      date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`, time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
    });
    return { projectId: project.id, runId: view.run.id, keys: byTitle.map(issue => issue.key), startAt: at.getTime() };
  }, { repo, titles, storage });

  const getRun = () => page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run, runId);
  const armed = await getRun();
  expect(armed.status).toBe('scheduled');
  expect(armed.policy).toMatchObject({ mode: 'parallel', maxConcurrency: 2, workflowId: 'unattended' });
  expect(armed.entries.map(entry => !!entry.withPrevious)).toEqual([false, true, false, false, true]);
  expect(await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(0);

  const board = () => page.evaluate(async id => Object.fromEntries((await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 20, `project:${id}`)).issues.map(issue => [issue.key, issue.status])), projectId);
  expect(Object.values(await board())).toEqual(['Backlog', 'Backlog', 'Backlog', 'Backlog', 'Backlog']);

  // Sample the run while it goes: the cap must hold at every observation, not just at the end,
  // and a ticket being worked must show as in progress on the board.
  const seenWhileRunning = new Map<string, Set<string>>();
  let peak = 0;
  const statuses = new Set<string>();
  let finished = false;
  const sampler = (async () => {
    while (!finished) {
      const run = await getRun().catch(() => undefined);
      if (run) {
        statuses.add(run.status);
        peak = Math.max(peak, run.entries.filter(entry => entry.outcome?.status === 'running' || entry.outcome?.status === 'paused').length);
        const running = run.entries.filter(entry => entry.outcome?.status === 'running' && run.events.some(event => event.kind === 'ticket-status' && event.entryId === entry.id));
        if (running.length) {
          const statuses = await board().catch(() => ({} as Record<string, string>));
          for (const entry of running) {
            const key = entry.ticket.issueKey;
            if (statuses[key]) seenWhileRunning.set(key, (seenWhileRunning.get(key) ?? new Set()).add(statuses[key]));
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  })();

  // It starts by itself at its time — not before, and not because anyone asked.
  await expect.poll(async () => (await getRun()).status, { timeout: 150_000, intervals: [500] }).not.toBe('scheduled');
  const started = await getRun();
  expect(started.attempts).toHaveLength(1);
  expect(started.attempts[0].trigger).toBe('schedule');
  expect(Date.parse(started.attempts[0].startedAt)).toBeGreaterThanOrEqual(startAt);

  try {
    await expect.poll(async () => {
      const run = await getRun();
      // Fail fast and say why if the run stops for a person.
      if (run.status === 'paused') {
        const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
        const diff = execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' });
        throw new Error(`Paused (${run.pause?.reason}): ${run.pause?.message}\n${changes}\n${diff}`);
      }
      return run.status;
    }, { timeout: 180_000, intervals: [500] }).toBe('completed');
  } catch (error) {
    // Say where it got stuck: each ticket, its workflow run's stages, and the tail of the ledger.
    const run = await getRun();
    const workflows = await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId);
    const stuck = JSON.stringify({
      entries: run.entries.map(entry => [entry.ticket.issueKey, entry.outcome?.status, entry.outcome?.reason]),
      workflows: workflows.map(workflow => [workflow.runId, workflow.status, workflow.explanation, workflow.stages.map(stage => [stage.nodeId, stage.lane, stage.lastError])]),
      events: run.events.slice(-12).map(event => event.message)
    }, null, 1);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stuck}`);
  } finally {
    finished = true;
    await sampler;
  }

  const run = await getRun();
  const [a, b, c, d, e] = run.entries.map(entry => ({ key: entry.ticket.issueKey, ...entry.outcome! }));
  expect(run.entries.map(entry => entry.ticket.issueKey)).toEqual(keys);
  expect(run.entries.map(entry => entry.outcome?.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(run.pause).toBeUndefined();
  expect(statuses.has('paused')).toBe(false);
  expect(run.events.filter(event => event.kind === 'paused')).toEqual([]);

  // Two lanes, never more.
  expect(peak).toBe(2);
  const t = (iso: string | undefined) => Date.parse(iso!);
  const overlap = (x: typeof a, y: typeof a) => t(x.startedAt) < t(y.endedAt) && t(y.startedAt) < t(x.endedAt);
  // A step's tickets overlapped; each step waited for every ticket of the one before.
  expect(overlap(a, b)).toBe(true);
  expect(overlap(d, e)).toBe(true);
  expect(t(c.startedAt)).toBeGreaterThanOrEqual(Math.max(t(a.endedAt), t(b.endedAt)));
  expect(Math.min(t(d.startedAt), t(e.startedAt))).toBeGreaterThanOrEqual(t(c.endedAt));
  expect([a.lane, b.lane].sort()).toEqual([1, 2]);
  expect([d.lane, e.lane].sort()).toEqual([1, 2]);
  expect(b.laneReason).toMatch(new RegExp(`runs alongside ${a.key}`));

  // One workflow run per ticket, each a real one that succeeded, with its agent session and report.
  const workflowRuns = await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId);
  expect(workflowRuns).toHaveLength(5);
  expect(new Set(run.entries.map(entry => entry.outcome?.workflowRunId)).size).toBe(5);
  for (const workflowRun of workflowRuns) {
    expect(workflowRun.status).toBe('succeeded');
    expect(workflowRun.stages.map(stage => [stage.nodeId, stage.lane])).toEqual([['review', 'done'], ['check', 'done'], ['approve', 'done']]);
  }
  expect(mock.requests.length).toBeGreaterThanOrEqual(5);
  for (const entry of run.entries) expect(entry.outcome?.artifacts?.length).toBeGreaterThan(0);

  // Every gate was decided by the runner and written to the ledger.
  const gates = run.events.filter(event => event.kind === 'gate-decided');
  expect(gates).toHaveLength(5);
  for (const key of keys) expect(gates.some(event => event.message.startsWith(`${key} gate "Approve": approved`))).toBe(true);
  expect(run.events.at(-1)?.kind).toBe('completed');
  expect(run.attempts[0].endedAt).toBeTruthy();

  // The board followed the run: in progress while worked, done at the end, each move in the ledger.
  // (Done can show a moment before the run marks the ticket finished: it moves first, then settles.)
  for (const key of keys) {
    expect([...(seenWhileRunning.get(key) ?? [])], key).toContain('In Progress');
    expect([...(seenWhileRunning.get(key) ?? [])], key).not.toContain('Backlog');
  }
  expect(await board()).toEqual(Object.fromEntries(keys.map(key => [key, 'Done'])));
  for (const entry of run.entries) {
    expect(run.events.filter(event => event.kind === 'ticket-status' && event.entryId === entry.id).map(event => event.message))
      .toEqual([`${entry.ticket.issueKey} moved to In Progress on the board.`, `${entry.ticket.issueKey} moved to Done on the board.`]);
  }
  if (storage === 'folder') {
    // Every move and outcome comment was committed: the plans end as clean as they started.
    // (Praxis's own metadata — `.praxis/`, `project.praxis.md` — may stay uncommitted; it never blocks a run.)
    expect(execFileSync('git', ['status', '--porcelain', '--', 'docs'], { cwd: repo, encoding: 'utf8' })).toBe('');
    for (const title of titles) {
      const dir = fs.readdirSync(path.join(repo, 'docs', 'plans', 'features')).find(name => name.endsWith(title.toLowerCase().replace(/\s+/g, '-')))!;
      expect(fs.readFileSync(path.join(repo, 'docs', 'plans', 'features', dir, 'feature.md'), 'utf8')).toContain('**Status:** ✅ Complete');
    }
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' });
    for (const key of keys) {
      expect(log).toContain(`Move ${key} to In Progress`);
      expect(log).toContain(`Move ${key} to Done`);
    }
  }

  // And the page a person opens in the morning is the finished report.
  await page.evaluate(id => {
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: id, feature: 'schedules' }));
  }, projectId);
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await page.getByTestId('schedule-card').filter({ hasText: 'Unattended night' }).getByTestId('schedule-open').click();
  await expect(page.getByTestId('schedule-report')).toBeVisible();
  await expect(page.getByTestId('schedule-report-status')).toHaveText('Completed');
  await expect(page.getByTestId('schedule-report-table').locator('tbody tr')).toHaveCount(5);
  await expect(page.getByTestId('schedule-report-needs')).toContainText('Waiting for you · 0 stops');
  await expect(page.getByTestId('schedule-report-needs')).toContainText('Nothing stopped for a person.');
  await expect(page.getByTestId('schedule-report-notes')).toContainText('Nothing unusual');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `scheduled-run-unattended-report-${storage}.png`) });
});
