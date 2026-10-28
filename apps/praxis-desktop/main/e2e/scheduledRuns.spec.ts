import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, showProjectBoard, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';
import { chooseOption } from './chipSelect';

/**
 * FX-BF-047 / FX-BE-147, FX-BE-148, FX-BE-173: scheduled ticket runs. Covers the
 * composer (hopper, belt, order), saving, surviving a restart, editing, arming and
 * holding, the missed-start decision, normal feature availability — and the runner: starting at
 * the scheduled time, the provider-allowance pause, a failed launch, the live view's
 * decisions and the warning before quitting with a schedule pending.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
const tempDirs: string[] = [];
const shots = path.resolve(__dirname, '../../.praxis/session-artifacts');

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

interface Launched { page: Page; projectId: string; repo: string }

async function launch(options: { legacyPreview?: boolean; provider?: boolean; titles?: string[]; env?: Record<string, string> } = {}): Promise<Launched> {
  const { legacyPreview, provider = true, titles = ['Fix pager bug', 'Add export CSV', 'Log retention'], env } = options;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-schedule-repo-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');

  mock = provider ? await startMockOpenAiCompatibleServer({ reply: () => 'ok' }) : undefined;
  app = await launchTestApp({
    ...(legacyPreview === undefined ? {} : { preview: { enableScheduledRuns: legacyPreview } }),
    ...(mock
      ? {
          ai: {
            activeProvider: 'custom:mock',
            customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }],
            providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } }
          }
        }
      : {})
  }, undefined, env, { openNewSession: false });
  const page = app.window;
  const projectId = await page.evaluate(async ({ repoPath, titles }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Schedule Project', key: 'SCH', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: titles.map(summary => ({ summary, description: '', issueType: 'Task', status: 'Backlog' })),
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'schedules' }));
    return project.id;
  }, { repoPath: repo, titles });
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  return { page, projectId, repo };
}

const beltOrder = (page: Page) => page.getByTestId('schedule-belt-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue')));
/**
 * Quits while a schedule is armed. The app asks first (and vetoes a plain
 * `electronApp.close()`), so answer the warning the way a user would.
 */
async function quitWithArmedSchedule(): Promise<void> {
  const closed = app!.electronApp.waitForEvent('close');
  void app!.electronApp.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app!.window.getByRole('button', { name: 'Quit anyway' }).click();
  await closed;
}

const miniOrder =(card: ReturnType<Page['locator']>) => card.getByTestId('schedule-mini-belt').locator('li').evaluateAll(items => items.map(item => item.getAttribute('data-issue')));

test('builds a schedule on the belt, saves it, and it survives a restart in the same order', async () => {
  const { page } = await launch();

  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
  await expect(page.getByTestId('schedule-runtime-note')).toContainText('starts at its time while Praxis is open');
  await expect(page.getByTestId('schedule-empty')).toBeVisible();

  await page.getByTestId('schedule-new').click();
  const composer = page.getByTestId('schedule-composer');
  await expect(composer).toBeVisible();
  await expect(page.getByTestId('schedule-hopper-card')).toHaveCount(3);

  // Keyboard activation adds to the end of the belt; clicking the card does not.
  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Log retention' }).press('Enter');
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Fix pager bug' }).press('Enter');
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Add export CSV' }).press('Enter');
  expect(await beltOrder(page)).toHaveLength(3);
  await expect(page.getByTestId('schedule-count')).toHaveText('3 tickets');
  await expect(page.getByTestId('schedule-hopper-card').filter({ hasText: 'Log retention' })).toBeDisabled();

  // The order is ours to change, by button (the keyboard path), and says nothing about the board.
  const first = (await beltOrder(page))[0] as string;
  await page.getByRole('button', { name: `Move ${first} later` }).click();
  const reordered = await beltOrder(page);
  expect(reordered[1]).toBe(first);
  await page.getByRole('button', { name: `Remove ${reordered[2]} from the run` }).click();
  await expect(page.getByTestId('schedule-count')).toHaveText('2 tickets');
  const expected = (await beltOrder(page)) as string[];

  await page.getByTestId('schedule-name').fill('Nightly cleanup');
  await page.getByTestId('schedule-date').fill('2030-01-15');
  await page.getByTestId('schedule-time').fill('22:00');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  // Readiness follows the form after a short debounce: wait until it reflects two tickets, not the three before.
  await expect(page.getByTestId('schedule-readiness').locator('[data-code="no-acceptance-criteria"]')).toContainText('2 tickets');
  await page.screenshot({ path: path.join(shots, 'scheduled-run-composer.png') });
  await page.getByTestId('schedule-save-draft').click();

  const card = page.getByTestId('schedule-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('schedule-card-name')).toHaveText('Nightly cleanup');
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  expect(await miniOrder(card)).toEqual(expected);
  expect(keys.length).toBe(3);

  // Restart: same start, same tickets, same order.
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  const reopened = app.window.getByTestId('schedule-card');
  await expect(reopened).toHaveCount(1, { timeout: 20000 });
  await expect(reopened.getByTestId('schedule-card-name')).toHaveText('Nightly cleanup');
  expect(await miniOrder(reopened)).toEqual(expected);
  await expect(reopened.getByTestId('schedule-start')).toContainText('15 Jan');
  await expect(reopened.getByTestId('schedule-start')).toContainText('22:00');
  await app.window.screenshot({ path: path.join(shots, 'scheduled-run-lineup-draft.png') });
});

test('edit, schedule, hold and delete a schedule', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().press('Enter');
  await page.getByTestId('schedule-date').fill('2030-02-01');
  await page.getByTestId('schedule-time').fill('09:30');
  await page.getByTestId('schedule-name').fill('Morning batch');
  // Arming needs a ready run, and this one is: a ticket, a future start, a folder and a provider.
  await expect(page.getByTestId('schedule-save')).toBeEnabled();
  await page.getByTestId('schedule-save').click();

  const card = page.getByTestId('schedule-card');
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');
  await expect(page.getByTestId('schedule-group-upNext')).toBeVisible();

  // Edit adds a second ticket and keeps it scheduled.
  await card.getByTestId('schedule-edit').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await page.getByTestId('schedule-hopper-card').filter({ hasNotText: 'on belt' }).first().press('Enter');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await page.getByTestId('schedule-save').click();
  await expect(card.getByTestId('schedule-mini-belt').locator('li')).toHaveCount(2);
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');

  await card.getByTestId('schedule-hold').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  await card.getByTestId('schedule-arm').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');

  // Deleting asks first, in the app's own dialog, and leaves the tickets alone.
  await card.getByTestId('schedule-delete').click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(page.getByTestId('schedule-card')).toHaveCount(0);
  await expect(page.getByTestId('schedule-empty')).toBeVisible();
});

test('a start that passed while Praxis was closed is missed, and only a choice resolves it', async () => {
  const { page, projectId } = await launch();
  // Arm a far-future run through the real path, then rewind its start while the app is stopped.
  await page.evaluate(async id => {
    const issues = await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 10, `project:${id}`);
    const tickets = issues.issues.slice(0, 2).map(issue => ({ connectionId: `project:${id}`, issueKey: issue.key, title: issue.summary }));
    for (const name of ['Missed one', 'Missed two']) {
      await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-03-01', time: '10:00', timezone: 'UTC', tickets, arm: true });
    }
  }, projectId);

  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await quitWithArmedSchedule();
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const run of stored['praxis.scheduledRuns.v1']) run.scheduledStartAt = '2020-01-01T10:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(stored));

  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  const cards = app.window.getByTestId('schedule-card');
  await expect(cards).toHaveCount(2, { timeout: 20000 });
  await expect(cards.getByTestId('schedule-status')).toHaveText(['Missed', 'Missed']);
  await expect(app.window.getByTestId('schedule-group-attention')).toBeVisible();

  // Nothing started on its own: both are still waiting for the user's decision.
  const one = cards.filter({ hasText: 'Missed one' });
  const two = cards.filter({ hasText: 'Missed two' });
  await one.getByTestId('schedule-skip').click();
  await expect(one.getByTestId('schedule-status')).toHaveText('Skipped');
  await two.getByTestId('schedule-start-now').click();
  // Starting late hands the run to the runner straight away; it is no longer waiting on the user.
  await expect(two.getByTestId('schedule-status')).not.toHaveText('Missed');
  await expect(two.getByTestId('schedule-start')).not.toContainText('2020');
  // A run started late is due, not invalid: it must not be flagged as having a start in the past.
  await expect(two.locator('[data-code="start-in-past"]')).toHaveCount(0);
  await app.window.screenshot({ path: path.join(shots, 'scheduled-run-lineup-missed.png') });
});

