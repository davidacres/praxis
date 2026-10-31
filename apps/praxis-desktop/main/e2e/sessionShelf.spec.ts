import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

/** Two completed sessions active today plus four from earlier days (only the last 5 appear on the shelf). */
function seedSessions(userDataDir: string, withMessage: boolean): void {
  const now = new Date();
  const todayTitles = ['Shelf design', 'Review changes'];
  const earlierTitles = ['Yesterday audit', 'API migration', 'Theme tokens', 'Archived backlog'];
  const sessions: Record<string, unknown> = {};
  todayTitles.forEach((title, index) => {
    const issueKey = `SESSION-shelf${index}`;
    const timestamp = new Date(now.getTime() - index * 60_000).toISOString();
    sessions[issueKey] = {
      issueKey, sessionId: `shelf-${index}`, title, state: 'completed', startedAt: timestamp,
      completedAt: timestamp, provider: 'openai', model: 'mock/model',
      taskDefinition: { goal: `Explore ${title.toLowerCase()} with a compact session shelf.` },
      events: withMessage && index === 0
        ? [{ timestamp, type: 'user_input_completed', summary: 'Can you check the hover timing?' },
          { timestamp, type: 'message', summary: 'The card slides out over 240ms — quick enough to feel tucked away.' }]
        : []
    };
  });
  earlierTitles.forEach((title, index) => {
    const issueKey = `SESSION-earlier${index}`;
    const when = new Date(now);
    when.setDate(when.getDate() - (index + 1));
    const timestamp = when.toISOString();
    sessions[issueKey] = {
      issueKey, sessionId: `earlier-${index}`, title, state: 'completed', startedAt: timestamp,
      completedAt: timestamp, provider: 'openai', model: 'mock/model',
      taskDefinition: { goal: `Follow up on ${title.toLowerCase()}.` },
      events: []
    };
  });
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': sessions }));
}

