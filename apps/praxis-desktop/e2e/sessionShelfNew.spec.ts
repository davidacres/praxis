import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The shelf's new-session card: a session starts and stays in the shelf, a goal that
 * matches today's session can be added to it instead, a note can become a goal, and
 * the two creation cells label themselves and draw their glyphs on whole pixels.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

const GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined, FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined, VERCEL_AI_GATEWAY_URL: undefined, FROSTY_VERCEL_URL: undefined
};

/** One completed session from a minute ago, so "today" has something to match. */
function seedSession(userDataDir: string): void {
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const sessions = {
    'SESSION-shelfnew0': {
      issueKey: 'SESSION-shelfnew0', sessionId: 'shelfnew-0', title: 'Shelf design', state: 'completed', startedAt: timestamp,
      completedAt: timestamp, provider: 'openai', model: 'mock/model', taskDefinition: { goal: 'Explore the shelf design.' },
      events: [{ timestamp, type: 'message', summary: 'The card slides out over 240ms.' }]
    }
  };
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': sessions }));
}

async function launchWithProvider(mode: 'complete' | 'hang'): Promise<Page> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-new-'));
  seedSession(userDataDir);
  mock = await startMockGatewayServer({ mode, models: [{ id: 'mock/model' }] });
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, GATEWAY_ENV, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async ({ baseUrl }) => {
    await window.praxis.settings.set({ ai: { activeProvider: 'openai', providers: { openai: { baseUrl } } } } as never);
    await window.praxis.ai.setProviderApiKey('openai', 'e2e-shelf-new-key');
  }, { baseUrl: mock!.baseUrl });
  return page;
}

async function openShelf(page: Page) {
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  const shelf = page.getByTestId('session-shelf');
  await expect(shelf).toBeVisible();
  return shelf;
}

test('a session started from the shelf stays in the shelf as its own preview card', async () => {
  test.slow();
  const page = await launchWithProvider('hang');
  const shelf = await openShelf(page);
  await expect(shelf.getByTestId('session-shelf-spine')).toHaveCount(1);
  await shelf.getByTestId('session-shelf-new').click();
  const goal = page.getByTestId('shelf-new-goal');
  await expect(goal).toBeFocused();
  // Starters show while the goal is empty; ↓ reaches them and picking one fills the goal.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(goal).toHaveValue('Explain this codebase');
  await goal.fill('Make the shelf create buttons easier to see');
  await page.keyboard.press('Enter');

  const card = page.getByTestId('session-shelf-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading')).toHaveText('Make the shelf create buttons easier to see');
  await expect(card.getByTestId('session-shelf-status')).toHaveText(/Working|Waiting for you/);
  await expect(shelf.getByTestId('session-shelf-spine')).toHaveCount(2);
  // Nothing navigated: the composer page never opened.
  await expect(page.getByTestId('new-session-view')).toHaveCount(0);
  const stored = await page.evaluate(async () => (await window.praxis.ai.listSessions()).map(session => session.title));
  expect(stored).toContain('Make the shelf create buttons easier to see');
  // The card stays level with the cell that started it, not with the new spine.
  const cell = (await shelf.getByTestId('session-shelf-new').boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(Math.abs(cardBox.y + cardBox.height - (cell.y + cell.height))).toBeLessThanOrEqual(1.5);
});

test('a goal that matches one of today\'s sessions can be added to it with ⌘↵', async () => {
  test.slow();
  const page = await launchWithProvider('complete');
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-new').click();
  const goal = page.getByTestId('shelf-new-goal');
  await goal.fill('Tighten the shelf design spacing');
  await expect(page.getByTestId('shelf-new-match')).toContainText('Shelf design');
  await goal.press('ControlOrMeta+Enter');
  // The message went into the existing session, and that session's card is now open.
  await expect.poll(async () => page.evaluate(async () => {
    const session = await window.praxis.ai.getSession('SESSION-shelfnew0');
    return JSON.stringify(session?.events ?? []).includes('Tighten the shelf design spacing');
  })).toBe(true);
  await expect(page.getByTestId('session-shelf-card').getByRole('heading')).toHaveText('Shelf design');
  const count = await page.evaluate(async () => (await window.praxis.ai.listSessions()).length);
  expect(count).toBe(1);
});

test('the creation cells label themselves, fill solid, and draw their glyphs on whole pixels', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const shelf = await openShelf(page);
  const cell = shelf.getByTestId('session-shelf-new');
  // The flag replaces the native tooltip, so the button's own title stays empty.
  await page.keyboard.press('Shift');
  await cell.focus();
  await expect(page.getByTestId('session-shelf-flag')).toHaveText(/^New session/);
  await expect(cell).toHaveAttribute('title', '');
  await expect(cell).toHaveClass(/is-flagged/);
  const filled = await cell.evaluate(element => getComputedStyle(element).backgroundColor);
  const accent = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(filled).toBe(accent);

  // At Compact the 10px glyph starts on a whole pixel. Proven against the centred
  // layout this replaced, which put it at x = 1.5 inside the 13px cell.
  const glyphX = () => cell.locator('.session-shelf__glyph--10').evaluate(element => element.getBoundingClientRect().x);
  expect(Number.isInteger(await glyphX())).toBe(true);
  const centred = await page.addStyleTag({ content: '.session-shelf__action { place-items: center !important; padding-left: 0 !important; }' });
  expect(Number.isInteger(await glyphX())).toBe(false);
  await centred.evaluate(node => (node as Element).remove());
});

test('a note becomes a session goal in one press', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    await window.praxis.projects.create({
      name: 'Shelf Goals', key: 'SHG', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }]
    } as never, workspace.id);
  });
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-notes').click();
  const card = page.getByTestId('session-shelf-notes-card');
  await expect(card.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type('Gate failure');
  // Enter moves on from the title line into the body.
  await page.keyboard.press('Enter');
  await expect(card.getByTestId('note-body')).toBeFocused();
  await page.keyboard.type('Snapshot moved 8px.');
  await card.getByTestId('note-use-as-goal').click();
  const goal = page.getByTestId('shelf-new-goal');
  await expect(goal).toHaveValue('Gate failure\n\nSnapshot moved 8px.');
  await expect(goal).toBeFocused();
});

test('with no usable provider the card keeps the goal and offers setup instead of sending', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async () => {
    const statuses = await window.praxis.ai.listProviderStatuses();
    await window.praxis.settings.set({ ai: { providers: Object.fromEntries(statuses.map(status => [status.provider, { enabled: false }])) } } as never);
  });
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-new').click();
  await expect(page.getByTestId('shelf-new-no-provider')).toBeVisible();
  await page.getByTestId('shelf-new-goal').fill('Keep this goal');
  await expect(page.getByTestId('shelf-new-start')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up a provider' })).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(async () => (await window.praxis.ai.listSessions()).length)).toBe(0);
  await expect(page.getByTestId('shelf-new-goal')).toHaveValue('Keep this goal');
});