test('a run with no usable provider cannot be scheduled, and says why', async () => {
  const { page } = await launch({ provider: false });
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().press('Enter');
  await expect(page.getByTestId('schedule-readiness')).toContainText('No AI provider is enabled');
  await expect(page.getByTestId('schedule-save')).toBeDisabled();
  // A draft can still be kept while that is fixed.
  await page.getByTestId('schedule-date').fill('2030-04-01');
  await page.getByTestId('schedule-save-draft').click();
  const card = page.getByTestId('schedule-card');
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  await expect(card.getByTestId('schedule-arm')).toBeDisabled();
});

test('scheduled runs stay available with a retired preview opt-out', async () => {
  const { page } = await launch({ legacyPreview: false });
  await expect(page.getByTestId('project-schedules-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('schedules-disabled')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
});

test('the board toolbar offers a shortcut to the scheduled runs of its project', async () => {
  const { page } = await launch();
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  await page.getByTestId('board-schedule-btn').click();
  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
});

test('selected board tickets are saved in a new schedule', async () => {
  const { page } = await launch();
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  const cards = page.getByTestId('issue-card');
  await expect(cards).toHaveCount(3);
  await cards.nth(0).click({ modifiers: ['Meta'] });
  await cards.nth(1).click({ modifiers: ['Meta'] });
  await expect(cards.nth(1)).toHaveClass(/selected-for-schedule/);
  await cards.nth(1).click({ button: 'right' });
  await page.screenshot({ path: path.join(shots, 'board-multiselect-schedule-menu.png') });
  await page.getByTestId('board-issue-menu-schedule').click();
  await expect(page.getByRole('heading', { name: 'Add 2 selected tickets' })).toBeVisible();
  await page.getByRole('button', { name: 'Create new schedule' }).click();
  const saved = page.getByTestId('schedule-card');
  await expect(saved).toHaveCount(1);
  await expect(saved.getByTestId('schedule-card-name')).toHaveText('Scheduled run');
  await expect(saved.getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
  await page.screenshot({ path: path.join(shots, 'board-multiselect-new-schedule.png') });
});

test('selected board tickets are appended directly to an existing schedule', async () => {
  const { page, projectId } = await launch();
  await page.evaluate(async id => {
    await window.praxis.scheduledRuns.save({
      projectId: id,
      name: 'Existing schedule',
      date: '2030-01-15',
      time: '22:00',
      timezone: 'UTC',
      tickets: [{ connectionId: `project:${id}`, issueKey: 'SCH-3', title: 'Log retention' }],
      arm: false
    });
  }, projectId);
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  const card = page.locator('[data-testid="issue-card"][data-issue-key="SCH-1"]');
  await card.click({ modifiers: ['Meta'] });
  await card.click({ button: 'right' });
  await page.getByTestId('board-issue-menu-schedule').click();
  await page.getByRole('button', { name: 'Add to “Existing schedule”' }).click();
  const saved = page.getByTestId('schedule-card');
  await expect(saved).toHaveCount(1);
  await expect(saved.getByTestId('schedule-card-name')).toHaveText('Existing schedule');
  await expect(saved.getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
});

test('a retired preview opt-out does not hide the board schedule shortcut', async () => {
  const { page } = await launch({ legacyPreview: false });
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  await expect(page.getByTestId('board-schedule-btn')).toBeVisible();
});

test('tickets can be dragged from the hopper onto the flow graph and reordered on it', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  const hopper = (text: string) => page.getByTestId('schedule-hopper-card').filter({ hasText: text });
  await hopper('Fix pager bug').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(0);
  // A drag released outside Run order must not fall through to click-to-add.
  await hopper('Fix pager bug').dragTo(page.getByTestId('schedule-name'));
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(0);


  // Dropping on the end slot adds a step; dropping on the arrow before a step inserts a new step there.
  await hopper('Fix pager bug').dragTo(page.getByTestId('schedule-belt-slot'));
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await hopper('Add export CSV').dragTo(page.getByTestId('schedule-belt-slot'));
  await hopper('Log retention').dragTo(page.locator('[data-flow-gap="0"]'));
  const order = await beltOrder(page) as string[];
  expect(order).toHaveLength(3);
  const titleOf = async (key: string) => page.getByTestId('schedule-belt-card').filter({ has: page.locator(`.schedule-belt-key:text-is("${key}")`) }).locator('.schedule-belt-title').textContent();
  expect(await titleOf(order[0])).toBe('Log retention');
  expect(await titleOf(order[1])).toBe('Fix pager bug');
  expect(await titleOf(order[2])).toBe('Add export CSV');
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(3);

  // Reorder on the graph: drag the last node onto the arrow before the first step.
  // Let the entry animation of the card just dropped finish, so its position is settled.
  await page.waitForTimeout(800);
  await page.getByTestId('schedule-belt-card').nth(2).dragTo(page.locator('[data-flow-gap="0"]'));
  expect(await titleOf((await beltOrder(page) as string[])[0])).toBe('Add export CSV');
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(3);
  // A dragged-in ticket cannot be added twice.
  await expect(hopper('Add export CSV')).toBeDisabled();
});

test('a ticket dropped onto another shares its step, drawn as parallel lanes, and the steps are saved', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  const hopper = (text: string) => page.getByTestId('schedule-hopper-card').filter({ hasText: text });
  const node = (text: string) => page.getByTestId('schedule-belt-card').filter({ hasText: text });
  const step = (index: number) => page.getByTestId('schedule-flow-step').nth(index);
  await hopper('Fix pager bug').press('Enter');
  await hopper('Add export CSV').press('Enter');
  await hopper('Log retention').press('Enter');
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(3);
  await page.waitForTimeout(800);

  // Drag Log retention onto Add export CSV: they now share step 2, with a split and a join bar.
  await node('Log retention').dragTo(node('Add export CSV'));
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(2);
  await expect(step(1)).toHaveClass(/is-together/);
  await expect(step(1).getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(step(1).locator('.schedule-flow-bar')).toHaveCount(2);
  await expect(step(1).locator('.schedule-flow-rails')).toHaveCount(4);
  await expect(step(1)).toContainText('Step 2 · together');
  await expect(node('Add export CSV').locator('.schedule-belt-seq')).toHaveText('2a');
  await expect(node('Log retention').locator('.schedule-belt-seq')).toHaveText('2b');
  await expect(page.getByTestId('schedule-summary')).toContainText('3 tickets in 2 steps');

  // The keyboard path does the same: Fix pager bug joins nothing (it is first), Log retention splits out again and back.
  const logKey = await node('Log retention').getAttribute('data-issue');
  await page.getByRole('button', { name: `Give ${logKey} its own step` }).click();
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(3);
  await page.getByRole('button', { name: `Put ${logKey} in the step before` }).click();
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-flow-graph.png') });

  // Mid-drag over a node: the step is ringed and a "Share step" preview floats below it, without moving anything.
  const from = await node('Fix pager bug').locator('.schedule-belt-title').boundingBox();
  const over = node('Log retention');
  const before = await over.boundingBox();
  await page.mouse.move(from!.x + 20, from!.y + 6);
  await page.mouse.down();
  await page.mouse.move(before!.x + 60, before!.y + 30, { steps: 12 });
  // Playwright's synthetic drag only reports hover on later moves, so settle with a few small ones.
  await page.mouse.move(before!.x + 66, before!.y + 36, { steps: 4 });
  await expect(page.locator('.schedule-flow-join-preview')).toContainText('Share step 2');
  expect(await over.boundingBox()).toEqual(before);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-flow-graph-drag.png') });
  await page.mouse.up();
  await expect(page.locator('.schedule-flow-join-preview')).toHaveCount(0);
  // Step 1 emptied, so the three tickets now make up the only step.
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(1);
  await expect(step(0).getByTestId('schedule-belt-card')).toHaveCount(3);
  await page.getByRole('button', { name: `Give ${await node('Fix pager bug').getAttribute('data-issue')} its own step` }).click();
  await page.getByRole('button', { name: `Move ${await node('Fix pager bug').getAttribute('data-issue')} earlier` }).click();
  await expect(step(0).getByTestId('schedule-belt-card')).toHaveText(/Fix pager bug/);
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(2);

  // Saved and reopened, the shared step is still there.
  await page.getByTestId('schedule-name').fill('Flow graph run');
  await page.getByTestId('schedule-save-draft').click();
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Flow graph run' });
  await expect(card).toBeVisible();
  const saved = await page.evaluate(async () => (await window.praxis.scheduledRuns.list()).find(view => view.run.name === 'Flow graph run')?.run.entries.map(entry => [entry.ticket.title, !!entry.withPrevious]));
  expect(saved).toEqual([['Fix pager bug', false], ['Add export CSV', false], ['Log retention', true]]);
  await card.getByTestId('schedule-edit').click();
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(2);
  await expect(step(1).getByTestId('schedule-belt-card')).toHaveCount(2);
});

test('dragging a group ticket from the scheduler sidebar adds its unfinished child tickets', async () => {
  const { page, projectId } = await launch();
  const groupKey = await page.evaluate(async id => {
    const connection = `project:${id}`;
    const group = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Feature', summary: 'Release group', description: '' }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Grouped work', description: '', parentKey: group.key }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Other grouped work', description: '', parentKey: group.key }, connection);
    return group.key;
  }, projectId);
  await page.reload();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await page.getByTestId('schedule-new').click();

  // Match the running app's 120% zoom; hit testing uses CSS coordinates.
  await page.evaluate(() => window.praxis.window.setZoomFactor(1.2));
  const groupTicket = page.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`);
  await expect(groupTicket).toBeVisible();
  // Drag the visible title onto the Run order header, outside the belt slot.
  const source = await groupTicket.locator('.issue-card-title').boundingBox();
  const target = await page.getByRole('region', { name: 'Run order', exact: true }).locator('.schedule-stage-head').boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + source!.width / 2 + 10, source!.y + source!.height / 2, { steps: 5 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 25 });
  await page.mouse.move(target!.x + target!.width / 2 + 1, target!.y + target!.height / 2);
  await expect(page.locator('.schedule-ticket-drag-preview')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Run order', exact: true })).toHaveAttribute('data-drag-over', 'true');
  await page.mouse.up();
  await expect(page.locator('.schedule-ticket-drag-preview')).toHaveCount(0);

  const belt = page.getByTestId('schedule-belt');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(belt).toContainText('Grouped work');
  await expect(belt).toContainText('Other grouped work');
  await expect(belt).not.toContainText('Release group');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-dragged-group.png') });
});

/**
 * Opt-in capture of the real screens in the dark theme, for comparing against the mockups in
 * `.praxis/session-artifacts/scheduled-runs-v2/`. Writes PNGs only; it asserts nothing.
 * Run with PRAXIS_SHOTS=1.
 */
test('capture the composer and lineup for visual review (opt-in)', async () => {
  test.skip(!process.env.PRAXIS_SHOTS, 'screenshots are opt-in: set PRAXIS_SHOTS=1');
  const out = path.join(shots, 'scheduled-runs-actual');
  fs.mkdirSync(out, { recursive: true });
  const titles = ['Fix pager bug on session list', 'Add export CSV to usage panel', 'Log retention setting', 'Workflow designer undo', 'Theme token audit', 'Settings search index'];
  const { page, projectId } = await launch({ titles });
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } } as never));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');

  await page.getByTestId('schedule-new').click();
  for (const title of titles.slice(0, 4)) await page.getByTestId('schedule-hopper-card').filter({ hasText: title }).press('Enter');
  await page.getByTestId('schedule-name').fill('Nightly API cleanup');
  await page.getByTestId('schedule-date').fill('2030-10-21');
  await page.getByTestId('schedule-time').fill('22:00');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await expect(page.getByTestId('schedule-readiness').locator('[data-code="no-acceptance-criteria"]')).toContainText('4 tickets');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'composer.png') });

  // A realistic lineup: write the runs while the app is stopped, then relaunch.
  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  const conn = `project:${projectId}`;
  const at = new Date().toISOString();
  const entry = (i: number, n: number, outcome?: Record<string, unknown>) => ({ id: `e-${n}-${i}`, sequence: i + 1, ticket: { connectionId: conn, issueKey: keys[i], title: titles[i] }, ...(outcome ? { outcome } : {}) });
  const run = (id: string, name: string, status: string, startMs: number, count: number, outcomes: Array<Record<string, unknown> | undefined> = []) => ({
    schemaVersion: 1, id, projectId, name, scheduledStartAt: new Date(Date.now() + startMs).toISOString(), timezone: 'Europe/London', policy: { mode: 'sequential' },
    entries: Array.from({ length: count }, (_, i) => entry(i, id.length, outcomes[i])), status, attempts: [], createdAt: at, updatedAt: at, events: []
  });
  const H = 3_600_000;
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  fs.writeFileSync(file, JSON.stringify({ 'praxis.scheduledRuns.v1': [
    run('a', 'Sprint 42 batch', 'running', -72 * 60_000, 5, [{ status: 'done' }, { status: 'done' }, { status: 'running' }, undefined, undefined].map(o => o as Record<string, unknown> | undefined)),
    run('b', 'Nightly API cleanup', 'scheduled', 11.8 * H, 3),
    run('c', 'Export spike', 'paused', -2 * H, 1, [{ status: 'paused', reason: 'Waiting at the Review gate' }]),
    run('d', 'Docs sweep', 'missed', -30 * H, 2),
    run('e', 'Release notes', 'draft', 40 * H, 4),
    run('f', 'Hotfix batch', 'completed', -50 * H, 4, [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }])
  ] }));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  await expect(app.window.getByTestId('schedule-card')).toHaveCount(6, { timeout: 20000 });
  await app.window.waitForTimeout(800);
  await app.window.screenshot({ path: path.join(out, 'lineup.png') });
});

test('scheduled runs have a grouped sidebar and project tickets stay outside the main pane', async () => {
  const { page, projectId } = await launch();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await expect(page.locator('.pane-main').getByTestId('schedule-hopper')).toHaveCount(0);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-hopper-card')).toHaveCount(3);
  await page.evaluate(async id => {
    for (const name of ['First schedule', 'Second schedule']) await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-01-15', time: '22:00', timezone: 'UTC', tickets: [], arm: false });
  }, projectId);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.locator('.pane-aux').getByTestId('schedule-nav-run')).toHaveCount(0);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-new')).toHaveCount(1);
  await expect(page.getByTestId('schedule-bucket-today').getByTestId('schedule-nav-run')).toHaveCount(2);
  const runList = await page.locator('.schedule-sidebar-runs').boundingBox();
  const ticketList = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(runList!.y + runList!.height).toBeLessThanOrEqual(ticketList!.y);
  const divider = page.getByRole('separator', { name: 'Resize project tickets section' });
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  const handle = await divider.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  const expandedTickets = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(expandedTickets!.height).toBeCloseTo(ticketList!.height + 80, 0);
  await divider.focus();
  await divider.press('ArrowDown');
  const resizedTickets = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(resizedTickets!.height).toBeCloseTo(expandedTickets!.height - 10, 0);
  await page.reload();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(2);
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(resizedTickets!.height, 0);
  await page.getByTestId('schedule-nav-run').filter({ hasText: 'First schedule' }).click();
  await expect(page.getByTestId('schedule-card')).toHaveCount(1);
  await expect(page.getByTestId('schedule-card-name')).toHaveText('First schedule');
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Fix pager bug' }).press('Enter');
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  // The secondary pane must not hide the left run list or reset the draft.
  await page.getByTestId('titlebar-aux-toggle').click();
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.getByTestId('schedule-hopper')).toBeVisible();
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await page.getByTestId('titlebar-aux-toggle').click();
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await expect(page.locator('.pane-main').getByTestId('schedule-hopper')).toHaveCount(0);
  const ticketHeight = (await page.locator('.schedule-sidebar-tickets').boundingBox())!.height;
  await page.getByRole('button', { name: 'Collapse project tickets section', exact: true }).click();
  await expect(page.getByTestId('schedule-hopper')).toBeHidden();
  await expect(divider).toHaveCount(0);
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await page.screenshot({ path: path.join(shots, 'scheduled-run-tickets-collapsed.png') });
  await page.getByRole('button', { name: 'Expand project tickets section', exact: true }).click();
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(ticketHeight, 0);
  await page.getByRole('button', { name: 'Use full sidebar', exact: true }).click();
  await expect(page.locator('.schedule-sidebar-runs')).toBeHidden();
  await expect(page.getByTestId('schedule-hopper')).toBeVisible();
  await expect(divider).toHaveCount(0);
  const maximized = await page.locator('.schedule-sidebar-tickets').boundingBox();
  const sidebarBounds = await page.getByTestId('schedule-sidebar').boundingBox();
  expect(maximized!.height).toBeGreaterThan(sidebarBounds!.height - 3);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-tickets-maximized.png') });
  await page.getByRole('button', { name: 'Restore sidebar', exact: true }).click();
  await expect(page.locator('.schedule-sidebar-runs')).toBeVisible();
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(ticketHeight, 0);
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Filter tickets' }).fill('export');
  await expect(page.getByTestId('schedule-hopper-card')).toHaveCount(1);
  await page.getByTestId('schedule-hopper-card').press('Enter');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await page.getByTestId('schedule-save-draft').click();
  await expect(page.getByTestId('schedule-card').getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
  // Apply persisted theme preferences on reload, as the app does at startup.
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } } as never));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.getByTestId('schedule-new').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(0);
  await page.getByTestId('schedule-hopper-card').first().press('Enter');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await page.waitForTimeout(800); // Let the ticket entry animation settle for visual review.
  await page.screenshot({ path: path.join(shots, 'scheduled-run-sidebar-composer.png') });
  await page.getByTestId('schedule-save-draft').click();
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-light', themeMode: 'light' } } as never));
  await page.reload();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().press('Enter');
  await page.setViewportSize({ width: 1100, height: 650 });
  const tickets = page.getByTestId('schedule-sidebar').getByTestId('schedule-hopper');
  await expect(tickets).toBeVisible();
  const bounds = await tickets.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
  await page.getByRole('textbox', { name: 'Filter tickets' }).fill('retention');
  await page.getByTestId('schedule-hopper-card').press('Enter');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  const belt = await page.getByTestId('schedule-belt').boundingBox();
  const card = await page.getByTestId('schedule-belt-card').first().boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(belt!.x + belt!.width);
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-sidebar-light-short.png') });
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(page.getByTestId('schedule-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('project-schedules-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('titlebar-what-changed')).toHaveCount(0);
  await expect(page.getByTestId('titlebar-scheduled-runs')).toHaveCount(1);
  await page.getByTestId('titlebar-scheduled-runs').click();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(3);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.evaluate(() => window.praxis.settings.set({ preview: { enableEasyMode: true } }));
  await expect(page.getByTestId('easymode-sidebar')).toBeVisible();
  await page.getByTestId('titlebar-aux-toggle').click();
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(page.locator('.pane-sidebar')).toHaveCount(0);
  // The titlebar shortcut restores access even when both sidebars were hidden.
  await page.getByTestId('titlebar-scheduled-runs').click();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(3);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(3);
  await expect(page.locator('.pane-aux').getByTestId('schedule-nav-run')).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.screenshot({ path: path.join(shots, 'scheduled-run-titlebar-navigation.png') });
});

test('sidebar uses classic recency groups and expands group tickets', async () => {
  const { page, projectId } = await launch();
  const groupKey = await page.evaluate(async id => {
    const connection = `project:${id}`;
    const group = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Feature', summary: 'Release group', description: '' }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Grouped work', description: '', parentKey: group.key }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Other grouped work', description: '', parentKey: group.key }, connection);
    const done = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Completed standalone work', description: '' }, connection);
    const doneChild = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Completed grouped work', description: '', parentKey: group.key }, connection);
    const doneGroup = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Feature', summary: 'Completed group', description: '' }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Unfinished child of completed group', description: '', parentKey: doneGroup.key }, connection);
    for (const ticket of [done, doneChild, doneGroup]) await window.praxis.issue.transition(ticket.key, 'done', connection);
    for (const name of ['Today run', 'Recent run', 'Old run']) await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-01-15', time: '22:00', timezone: 'UTC', tickets: [], arm: false });
    return group.key;
  }, projectId);
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const run of stored['praxis.scheduledRuns.v1']) {
    if (run.name === 'Recent run') run.updatedAt = new Date(today.getTime() - 2 * 86400000).toISOString();
    if (run.name === 'Old run') run.updatedAt = new Date(today.getTime() - 10 * 86400000).toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(stored));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const reopened = app.window;
  if (!(await reopened.getByTestId('schedule-sidebar').isVisible())) await reopened.getByTestId('titlebar-scheduled-runs').click();
  await expect(reopened.getByTestId('schedule-bucket-today')).toContainText('Today run');
  await expect(reopened.getByTestId('schedule-bucket-this-week')).toContainText('Recent run');
  await expect(reopened.getByTestId('schedule-bucket-last-week')).toContainText('Old run');
  await reopened.getByTestId('schedule-bucket-this-week').getByRole('button', { name: 'This week' }).click();
  await expect(reopened.getByTestId('schedule-bucket-this-week').getByTestId('schedule-nav-run')).toHaveCount(0);
  // Hide completed parents and children, while retaining their unfinished work.
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: /^Completed/ })).toHaveCount(0);
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: 'Unfinished child of completed group' })).toBeVisible();
  await expect(reopened.getByRole('button', { name: 'Project tickets 7', exact: true })).toBeVisible();
  await reopened.getByTestId('schedule-new').click();
  await reopened.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`).press('Enter');
  await expect(reopened.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(reopened.getByTestId('schedule-belt')).toContainText('Grouped work');
  await expect(reopened.getByTestId('schedule-belt')).toContainText('Other grouped work');
  await expect(reopened.getByTestId('schedule-ready')).toBeVisible();
  await reopened.waitForTimeout(800);
  const parent = reopened.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`);
  await expect(parent).toHaveClass(/issue-card-parent/);
  const stack = reopened.getByTestId('schedule-ticket-stack');
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await stack.focus();
  await stack.press('Enter');
  await expect(stack).toHaveAttribute('aria-expanded', 'true');
  await expect(stack).toBeFocused();
  await expect(stack).toHaveCSS('outline-style', 'none');
  await expect(stack.locator('.board-child-stack-label')).toHaveCSS('text-decoration-line', 'underline');
  const children = reopened.locator(`[data-testid="schedule-hopper-card"][data-child-of="${groupKey}"]`);
  await expect(children).toHaveCount(2);
  await expect(children.first()).toHaveClass(/issue-card-child/);
  await expect(children.last()).toHaveClass(/issue-card-child-last/);
  // The type badge shares the title row; short compact cards no longer need a metadata row.
  for (const card of [parent, children.first()]) {
    const title = await card.locator('.issue-card-title').boundingBox();
    const badge = await card.locator('.issue-card-context').boundingBox();
    const bounds = await card.boundingBox();
    expect(badge!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
    expect(Math.abs(badge!.y - title!.y)).toBeLessThan(2);
    expect(bounds!.height).toBeLessThan(70);
  }
  await children.last().scrollIntoViewIfNeeded();
  await reopened.waitForTimeout(400);
  await reopened.screenshot({ path: path.join(shots, 'scheduled-run-left-restored-groups.png') });
  await reopened.getByTestId('schedule-hopper').screenshot({ path: path.join(shots, 'scheduled-run-sidebar-clean-seam.png') });
  // Searching for a child retains and reveals its parent context.
  await reopened.getByRole('textbox', { name: 'Filter tickets' }).fill('Other grouped');
  await expect(parent).toBeVisible();
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: 'Other grouped work' })).toBeVisible();
  await stack.click();
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: 'Other grouped work' })).toHaveCount(0);
});


// ── The runner (FX-BE-148) and the live view / report (FX-BE-173) ─────────────────────

/** Schedules the first `count` tickets to start `seconds` from now, through the real save path. */
async function scheduleSoon(page: Page, projectId: string, name: string, count = 2, seconds = 4, workflowId?: string): Promise<string> {
  return page.evaluate(async ({ id, name, count, seconds, workflowId }) => {
    const issues = await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 10, `project:${id}`);
    const tickets = issues.issues.slice(0, count).map(issue => ({ connectionId: `project:${id}`, issueKey: issue.key, title: issue.summary }));
    // `HH:mm` has no seconds: choose the next minute after the requested delay,
    // leaving enough time for IPC/save and avoiding a start that is already past.
    const at = new Date(Math.ceil((Date.now() + (seconds + 60) * 1000) / 60000) * 60000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const view = await window.praxis.scheduledRuns.save({
      projectId: id, name, timezone: 'UTC', tickets, arm: true, ...(workflowId ? { workflowId } : {}),
      date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
      time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`.slice(0, 5)
    });
    return view.run.id;
  }, { id: projectId, name, count, seconds, workflowId });
}