test('collapsed session shelf shows the last 5 sessions, distinguishes today, and reveals cards on hover and focus', async () => {
  test.slow();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-'));
  seedSessions(userDataDir, false);
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  const shelf = page.getByTestId('session-shelf');
  await expect(shelf).toBeVisible();
  expect((await shelf.boundingBox())!.width).toBeLessThan(20);
  await expect(shelf.getByTestId('session-shelf-spine')).toHaveCount(5);
  await expect(shelf.getByRole('button', { name: 'Preview Archived backlog', exact: true })).toHaveCount(0);
  await expect(shelf.locator('.session-shelf__spine.is-today')).toHaveCount(2);
  await expect(shelf.locator('.session-shelf__spine[data-recency="earlier"]')).toHaveCount(3);
  const spineVisuals = await shelf.evaluate(element => {
    const todaySpine = element.querySelector('.session-shelf__spine.is-today')!;
    const earlierSpine = element.querySelector('.session-shelf__spine:not(.is-today)')!;
    const todayBefore = getComputedStyle(todaySpine, '::before');
    const earlierBefore = getComputedStyle(earlierSpine, '::before');
    const todayAfter = getComputedStyle(todaySpine, '::after');
    return {
      todayHeight: parseFloat(todayBefore.height),
      earlierHeight: parseFloat(earlierBefore.height),
      todayWidth: parseFloat(todayBefore.width),
      earlierWidth: parseFloat(earlierBefore.width),
      todayColor: todayBefore.backgroundColor,
      earlierColor: earlierBefore.backgroundColor,
      todayPipWidth: parseFloat(todayAfter.width)
    };
  });
  expect(spineVisuals.todayHeight).toBeGreaterThan(spineVisuals.earlierHeight);
  expect(spineVisuals.todayWidth).toBeGreaterThan(spineVisuals.earlierWidth);
  expect(spineVisuals.todayColor).not.toBe(spineVisuals.earlierColor);
  expect(spineVisuals.todayPipWidth).toBeGreaterThan(0);
  const centred = await shelf.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const spines = element.querySelectorAll('.session-shelf__spine');
    return Math.abs((spines[0].getBoundingClientRect().top + spines[spines.length - 1].getBoundingClientRect().bottom) / 2
      - (bounds.top + bounds.bottom) / 2);
  });
  expect(centred).toBeLessThanOrEqual(1);
  const cards = page.getByTestId('session-shelf-card');
  await expect(cards).toHaveCount(0);
  // Reproduce the missing-colour-token regression: inactive spines disappeared.
  const brokenFill = await page.addStyleTag({ content: '.session-shelf__spine::before { background: var(--missing-shelf-token) !important; }' });
  await expect.poll(() => shelf.locator('.session-shelf__spine').last().evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await brokenFill.evaluate(element => element.remove());
  await expect.poll(() => shelf.locator('.session-shelf__spine').last().evaluate(element => getComputedStyle(element, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const first = shelf.getByRole('button', { name: 'Preview Shelf design', exact: true });
  await first.hover();
  const card = cards.filter({ hasText: 'Shelf design' });
  await expect(card).toBeVisible();
  // The sleeve clips the slide: mid-transition the card is cut off at the rail,
  // and fully revealed it sits flush against the shelf edge — a book leaving
  // its slot, not a panel floating over the workspace.
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const geometry = await card.evaluate(element => {
    const sleeve = element.closest('.session-shelf__sleeve')!;
    const shelfBounds = element.closest('.session-shelf')!.getBoundingClientRect();
    return {
      sleeveOverflow: getComputedStyle(sleeve).overflow,
      sleeveLeft: sleeve.getBoundingClientRect().left,
      shelfRight: shelfBounds.right,
      cardLeft: element.getBoundingClientRect().left
    };
  });
  expect(geometry.sleeveOverflow).toBe('hidden');
  expect(Math.abs(geometry.sleeveLeft - geometry.shelfRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.cardLeft - geometry.shelfRight)).toBeLessThanOrEqual(1);
  await expect(card).toHaveCSS('opacity', '1');
  await card.hover();
  await expect(card).toBeVisible();
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-hover.png') });
  await page.getByTestId('titlebar-settings').hover();
  await expect(card).toBeHidden();
  await first.focus();
  await expect(card).toBeVisible();
  await first.press('Escape');
  await expect(card).toBeHidden();
  await shelf.getByRole('button', { name: 'Preview Yesterday audit', exact: true }).hover();
  await expect(card).toBeHidden();
  const earlierCard = cards.filter({ hasText: 'Yesterday audit' });
  await expect(earlierCard).toBeVisible();
  await earlierCard.getByRole('button', { name: 'Open session', exact: false }).click();
  await expect(page.getByTestId('session-chat-thread')).toBeVisible();
  await expect(shelf).toBeVisible();
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(shelf).toHaveCount(0);
  await expect(page.getByTestId('easymode-sidebar')).toBeVisible();
});

test('the shelf card sends a quick reply into the session', async () => {
  test.slow();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-reply-'));
  seedSessions(userDataDir, true);
  mock = await startMockGatewayServer({ mode: 'complete', models: [{ id: 'mock/model' }] });
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, {
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    FROSTY_VERCEL_API_KEY: undefined,
    AI_GATEWAY_URL: undefined,
    VERCEL_AI_GATEWAY_URL: undefined,
    FROSTY_VERCEL_URL: undefined
  }, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async ({ baseUrl }) => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl } } } });
    await window.praxis.ai.setProviderApiKey('openai', 'e2e-shelf-reply-key');
  }, { baseUrl: mock.baseUrl });
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  const shelf = page.getByTestId('session-shelf');
  await expect(shelf).toBeVisible();
  const card = page.getByTestId('session-shelf-card').filter({ hasText: 'Shelf design' });
  await shelf.getByRole('button', { name: 'Preview Shelf design', exact: true }).hover();
  await expect(card).toBeVisible();
  // The latest exchange shows as the card's quote block, with its status chip.
  await expect(card.getByText('The card slides out over 240ms')).toBeVisible();
  await expect(card.getByTestId('session-shelf-status')).toContainText('Completed');
  const input = card.getByTestId('session-shelf-reply-input');
  await expect(card.getByRole('button', { name: 'Send quick reply' })).toBeDisabled();
  await input.fill('Looks right — ship the shelf.');
  await card.getByRole('button', { name: 'Send quick reply' }).click();
  await expect(card.getByText('Reply sent')).toBeVisible();
  await expect(input).toHaveValue('');
  // The reply really reached the session transcript, not just the card.
  await expect.poll(async () => {
    const session = await page.evaluate(() => window.praxis.ai.getSession('SESSION-shelf0'));
    return session?.events.some(event => event.type === 'user_input_completed' && (event.detail ?? event.summary).includes('ship the shelf'));
  }, { timeout: 15000 }).toBe(true);
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-reply.png') });
});

