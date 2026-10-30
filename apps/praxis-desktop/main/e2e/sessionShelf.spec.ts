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
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover();
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