/**
 * A one-stage project workflow — a single approval, so no agent and no skills — for
 * runner tests whose subject is the launch itself. The default governed workflow
 * needs bundled skills a fresh profile has not installed, which would block every
 * launch before the check under test is reached.
 */
async function saveApprovalWorkflow(page: Page, projectId: string): Promise<string> {
  return page.evaluate(async id => {
    const now = new Date().toISOString();
    const workflowId = 'schedule-approval-only';
    await window.praxis.workflows.save(id, {
      schemaVersion: 1, id: workflowId, name: 'Approval only', scope: 'project', projectId: id, version: 1,
      entryNodeId: 'approve', createdAt: now, updatedAt: now, edges: [],
      nodes: [{ type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [], prompt: 'Approve?', requiredGates: [], allowBypass: false }]
    } as never);
    return workflowId;
  }, projectId);
}

/**
 * `HH:mm` has no seconds, so a schedule made this way starts on the next whole minute;
 * make it due now instead. Call it while the app is closed, so nothing rewrites the file.
 */
async function makeDueNow(runId: string): Promise<void> {
  const file = path.join(app!.userDataDir, 'scheduled-runs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const run of stored['praxis.scheduledRuns.v1']) if (run.id === runId) run.scheduledStartAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stored));
}

async function openScheduleSidebar(page: Page): Promise<void> {
  if (!(await page.getByTestId('schedule-sidebar').isVisible())) await page.getByTestId('titlebar-scheduled-runs').click();
}

test('a due schedule starts by itself, and a provider at its allowance pauses it before anything launches', async () => {
  const { page, projectId } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.97 }) } });
  const runId = await scheduleSoon(page, projectId, 'Overnight', 2);
  // The save path rounds to the minute; rewind the stored start so it is due on the next tick.
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await quitWithArmedSchedule();
  await makeDueNow(runId);
  app = await launchTestApp(undefined, reuse, { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.97 }) }, { openNewSession: false });
  const window = app.window;
  await openScheduleSidebar(window);
  // It was due while Praxis was closed, so it is missed first — the user decides.
  const card = window.getByTestId('schedule-card').filter({ hasText: 'Overnight' });
  await expect(card.getByTestId('schedule-status')).toHaveText('Missed', { timeout: 20000 });
  await card.getByTestId('schedule-start-now').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused', { timeout: 20000 });

  // Nothing was launched on a provider that had used 97% of its allowance.
  expect(await window.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(0);

  await card.getByTestId('schedule-open').click();
  await expect(window.getByTestId('schedule-monitor')).toBeVisible();
  const banner = window.getByTestId('schedule-pause-banner');
  await expect(banner).toHaveAttribute('data-reason', 'budget');
  await expect(banner).toContainText('95%');
  // A budget stop needs a person, so the processor stops and shows the warning tone (see ScheduleRunMonitor).
  await expect(window.getByTestId('schedule-processor')).toHaveAttribute('data-state', 'waiting');
  await expect(window.getByTestId('schedule-budget')).toContainText('97% used');
  await expect(window.getByTestId('schedule-belt').locator('li')).toHaveCount(2);

  await window.screenshot({ path: path.join(shots, 'scheduled-run-monitor-budget-pause.png') });

  // Stopping ends the run with its tickets skipped, and the page turns into the run's report.
  await window.getByTestId('schedule-stop').click();
  await window.getByRole('dialog').getByRole('button', { name: 'Stop run' }).click();
  await expect(window.getByTestId('schedule-report-status')).toHaveText('Skipped');
  await expect(window.getByTestId('schedule-report-table').locator('tbody tr')).toHaveCount(2);
});