test('the shelf closes reliably on pointer leave and outside clicks without interrupting replies', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-dismiss-'));
  seedSessions(userDataDir, true);
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  const shelf = page.getByTestId('session-shelf');
  const spine = shelf.getByRole('button', { name: 'Preview Shelf design', exact: true });
  const card = page.getByTestId('session-shelf-card');
  const outside = await page.evaluate(() => ({ x: innerWidth - 30, y: 180 }));

  // Proven against the old code: moving directly from the spine left the card visible.
  await spine.hover();
  await expect(card).toBeVisible();
  await page.mouse.move(outside.x, outside.y);
  await expect(card).toBeHidden();

  // Model a canvas/control that consumes the press and doesn't move focus.
  // Click-away must still dismiss through the document capture listener.
  await page.evaluate(point => {
    const target = document.createElement('div');
    target.dataset.testid = 'shelf-outside-press';
    Object.assign(target.style, { position: 'fixed', left: `${point.x - 10}px`, top: `${point.y - 10}px`, width: '20px', height: '20px', zIndex: '9999' });
    target.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    document.body.append(target);
  }, outside);
  for (let attempt = 0; attempt < 3; attempt++) {
    await spine.click();
    const reply = page.getByTestId('session-shelf-reply-input');
    await reply.click();
    await reply.fill(`Draft reply ${attempt}`);
    // Give the old spine blur timer time to fire; editing inside the card must stay open.
    await page.waitForTimeout(300);
    await expect(card).toBeVisible();
    await page.mouse.click(outside.x, outside.y);
    await expect(card).toBeHidden();
    await expect(spine).toHaveAttribute('aria-expanded', 'false');
    expect(await shelf.locator('.session-shelf__sleeve').evaluate(node => (node as HTMLElement).inert)).toBe(true);
  }

  await page.getByTestId('shelf-outside-press').evaluate(node => node.remove());
  // The sleeve covers the full height, but its empty space is outside the book.
  // Even with the old hit-testing fill restored, blank sleeve presses dismiss.
  for (const edge of ['above', 'below'] as const) {
    await spine.click();
    await page.getByTestId('session-shelf-reply-input').click();
    await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const bounds = (await card.boundingBox())!;
    const oldHitArea = await page.addStyleTag({ content: '.session-shelf__sleeve.is-open { pointer-events: auto; }' });
    await page.mouse.click(bounds.x + bounds.width / 2, edge === 'above' ? bounds.y - 15 : bounds.y + bounds.height + 15);
    await expect(card).toBeHidden();
    await oldHitArea.evaluate(element => element.remove());
  }
  await spine.click();
  await page.getByTestId('session-shelf-reply-input').click();
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  const bounds = (await card.boundingBox())!;
  // Native hit testing now reaches the workspace beneath the transparent sleeve.
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('.session-shelf') === null,
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height + 15 })).toBe(true);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height + 15);
  await expect(card).toBeHidden();
  await spine.focus();
  await expect(card).toBeVisible();
  await page.getByTestId('session-shelf-reply-input').focus();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(spine).toBeFocused();
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-dismissed.png') });
});


