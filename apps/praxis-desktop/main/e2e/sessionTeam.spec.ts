import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Session team: a roster picker beside the send button adds Virtual Team members to
 * an existing session. Adding starts nothing; a lone reviewing member offers to
 * draft an ask, which lands in the composer as editable text rather than running;
 * an @mention of an added member gets a separate, inline answer.
 */
let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
  if (mock) { await mock.close(); mock = undefined; }
});

test('a session can add several team members; a lone reviewer offers to draft an ask', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Summarise the repo.' } });
  });
  const session = await win.evaluate(async () => (await window.praxis.ai.listSessions())[0]);
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill(session.issueKey);
  await palette.getByRole('option').filter({ hasText: session.title || session.taskDefinition.goal }).click();
  await win.locator('[data-testid="session-follow-up-input"]').waitFor();

  const chip = win.getByTestId('session-team-chip');
  await expect(chip).toBeVisible();
  await expect(win.getByTestId('session-team-count')).toHaveCount(0);

  // The redundant Ask button is absent; the roster picker remains.
  await expect(win.getByTestId('session-team-ask')).toHaveCount(0);

  // Single reviewing member → offered to draft an ask; declining adds QA and nothing else.
  await chip.click();
  await win.getByTestId('session-team-member-qa').click();
  await expect(win.getByRole('button', { name: 'Draft the ask' })).toBeVisible();
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
  await expect(win.getByRole('button', { name: 'Draft the ask' })).toHaveCount(0);
  await win.screenshot({ path: 'test-results/session-team-menu.png' });
  await win.keyboard.press('Escape');

  const composer = win.locator('[data-testid="session-follow-up-input"]');
  await expect(win.getByTestId('session-team-ask')).toHaveCount(0);
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await win.locator('.session-follow-up-composer').filter({ has: composer }).screenshot({ path: path.join(artifacts, 'session-composer-without-ask.png') });

  // An explicit @mention gets an inline answer from that member.
  await composer.fill('@qa what would you test?');
  await win.getByTestId('session-follow-up-send').click();
  await expect(win.getByTestId('assistant-message-qa')).toBeVisible({ timeout: 20_000 });
  // The reply is an ordinary turn inside the transcript, and the composer is still on screen.
  await expect(win.getByTestId('session-chat-thread').getByTestId('assistant-message-qa')).toBeVisible();
  const box = await win.locator('[data-testid="session-follow-up-input"]').boundingBox();
  const innerHeight = await win.evaluate(() => window.innerHeight);
  expect(box && box.y >= 0 && box.y + box.height <= innerHeight).toBe(true);
  await win.screenshot({ path: 'test-results/session-team-reply.png' });
});