test('Run now starts drafts and future schedules immediately, records one attempt and opens the live view', async () => {
  const { page, projectId } = await launch({ env: { PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.1 }) } });
  const workflowId = await saveApprovalWorkflow(page, projectId);
  for (const draft of [true, false]) {
    const name = draft ? 'Start this draft' : 'Start this future schedule';
    const id = await scheduleSoon(page, projectId, name, 1, 86400, workflowId);
    if (draft) await page.evaluate(id => window.praxis.scheduledRuns.setArmed(id, false), id);
    const card = page.getByTestId('schedule-card').filter({ hasText: name });
    await expect(card.getByTestId('schedule-status')).toHaveText(draft ? 'Draft' : 'Scheduled');
    await card.getByTestId('schedule-run-now').click();
    await expect(page.getByTestId('schedule-monitor')).toBeVisible();
    await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).length).toBe(draft ? 1 : 2);
    const run = await page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run, id);
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0].trigger).toBe('start-now');
    await expect(page.getByTestId('schedule-run-now')).toHaveCount(0);
    if (draft) {
      await page.getByTestId('schedule-monitor-back').click();
    } else {
      await page.screenshot({ path: path.join(shots, 'scheduled-run-now-live.png') });
    }
  }
});

test('the hand-over point is a setting: raised past a provider\'s usage, Run now launches instead of pausing', async () => {
  const { page, projectId } = await launch({ env: { PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.97 }) } });
  await page.evaluate(() => window.praxis.settings.set({ ai: { providerHandoverPercent: 99 } }));
  const workflowId = await saveApprovalWorkflow(page, projectId);
  await page.getByTestId('schedule-new').click();
  await expect(page.locator('.schedule-policy').filter({ hasText: 'Provider allowance' })).toContainText('At 99%');
  await page.getByTestId('schedule-cancel').click();
  const id = await scheduleSoon(page, projectId, 'Under a raised limit', 1, 86400, workflowId);
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Under a raised limit' });
  await card.getByTestId('schedule-run-now').click();
  await expect(page.getByTestId('schedule-monitor')).toBeVisible();
  // 97% used is under the user's 99% point, so the ticket launches rather than pausing for budget.
  await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).length).toBe(1);
  expect((await page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run, id)).pause?.reason).not.toBe('budget');
  await expect(page.getByTestId('schedule-monitor')).toContainText('work moves to another provider at 99%');
});