test('only the revealed spine glows when moving across all five sessions', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-switch-'));
  seedSessions(userDataDir, false);
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  const shelf = page.getByTestId('session-shelf');
  const spines = shelf.getByTestId('session-shelf-spine');
  // Keep keyboard focus on the first spine while the pointer previews others.
  // The old :focus-visible fill left this spine glowing alongside the new one.
  await page.keyboard.press('Tab');
  await spines.first().focus();
  await spines.nth(1).hover();
  await expect(spines.nth(1)).toHaveAttribute('aria-expanded', 'true');
  const oldFocus = await page.addStyleTag({ content: '.session-shelf__spine:focus-visible::before { box-shadow: 0 0 8px var(--accent); }' });
  await expect.poll(() => spines.evaluateAll(elements => elements.filter(element => getComputedStyle(element, '::before').boxShadow !== 'none').length)).toBe(2);
  await oldFocus.evaluate(element => element.remove());
  for (const index of [1, 2, 3, 4, 0, 3]) {
    await spines.nth(index).hover();
    await expect(shelf.locator('[aria-expanded="true"]')).toHaveCount(1);
    await expect(spines.nth(index)).toHaveAttribute('aria-expanded', 'true');
    const title = (await spines.nth(index).getAttribute('aria-label'))!.replace('Preview ', '');
    await expect(page.getByTestId('session-shelf-card').getByRole('heading')).toHaveText(title);
    await expect(page.getByTestId('session-shelf-card')).toHaveCount(1);
    await expect.poll(() => spines.evaluateAll(elements => elements.filter(element => getComputedStyle(element, '::before').boxShadow !== 'none').length)).toBe(1);
  }
  await page.getByTestId('session-shelf-card').getByRole('button', { name: /Open session/ }).click();
  await expect(page.getByTestId('session-chat-thread')).toBeVisible();
  await spines.nth(1).hover();
  await expect(shelf.locator('[aria-current]')).toHaveCount(1);
  await expect.poll(() => spines.evaluateAll(elements => elements.filter(element => getComputedStyle(element, '::before').boxShadow !== 'none').length)).toBe(1);
  await page.getByTestId('session-shelf-card').hover();
  await expect(spines.nth(1)).toHaveAttribute('aria-expanded', 'true');
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-single-highlight.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-shelf-card')).toBeHidden();
  await expect(shelf.locator('[aria-expanded="true"]')).toHaveCount(0);
  await expect.poll(() => spines.evaluateAll(elements => elements.filter(element => getComputedStyle(element, '::before').boxShadow !== 'none').length)).toBe(0);
});

test('shelf books follow spines, retain drafts, delay hover and distinguish selection', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-shelf-books-'));
  seedSessions(userDataDir, false);
  const file = path.join(userDataDir, 'ai-sessions.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  const shelf = page.getByTestId('session-shelf');
  const spines = shelf.getByTestId('session-shelf-spine');
  const card = page.getByTestId('session-shelf-card');
  await app.electronApp.evaluate(({ BrowserWindow }, record) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ai:sessionChanged', { ...record, state: 'awaiting_input' });
  }, data['praxis.agentSessions']['SESSION-earlier0']);
  await expect(shelf.getByTestId('session-shelf-attention')).toHaveCount(1);
  await expect(spines.nth(2)).toHaveAttribute('aria-description', 'Awaiting input');
  // A short pass over a spine must not open a preview later.
  const first = (await spines.first().boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await expect(spines.first()).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(600, 180);
  await page.waitForTimeout(180);
  await expect(card).toHaveCount(0);
  for (const index of [0, 4]) {
    await spines.nth(index).hover();
    await expect(spines.nth(index)).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    const a = (await spines.nth(index).boundingBox())!;
    const b = (await card.boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
  }
  const input = page.getByTestId('session-shelf-reply-input');
  await input.fill('Keep my draft for this session');
  await spines.first().hover(); await expect(card.getByRole('heading')).toHaveText('Shelf design');
  await input.fill('A separate draft');
  await spines.nth(4).hover(); await expect(input).toHaveValue('Keep my draft for this session');
  await page.keyboard.press('Escape');
  await page.mouse.move(600, 180);
  await spines.nth(4).hover(); await expect(input).toHaveValue('Keep my draft for this session');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(shelf).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await spines.nth(4).hover(); await expect(input).toHaveValue('Keep my draft for this session');
  await card.getByRole('button', { name: /Open session/ }).click();
  await expect(page.getByTestId('session-chat-thread')).toBeVisible();
  await spines.first().hover(); await expect(input).toHaveValue('A separate draft');
  await expect.poll(() => shelf.evaluate(element => {
    const selected = element.querySelector('[aria-current]')!;
    const other = element.querySelector('[aria-expanded="true"]')!;
    return getComputedStyle(selected, '::before').backgroundColor !== getComputedStyle(other, '::before').backgroundColor;
  })).toBe(true);
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-books.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(card).toHaveCSS('transition-duration', '0.001s');
  await page.keyboard.press('Escape'); await expect(card).toBeHidden();
  await page.mouse.move(600, 180);
  await spines.nth(4).hover(); await expect(input).toHaveValue('Keep my draft for this session');
  await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1100, 480); });
  await expect.poll(async () => {
    const bounds = (await card.boundingBox())!;
    return bounds.y >= 40 && bounds.y + bounds.height <= 480;
  }).toBe(true);
  await page.screenshot({ path: path.join(artifacts, 'session-shelf-books-short-window.png') });
});
