import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * Shelf spines and cards by session state: each spine draws its state, the two
 * states that need you carry a cap, and each card leads with that state's action
 * (approve, stop, retry), the agent's task list and the files its tools changed.
 * Sessions are saved finished and then pushed live, as a running session would be.
 */

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

type Row = { title: string; state: string; minutesAgo: number; extra?: Record<string, unknown> };

const ROWS: Row[] = [
  { title: 'Re-run the UI gate', state: 'executing', minutesAgo: 2, extra: {
    events: [{ type: 'tool_start', summary: 'Running tool', data: { argsSummary: 'npx playwright test themes.spec.ts' } }],
    taskList: [
      { content: 'Build the renderer', status: 'completed', priority: 'high' },
      { content: 'Run themes.spec.ts', status: 'in_progress', priority: 'high' },
      { content: 'Report the diff', status: 'pending', priority: 'low' }
    ]
  } },
  { title: 'Tidy the shelf CSS', state: 'awaiting_approval', minutesAgo: 9, extra: {
    events: [{ type: 'permission_requested', summary: 'Run npm run build:renderer', detail: 'in apps/praxis-desktop' }]
  } },
  { title: 'Explain the notes store', state: 'awaiting_input', minutesAgo: 25, extra: {
    events: [{ type: 'message', summary: 'Share the same draft, or keep its own?' }]
  } },
  { title: 'Review changes', state: 'completed', minutesAgo: 80, extra: {
    workingDirectory: '/repo',
    changeSummary: { files: [{ path: '/repo/src/theme.css', added: 31, removed: 6 }, { path: 'src/app.ts', added: 4, removed: 0 }], added: 35, removed: 6 }
  } },
  { title: 'API migration', state: 'failed', minutesAgo: 60 * 26, extra: {
    events: [{ type: 'error', summary: 'Claude Code exited: rate limit reached' }]
  } },
  { title: 'Theme tokens', state: 'completed', minutesAgo: 60 * 50 },
  { title: 'Board filters', state: 'completed', minutesAgo: 60 * 70 }
];

async function launchWithStates(): Promise<{ page: Page; records: Record<string, unknown>[] }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-states-'));
  const now = Date.now();
  const records = ROWS.map((row, index) => {
    const at = new Date(now - row.minutesAgo * 60_000).toISOString();
    const { events = [], ...rest } = (row.extra ?? {}) as { events?: object[] };
    return {
      issueKey: `SESSION-st${index}`, sessionId: `st-${index}`, title: row.title, state: row.state, startedAt: at, lastActivityAt: at,
      provider: 'openai', model: 'mock/model', stepCount: 1, taskDefinition: { goal: row.title },
      events: events.map(event => ({ timestamp: at, ...event })), ...rest
    } as Record<string, unknown>;
  });
  // On disk every session is finished, so the app opens without a recovery prompt.
  const stored = Object.fromEntries(records.map(record => [record.issueKey, { ...record, state: record.state === 'failed' ? 'failed' : 'completed', completedAt: record.startedAt }]));
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': stored }));
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  {
    const live = records;
    for (const record of live) await app.emitEvent('ai:sessionChanged', record);
  }
  const page = app.window;
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-shelf-spine')).toHaveCount(5);
  return { page, records };
}

/** Replaces a backend channel with a stand-in that records its arguments. */
const recordedCalls = new Map<string, unknown[][]>();
async function recordIpc(channel: string): Promise<void> {
  const calls: unknown[][] = [];
  recordedCalls.set(channel, calls);
  await app!.overrideChannel(channel, args => { calls.push(args); });
}
const ipcCalls = async (channel: string) => recordedCalls.get(channel) as unknown[][];