test('the editor can Run now without a scheduled start time and still obeys the provider budget gate', async () => {
  const { page } = await launch({ env: { PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.97 }) } });
  await page.getByTestId('schedule-new').click();
  await expect(page.getByTestId('schedule-run-now')).toBeDisabled();
  await page.getByTestId('schedule-hopper-card').first().press('Enter');
  await page.getByTestId('schedule-name').fill('Run this now');
  await page.getByTestId('schedule-date').fill('');
  await page.getByTestId('schedule-time').fill('');
  await expect(page.getByTestId('schedule-save')).toBeDisabled();
  await expect(page.getByTestId('schedule-run-now')).toBeEnabled();
  await page.screenshot({ path: path.join(shots, 'scheduled-run-now-composer.png') });
  await page.getByTestId('schedule-run-now').click();
  await expect(page.getByTestId('schedule-monitor')).toBeVisible();
  await expect(page.getByTestId('schedule-pause-banner')).toHaveAttribute('data-reason', 'budget');
  await expect(page.getByTestId('schedule-belt').locator('li')).toHaveCount(1);
});

test('a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped', async () => {
  const env = { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.1 }) };
  const { page, projectId, repo } = await launch({ env });
  // An uncommitted file in the base checkout is the one thing an unattended start must not decide for itself.
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n');
  const workflowId = await saveApprovalWorkflow(page, projectId);
  const runId = await scheduleSoon(page, projectId, 'Dirty base', 2, 4, workflowId);
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await quitWithArmedSchedule();
  await makeDueNow(runId);
  app = await launchTestApp(undefined, reuse, env, { openNewSession: false });
  const window = app.window;
  await openScheduleSidebar(window);
  const card = window.getByTestId('schedule-card').filter({ hasText: 'Dirty base' });
  await card.getByTestId('schedule-start-now').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused', { timeout: 30000 });
  await card.getByTestId('schedule-open').click();

  const banner = window.getByTestId('schedule-pause-banner');
  await expect(banner).toContainText('could not be started');
  await expect(banner).toContainText('uncommitted file');
  // Only the first ticket was attempted; the second is still waiting behind it, in order.
  expect(await window.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(0);
  const states = await window.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run.entries.map(entry => entry.outcome?.status ?? 'queued'), runId);
  expect(states).toEqual(['queued', 'queued']);
  await window.screenshot({ path: path.join(shots, 'scheduled-run-monitor-launch-paused.png') });

  // Skipping the stuck ticket lets the run carry on with the next one, which hits the same wall.
  await window.getByTestId('schedule-skip-entry').click();
  await expect(window.getByTestId('schedule-done-tray').locator('li[data-entry-status="skipped"]')).toHaveCount(1);
  await expect(window.getByTestId('schedule-pause-banner')).toBeVisible({ timeout: 20000 });

  // Clearing the cause and resuming starts the second ticket for real, through the workflow engine.
  fs.rmSync(path.join(repo, 'wip.txt'));
  await window.getByTestId('schedule-resume').click();
  await expect.poll(async () => (await window.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).length, { timeout: 30000 }).toBe(1);
});

