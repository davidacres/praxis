import { openSession } from './sessionNavigation';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Session team: a chip beside the send button adds Virtual Team members to an
 * existing session. Adding starts nothing; a lone reviewing member offers a
 * review; an @mention of an added member gets a separate, inline answer.
 */
let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
  if (mock) { await mock.close(); mock = undefined; }
});

test('a session can add several team members; a lone reviewer offers a review', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Summarise the repo.' } });
  });
  await openSession(win);
  await win.locator('[data-testid="session-follow-up-input"]').waitFor();

  const chip = win.getByTestId('session-team-chip');
  await expect(chip).toBeVisible();
  await expect(win.getByTestId('session-team-count')).toHaveCount(0);

  // Single reviewing member → offered a review; declining adds QA and nothing else.
  await chip.click();
  await win.getByTestId('session-team-member-qa').click();
  await expect(win.getByRole('button', { name: 'Request review' })).toBeVisible();
  await expect(win.getByTestId('session-team-menu')).toHaveCount(0);
  await win.getByRole('button', { name: 'Not now' }).click();
  await expect(win.getByTestId('session-team-replies')).toHaveCount(0);
  await expect(win.getByTestId('session-team-count')).toHaveText('1');

  // The dialog dismissed the menu; reopen it. Multi-select keeps it open between picks.
  await chip.click();
  await expect(win.getByTestId('session-team-menu')).toBeVisible();
  await win.getByTestId('session-team-member-security').click();
  await expect(win.getByTestId('session-team-menu')).toBeVisible();
  await expect(win.getByTestId('session-team-count')).toHaveText('2');
  await expect(win.getByRole('button', { name: 'Request review' })).toHaveCount(0);
  await win.screenshot({ path: 'test-results/session-team-menu.png' });
  await win.keyboard.press('Escape');

  // An explicit @mention gets an inline answer from that member.
  await win.locator('[data-testid="session-follow-up-input"]').fill('@qa what would you test?');
  await win.getByTestId('session-follow-up-send').click();
  await expect(win.getByTestId('assistant-message-qa')).toBeVisible({ timeout: 20_000 });
  // The reply is an ordinary turn inside the transcript, and the composer is still on screen.
  await expect(win.getByTestId('session-chat-thread').getByTestId('assistant-message-qa')).toBeVisible();
  const box = await win.locator('[data-testid="session-follow-up-input"]').boundingBox();
  const innerHeight = await win.evaluate(() => window.innerHeight);
  expect(box && box.y >= 0 && box.y + box.height <= innerHeight).toBe(true);
  await win.screenshot({ path: 'test-results/session-team-reply.png' });
});