test('each spine draws its session\'s state, with a cap only where you are needed', async () => {
  test.slow();
  const { page } = await launchWithStates();
  const spines = page.getByTestId('session-shelf-spine');
  expect(await spines.evaluateAll(elements => elements.map(element => element.getAttribute('data-state'))))
    .toEqual(['run', 'appr', 'wait', 'done', 'fail']);
  // The old 4px dot sat between spines; now the two needs carry a cap on their own spine.
  const caps = page.getByTestId('session-shelf-attention');
  await expect(caps).toHaveCount(2);
  await expect(spines.nth(1).getByTestId('session-shelf-attention')).toHaveCount(1);
  await expect(spines.nth(2).getByTestId('session-shelf-attention')).toHaveCount(1);
  // Failed no longer looks like done.
  const colour = (index: number) => spines.nth(index).evaluate(element => getComputedStyle(element, '::before').backgroundColor);
  expect(await colour(3)).not.toBe(await colour(4));
  // A task list turns the working spine into a track; reported changes add a diff bar.
  await expect(spines.nth(0).getByTestId('session-shelf-track')).toHaveCount(1);
  await expect(spines.nth(3).getByTestId('session-shelf-diff')).toHaveCount(1);
  // Two more sessions than the shelf holds: the overflow cell lists them all.
  const more = page.getByTestId('session-shelf-more');
  await expect(more).toHaveText('+2');
  await more.click();
  const list = page.getByTestId('session-shelf-list-card');
  await expect(list).toBeVisible();
  await expect(page.getByTestId('shelf-list-search')).toBeFocused();
  await page.keyboard.type('board');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('Board filters');
});

test('an approval card shows the request and answers it in place', async () => {
  test.slow();
  const { page } = await launchWithStates();
  await recordIpc('ai:respondToPermission');
  await page.keyboard.press('Shift');
  await page.getByTestId('session-shelf-spine').nth(1).focus();
  const card = page.getByTestId('session-shelf-card');
  await expect(card.getByTestId('session-shelf-status')).toHaveText('Needs approval');
  await expect(card.getByTestId('session-shelf-permission')).toContainText('Run npm run build:renderer');
  await card.getByTestId('shelf-permission-always').check();
  await card.getByTestId('shelf-permission-allow').click();
  await expect.poll(() => ipcCalls('ai:respondToPermission')).toEqual([['SESSION-st1', 'allow_always']]);
});

test('a working card shows the live step and the task list, and stops the session', async () => {
  test.slow();
  const { page } = await launchWithStates();
  await recordIpc('ai:abort');
  await page.keyboard.press('Shift');
  await page.getByTestId('session-shelf-spine').first().focus();
  const card = page.getByTestId('session-shelf-card');
  await expect(card.getByTestId('session-shelf-status')).toHaveText('Working');
  await expect(card).toContainText('npx playwright test themes.spec.ts');
  await expect(card.getByTestId('session-shelf-plan')).toContainText('Step 2 of 3');
  await card.getByTestId('shelf-stop').click();
  await expect.poll(() => ipcCalls('ai:abort')).toEqual([['SESSION-st0']]);
});

test('arrow keys walk the shelf, and done and failed cards lead with their outcome', async () => {
  test.slow();
  const { page } = await launchWithStates();
  await page.keyboard.press('Shift');
  await page.getByTestId('session-shelf-spine').nth(2).focus();
  const card = page.getByTestId('session-shelf-card');
  await expect(card.getByTestId('session-shelf-status')).toHaveText('Needs your reply');
  await page.keyboard.press('ArrowDown');
  await expect(card.getByRole('heading')).toHaveText('Review changes');
  const changes = card.getByTestId('session-shelf-changes');
  await expect(changes).toContainText('2 files');
  await expect(changes).toContainText('+35');
  await expect(changes).toContainText('theme.css');
  await expect(changes).not.toContainText('/repo/');
  await card.getByRole('button', { name: 'Next session' }).click();
  await expect(card.getByRole('heading')).toHaveText('API migration');
  await expect(card.getByTestId('shelf-failed-error')).toContainText('rate limit reached');
  await expect(card.getByTestId('shelf-try-again')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Next session' })).toBeDisabled();
});