test('quitting with a schedule pending asks first, and offers to minimise instead', async () => {
  const { page, projectId } = await launch();
  await scheduleSoon(page, projectId, 'Pending', 1, 3600);
  // Closing a window quits only on Windows/Linux; on macOS the quit itself is what stops a schedule.
  if (process.platform === 'darwin') void app!.electronApp.evaluate(({ app: electronApp }) => electronApp.quit());
  else void app!.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect(page.getByText('A scheduled run is waiting')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('dialog')).toContainText('Pending');
  await expect(page.getByRole('button', { name: 'Quit anyway' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minimise' })).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'scheduled-run-quit-warning.png') });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('A scheduled run is waiting')).toHaveCount(0);
  // Cancelled: the app is still alive and still has its schedule.
  expect(await page.evaluate(() => window.praxis.scheduledRuns.list().then(list => list.length))).toBe(1);
});

test('an idle failed stage pauses the schedule and retries in the same workflow', async () => {
  const { page, projectId, repo } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500' } });
  const marker = path.join(repo, 'retry-ready');
  const workflowId = await page.evaluate(async ({ projectId, marker }) => {
    const now = new Date().toISOString();
    const id = 'schedule-retry-stage';
    await window.praxis.workflows.save(projectId, {
      schemaVersion: 1, id, name: 'Recover build', scope: 'project', projectId, version: 1,
      entryNodeId: 'build', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'build', name: 'Build', x: 0, y: 0, inputs: [], command: 'test', args: ['-f', marker], successExitCodes: [0], maxAttempts: 3, outputs: [] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [{ id: 'next', from: 'build', to: 'approve', on: 'success', required: true }]
    } as never);
    return id;
  }, { projectId, marker });
  const scheduleId = await scheduleSoon(page, projectId, 'Recover failed build', 2, 120, workflowId);
  await page.evaluate(id => window.praxis.scheduledRuns.startNow(id), scheduleId);
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Recover failed build' });
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused', { timeout: 30000 });
  await card.getByTestId('schedule-open').click();
  await expect(page.getByTestId('schedule-proc-state')).toHaveText('Build — needs attention');
  await expect(page.getByTestId('schedule-stage-failure')).toContainText('Attempt 1 of 3');
  await expect(page.getByTestId('schedule-pause-banner')).toHaveAttribute('data-reason', 'failure');
  await expect(page.getByTestId('schedule-review-workflow')).toBeVisible();
  await expect(page.getByTestId('schedule-belt').locator('li[data-issue]')).toHaveCount(1);
  const before = await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId);
  expect(before).toHaveLength(1);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-stage-failure.png') });
  fs.writeFileSync(marker, 'ready');
  await page.getByTestId('schedule-retry').click();
  await expect.poll(async () => (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId))[0].status, { timeout: 10000 }).toBe('awaiting-approval');
  await expect(page.getByTestId('schedule-pause-banner')).toHaveAttribute('data-reason', 'approval', { timeout: 10000 });
  await expect(page.getByTestId('schedule-stage-failure')).toHaveCount(0);
  const after = await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId);
  expect(after.map(run => run.runId)).toEqual(before.map(run => run.runId));
  expect(after[0].stages.find(stage => stage.nodeId === 'build')?.attempts).toBe(2);
});

test('the stage-failure panel names the stage it shows, beside a stage paused for a missing tool or script', async () => {
  // The shape of a real Full SDLC run on a repo the template did not fit: SAST paused
  // because semgrep was missing, while a different stage had failed. The panel titled
  // itself "SAST scan" but showed the other stage's error and retried that stage.
  const { page, projectId, repo } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500' } });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: {} }));
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '-qm', 'package.json'], { cwd: repo, stdio: 'ignore' });
  const workflowId = await page.evaluate(async ({ projectId, missing }) => {
    const now = new Date().toISOString();
    const id = 'schedule-mixed-stages';
    const check = (id: string, name: string, x: number, command: string, args: string[]) =>
      ({ type: 'check', id, name, x, y: 120, inputs: [], command, args, successExitCodes: [0], maxAttempts: 2, outputs: [] });
    await window.praxis.workflows.save(projectId, {
      schemaVersion: 1, id, name: 'Mixed stages', scope: 'project', projectId, version: 1,
      entryNodeId: 'start', createdAt: now, updatedAt: now,
      nodes: [
        check('start', 'Start', 0, 'true', []),
        // exit 127 is how a shell reports a missing command; a made-up command name
        // would now be refused before the run starts.
        check('sast', 'SAST scan', 0, 'sh', ['-c', 'exit 127']),
        check('lint', 'Lint', 240, 'npm', ['run', 'lint']),
        check('build', 'Build', 480, 'test', ['-f', missing])
      ],
      edges: ['sast', 'lint', 'build'].map(to => ({ id: `start-${to}`, from: 'start', to, on: 'success', required: true }))
    } as never);
    return id;
  }, { projectId, missing: path.join(repo, 'never-created') });
  const scheduleId = await scheduleSoon(page, projectId, 'Mixed stage outcomes', 1, 120, workflowId);
  await page.evaluate(id => window.praxis.scheduledRuns.startNow(id), scheduleId);
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Mixed stage outcomes' });
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused', { timeout: 30000 });
  await card.getByTestId('schedule-open').click();

  const failure = page.getByTestId('schedule-stage-failure');
  await expect(page.getByTestId('schedule-proc-state')).toHaveText('Build — needs attention');
  await expect(failure).toContainText('Build — needs attention');
  await expect(failure).toContainText('test exited 1');

  // A missing script is the project's setup, not lint's verdict: it pauses with the reason.
  const stages = (await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId))[0].stages;
  const lint = stages.find(stage => stage.nodeId === 'lint');
  expect(lint?.lane).toBe('paused');
  expect(lint?.lastError).toContain('This project has no "lint" script');
  expect(stages.find(stage => stage.nodeId === 'sast')?.lane).toBe('paused');
});

test('a workflow whose check stage needs a tool that is not installed is refused before the run starts', async () => {
  // A Full SDLC run used to spend Implement's time and only then pause at SAST
  // because semgrep was missing. The tool is now checked when the run starts.
  const { page, projectId } = await launch({ env: { PRAXIS_E2E_SCHEDULE_TICK_MS: '500' } });
  const workflowId = await page.evaluate(async projectId => {
    const now = new Date().toISOString();
    const id = 'schedule-missing-scanner';
    const check = (id: string, name: string, x: number, command: string) =>
      ({ type: 'check', id, name, x, y: 120, inputs: [], command, args: [], successExitCodes: [0], outputs: [] });
    await window.praxis.workflows.save(projectId, {
      schemaVersion: 1, id, name: 'Missing scanner', scope: 'project', projectId, version: 1,
      entryNodeId: 'start', createdAt: now, updatedAt: now,
      nodes: [
        check('start', 'Start', 0, 'true'),
        check('sast', 'SAST scan', 240, 'praxis-e2e-no-such-scanner'),
        check('sast-strict', 'SAST (strict)', 480, 'praxis-e2e-no-such-scanner')
      ],
      edges: ['sast', 'sast-strict'].map(to => ({ id: `start-${to}`, from: 'start', to, on: 'success', required: true }))
    } as never);
    return id;
  }, projectId);
  const scheduleId = await scheduleSoon(page, projectId, 'Missing scanner', 1, 120, workflowId);
  await page.evaluate(id => window.praxis.scheduledRuns.startNow(id), scheduleId);
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Missing scanner' });
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused', { timeout: 30000 });
  await card.getByTestId('schedule-open').click();

  const banner = page.getByTestId('schedule-pause-banner');
  await expect(banner).toContainText('praxis-e2e-no-such-scanner (needed by SAST scan, SAST (strict))');
  await expect(banner).toContainText('make sure it is on your PATH');
  expect(await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(0);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-missing-tool.png') });
});

test('an older schedule refresh cannot overwrite a newer failure status', async () => {
  const { page, projectId } = await launch();
  await scheduleSoon(page, projectId, 'Refresh ordering', 1, 120);
  const views = await page.evaluate(() => window.praxis.scheduledRuns.list());
  await app!.electronApp.evaluate(({ ipcMain }, views) => {
    let calls = 0;
    const state = globalThis as typeof globalThis & { releaseScheduleRefresh?: () => void };
    ipcMain.removeHandler('scheduledRuns:list');
    ipcMain.handle('scheduledRuns:list', async () => {
      const first = ++calls === 1;
      if (first) await new Promise<void>(resolve => { state.releaseScheduleRefresh = resolve; });
      return views.map(view => ({ ...view, run: { ...view.run, status: first ? 'running' : 'paused' } }));
    });
  }, views);
  const changed = () => app!.electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('scheduledRuns:changed');
  });
  await changed();
  await expect.poll(() => app!.electronApp.evaluate(() => !!(globalThis as typeof globalThis & { releaseScheduleRefresh?: () => void }).releaseScheduleRefresh)).toBe(true);
  await changed();
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Refresh ordering' });
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused');
  await app!.electronApp.evaluate(() => (globalThis as typeof globalThis & { releaseScheduleRefresh?: () => void }).releaseScheduleRefresh!());
  // Wait for the old promise, its load handler, and React's paint to finish.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card.getByTestId('schedule-status')).toHaveText('Paused');
});

test('an agent request file becomes an ordered draft while Praxis is running, and the skill that explains it is installed', async () => {
  const { page, repo } = await launch();
  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
  await expect(page.getByTestId('schedule-empty')).toBeVisible();

  // The built-in praxis-scheduled-runs skill is installed for every user.
  const skillFile = path.join(app!.userDataDir, 'skills', 'praxis-scheduled-runs', 'SKILL.md');
  await expect.poll(() => fs.existsSync(skillFile)).toBe(true);
  expect(fs.readFileSync(skillFile, 'utf8')).toContain('praxis.scheduledRunRequest');

  // Read the board keys the hopper offers, then queue them in reverse through a file.
  await page.getByTestId('schedule-new').click();
  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  await page.getByTestId('schedule-cancel').click();
  const wanted = [...keys].reverse();
  const dir = path.join(repo, '.praxis', 'scheduled-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'overnight.json'), JSON.stringify({
    schemaVersion: 1, kind: 'praxis.scheduledRunRequest', name: 'Overnight from a file',
    date: '2099-01-02', time: '21:00', timezone: 'Europe/London', tickets: wanted
  }));

  const statusFile = path.join(dir, 'overnight.status.json');
  await expect.poll(() => fs.existsSync(statusFile), { timeout: 20000 }).toBe(true);
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  expect(status.state, JSON.stringify(status.errors)).toBe('imported');
  expect(status.runStatus).toBe('draft');
  expect(status.entries.map((entry: { issueKey: string }) => entry.issueKey)).toEqual(wanted);

  const card = page.getByTestId('schedule-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('schedule-card-name')).toHaveText('Overnight from a file');
  expect(await miniOrder(card)).toEqual(wanted);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'scheduled-run-from-request-file.png') });

  // A rejected request says why and saves nothing.
  fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ schemaVersion: 1, kind: 'praxis.scheduledRunRequest', name: 'Broken', date: '2099-01-02', time: '21:00', timezone: 'Europe/London', tickets: ['NOPE-1'] }));
  const brokenStatus = path.join(dir, 'broken.status.json');
  await expect.poll(() => fs.existsSync(brokenStatus), { timeout: 20000 }).toBe(true);
  expect(JSON.parse(fs.readFileSync(brokenStatus, 'utf8')).errors.join(' ')).toContain('NOPE-1 was not found');
  await expect(page.getByTestId('schedule-card')).toHaveCount(1);
});


// ── Bounded parallel lanes (FX-BE-149) ──────────────────────────────────

/**
 * Saves and starts a parallel run through the real IPC: `steps` lists ticket
 * indexes per step, e.g. `[[0, 1, 2], [3]]`. Returns the run id and the keys.
 */
async function startParallelRun(page: Page, projectId: string, name: string, steps: number[][], maxConcurrency: number, workflowId: string): Promise<{ runId: string; keys: string[] }> {
  return page.evaluate(async ({ id, name, steps, maxConcurrency, workflowId }) => {
    const connectionId = `project:${id}`;
    const issues = (await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 20, connectionId)).issues;
    const picked = steps.flat().map(index => issues[index]);
    const tickets = picked.map(issue => ({ connectionId, issueKey: issue.key, title: issue.summary }));
    const withPrevious = steps.flatMap(step => step.slice(1).map(index => `${connectionId}\u0000${issues[index].key}`));
    const view = await window.praxis.scheduledRuns.save({ projectId: id, name, timezone: 'UTC', date: '', time: '', tickets, withPrevious, maxConcurrency, workflowId, arm: false, startNow: true });
    return { runId: view.run.id, keys: picked.map(issue => issue.key) };
  }, { id: projectId, name, steps, maxConcurrency, workflowId });
}

const entriesOf = (page: Page, runId: string) => page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run.entries.map(entry => ({
  key: entry.ticket.issueKey, status: entry.outcome?.status ?? 'queued', lane: entry.outcome?.lane, laneReason: entry.outcome?.laneReason, workflowRunId: entry.outcome?.workflowRunId
})), runId);
const eventsOf = (page: Page, runId: string) => page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run.events.map(event => event.message), runId);

test('parallel lanes are a deliberate choice in the editor: a budget warning shows, and the choice survives saving', async () => {
  const titles = ['Fix pager bug', 'Add export CSV', 'Log retention'];
  const { page } = await launch({ titles });
  await page.getByTestId('schedule-new').click();
  for (const title of titles) await page.getByTestId('schedule-hopper-card').filter({ hasText: title }).press('Enter');
  const node = (text: string) => page.getByTestId('schedule-belt-card').filter({ hasText: text });
  await page.waitForTimeout(800);
  await node('Log retention').dragTo(node('Add export CSV'));
  await expect(page.getByTestId('schedule-flow-step')).toHaveCount(2);

  // Sequential is the default, with no warning.
  await expect(page.getByTestId('schedule-lanes')).toHaveAttribute('data-value', '1');
  await expect(page.getByTestId('schedule-lanes-warning')).toHaveCount(0);
  await chooseOption(page.getByTestId('schedule-lanes'), { label: 'Up to 2 at once' });
  await expect(page.getByTestId('schedule-lanes-warning')).toContainText('uses provider allowance up to 2 times as fast');
  await expect(page.getByTestId('schedule-readiness').locator('[data-code="parallel-lanes"]')).toContainText('Up to 2 tickets of a shared step run at once');
  await expect(page.getByTestId('schedule-summary')).toContainText('up to 2 at once');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-parallel-editor.png') });

  await page.getByTestId('schedule-name').fill('Parallel night');
  await page.getByTestId('schedule-save-draft').click();
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Parallel night' });
  await expect(card).toBeVisible();
  const policy = await page.evaluate(async () => (await window.praxis.scheduledRuns.list()).find(view => view.run.name === 'Parallel night')?.run.policy);
  expect(policy).toMatchObject({ mode: 'parallel', maxConcurrency: 2 });
  await card.getByTestId('schedule-edit').click();
  await expect(page.getByTestId('schedule-lanes')).toHaveAttribute('data-value', '2');
  await expect(page.getByTestId('schedule-lanes-warning')).toBeVisible();
});

test('two independent tickets run at once within the cap, a third waits for a lane and the next step waits for the first', async () => {
  const env = { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.1 }) };
  const { page, projectId } = await launch({ env, titles: ['Lane one', 'Lane two', 'Lane three', 'After the step'] });
  const workflowId = await saveApprovalWorkflow(page, projectId);
  const { runId, keys } = await startParallelRun(page, projectId, 'Two at once', [[0, 1, 2], [3]], 2, workflowId);

  await expect.poll(async () => (await entriesOf(page, runId)).filter(entry => entry.workflowRunId).length, { timeout: 30000 }).toBe(2);
  // Settle a few ticks: the cap must hold, and nothing from step 2 may start.
  await page.waitForTimeout(2500);
  const entries = await entriesOf(page, runId);
  expect(entries.filter(entry => entry.workflowRunId).map(entry => entry.key)).toEqual([keys[0], keys[1]]);
  expect(entries.map(entry => entry.lane)).toEqual([1, 2, undefined, undefined]);
  expect(entries[1].laneReason).toMatch(new RegExp(`runs alongside ${keys[0]}; tickets in step 1 do not depend on each other`));
  expect(entries[2].status).toBe('queued');
  expect(entries[3].status).toBe('queued');
  expect(await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(2);
  // The ledger records each concurrent launch with its lane and rationale.
  const events = await eventsOf(page, runId);
  expect(events.some(message => message.startsWith(`Starting ${keys[1]}`) && /in lane 2: runs alongside/.test(message))).toBe(true);

  await openScheduleSidebar(page);
  const card = page.getByTestId('schedule-card').filter({ hasText: 'Two at once' });
  await card.getByTestId('schedule-open').click();
  const lanes = page.getByTestId('schedule-lanes-panel');
  await expect(lanes).toContainText('2 of up to 2 in use');
  await expect(lanes.getByTestId('schedule-lane')).toHaveCount(2);
  await expect(lanes.getByTestId('schedule-lane-reason').nth(1)).toContainText('runs alongside');
  await expect(lanes.getByTestId('schedule-lanes-waiting').locator(`li[data-issue="${keys[3]}"]`)).toContainText('Waits for step 1 to finish.');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-parallel-monitor.png') });
});

for (const [label, usage, expected] of [
  ['an allowance without room for two', { 'custom:mock': 0.8 }, /waits for a free lane: .*not enough for 2 tickets/],
  ['an allowance the provider does not report', {}, /waits for a free lane: .*does not report its allowance/]
] as const) {
  test(`${label} keeps the run to one lane and says why`, async () => {
    const env = { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify(usage) };
    const { page, projectId } = await launch({ env, titles: ['Lane one', 'Lane two'] });
    const workflowId = await saveApprovalWorkflow(page, projectId);
    const { runId, keys } = await startParallelRun(page, projectId, 'Held lane', [[0, 1]], 2, workflowId);
    await expect.poll(async () => (await entriesOf(page, runId)).filter(entry => entry.workflowRunId).length, { timeout: 30000 }).toBe(1);
    await page.waitForTimeout(2500);
    const entries = await entriesOf(page, runId);
    expect(entries.map(entry => entry.status)).toEqual([expect.stringMatching(/running|paused/), 'queued']);
    const held = (await eventsOf(page, runId)).filter(message => message.startsWith(`${keys[1]} waits for a free lane`));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(expected);
    await openScheduleSidebar(page);
    await page.getByTestId('schedule-card').filter({ hasText: 'Held lane' }).getByTestId('schedule-open').click();
    await expect(page.getByTestId('schedule-activity')).toContainText(`${keys[1]} waits for a free lane`);
  });
}


test('two parallel tickets that both merge into the base checkout take turns', async () => {
  const HOLD = 3000;
  const env = { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.1 }), PRAXIS_E2E_MERGE_HOLD_MS: String(HOLD) };
  const { page, projectId, repo } = await launch({ env, titles: ['Merge one', 'Merge two'] });
  const workflowId = await page.evaluate(async id => {
    const now = new Date().toISOString();
    const workflowId = 'schedule-merge-only';
    await window.praxis.workflows.save(id, {
      schemaVersion: 1, id: workflowId, name: 'Merge only', scope: 'project', projectId: id, version: 1,
      entryNodeId: 'merge', createdAt: now, updatedAt: now, edges: [],
      nodes: [{ type: 'merge', id: 'merge', name: 'Merge', x: 0, y: 0, inputs: [], onConflict: 'fail' }]
    } as never);
    // A merge re-checks workspace trust when it runs; trust this workflow as a person reviewing it would.
    const trust = await window.praxis.workflows.projectTrust(id, workflowId);
    if (!trust.trusted) await window.praxis.workflows.approveProjectTrust(id, workflowId, trust.fingerprint);
    return workflowId;
  }, projectId);
  // Deliberately no .gitignore entry for .worktrees and nothing committed: Praxis's worktrees and its own
  // metadata (the workflow file, the project brief) must not make the base read as dirty.
  const { runId } = await startParallelRun(page, projectId, 'Two merges', [[0, 1]], 2, workflowId);
  await expect.poll(async () => (await entriesOf(page, runId)).filter(entry => entry.workflowRunId).length, { timeout: 30000 }).toBe(2);
  const runIds = (await entriesOf(page, runId)).map(entry => entry.workflowRunId!);

  // Watch both merge stages finish. Taking turns, the second ends a full hold after the first;
  // overlapping, they would end together.
  const ended = new Map<string, number>();
  await expect.poll(async () => {
    for (const id of runIds) {
      if (ended.has(id)) continue;
      const summary = await page.evaluate(run => window.praxis.workflows.getRun(run), id);
      const stage = summary?.stages.find(row => row.nodeId === 'merge');
      if (stage?.lane === 'failed') throw new Error(`Merge failed: ${JSON.stringify(summary?.stages)}\n${execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo }).toString()}\n${execFileSync('git', ['log', '--oneline', '-5'], { cwd: repo }).toString()}`);
      if (stage?.lane === 'done') ended.set(id, Date.now());
    }
    return ended.size;
  }, { timeout: 60000, intervals: [100] }).toBe(2);
  const [first, second] = [...ended.values()].sort((a, b) => a - b);
  expect(second - first).toBeGreaterThanOrEqual(HOLD * 0.8);
  await expect.poll(async () => (await entriesOf(page, runId)).map(entry => entry.status), { timeout: 30000 }).toEqual(['done', 'done']);
  await expect.poll(async () => page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run.status, runId)).toBe('completed');
});

test('a parallel run whose readiness is blocked starts nothing in any lane and says why', async () => {
  const env = { PRAXIS_E2E_SCHEDULE_TICK_MS: '500', PRAXIS_E2E_PROVIDER_USAGE: JSON.stringify({ 'custom:mock': 0.1 }) };
  const { page, projectId, repo } = await launch({ env, titles: ['Lane one', 'Lane two'] });
  const workflowId = await saveApprovalWorkflow(page, projectId);
  // An uncommitted file in the base checkout is the one thing an unattended start must not decide for itself.
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n');
  const { runId, keys } = await startParallelRun(page, projectId, 'Blocked lanes', [[0, 1]], 2, workflowId);
  await expect.poll(async () => page.evaluate(async id => (await window.praxis.scheduledRuns.get(id))!.run.status, runId), { timeout: 30000 }).toBe('paused');
  await page.waitForTimeout(2000);
  expect(await page.evaluate(id => window.praxis.workflows.listRuns(id), projectId)).toHaveLength(0);
  expect((await entriesOf(page, runId)).map(entry => entry.status)).toEqual(['queued', 'queued']);
  await openScheduleSidebar(page);
  await page.getByTestId('schedule-card').filter({ hasText: 'Blocked lanes' }).getByTestId('schedule-open').click();
  await expect(page.getByTestId('schedule-pause-banner')).toContainText(`${keys[0]} could not be started`);
  await expect(page.getByTestId('schedule-lanes-panel')).toContainText('0 of up to 2 in use');
});
