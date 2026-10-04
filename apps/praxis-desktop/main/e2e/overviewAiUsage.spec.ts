import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// Currency is formatted in the machine's locale ("$0.50" or "US$0.50"), so cost matches on the suffix.
// FX-BF-049: the Overview AI usage panel reads the durable ledger
// (`ai-usage-log.json`). The ledger is seeded into the throwaway profile only.

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

interface SeedEvent {
  secondsAgo: number;
  /** Anchors the event to UTC midnight today instead of "now", so it is always inside today. */
  todayOffsetSeconds?: number;
  model: string;
  provider: string;
  totalTokens: number;
  cost?: { amount: number; currency: string };
}

const DAY_MS = 86_400_000;

function launchWithLedger(events: SeedEvent[]): Promise<TestApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-e2e-'));
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ledger = events.map((event, index) => ({
    id: `seed-${index}`,
    timestamp: new Date(event.todayOffsetSeconds !== undefined ? todayStart + event.todayOffsetSeconds * 1000 : Date.now() - event.secondsAgo * 1000).toISOString(),
    source: 'session',
    provider: event.provider,
    model: event.model,
    totalTokens: event.totalTokens,
    ...(event.cost ? { cost: event.cost } : {})
  }));
  fs.writeFileSync(path.join(userDataDir, 'ai-usage-log.json'), JSON.stringify({ 'praxis.aiUsageLog.v1': ledger }));
  return launchTestApp({}, { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') });
}

// Hand-checked ledger:
//   today   opus   1,000 tokens  $0.50   (claude-code-cli — reports cost)
//   today   gpt-x  3,000 tokens  no cost (openai — does not)
//   40d ago gpt-x    400 tokens  no cost   (outside this week and this month on any date)
//   400d ago opus  6,000 tokens  $1.25   (likewise)
// today = week = month = 4.0k tokens / $0.50; all time = 10.4k → "10k" tokens / $1.75.
const POPULATED: SeedEvent[] = [
  { secondsAgo: 0, todayOffsetSeconds: 1, model: 'opus', provider: 'claude-code-cli', totalTokens: 1000, cost: { amount: 0.5, currency: 'USD' } },
  { secondsAgo: 0, todayOffsetSeconds: 2, model: 'gpt-x', provider: 'openai', totalTokens: 3000 },
  { secondsAgo: 40 * DAY_MS / 1000, model: 'gpt-x', provider: 'openai', totalTokens: 400 },
  { secondsAgo: 400 * DAY_MS / 1000, model: 'opus', provider: 'claude-code-cli', totalTokens: 6000, cost: { amount: 1.25, currency: 'USD' } }
];

test('shows exact period totals, peaks, cost and ranked models from a seeded ledger', async () => {
  app = await launchWithLedger(POPULATED);
  const page = app.window;
  await page.getByTestId('nav-overview').click();
  const panel = page.getByTestId('overview-usage-panel');
  await expect(panel).toBeVisible();

  for (const id of ['today', 'week', 'month']) {
    await expect(page.getByTestId(`overview-usage-tokens-${id}`)).toHaveText('4.0k tokens');
    await expect(page.getByTestId(`overview-usage-cost-${id}`)).toHaveText(/\$0\.50$/);
  }
  await expect(page.getByTestId('overview-usage-tokens-all')).toHaveText('10k tokens');
  await expect(page.getByTestId('overview-usage-cost-all')).toHaveText(/\$1\.75$/);
  await expect(page.getByTestId('overview-usage-tile-all')).toContainText('All time (since');

  await expect(page.getByTestId('overview-usage-peak-today')).toContainText('peak 4.0k');
  await expect(page.getByTestId('overview-usage-peak-week')).toContainText('peak 4.0k');
  await expect(page.getByTestId('overview-usage-peak-all')).toContainText('peak 6.0k');

  // Top models, default period (this week): gpt-x outranks opus, and its missing cost is labelled, never $0.00.
  const rows = page.getByTestId('overview-usage-model-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('gpt-x');
  await expect(rows.nth(0)).toContainText('3.0k tokens');
  await expect(rows.nth(0)).toContainText('75%');
  await expect(rows.nth(0)).toContainText('Not reported');
  await expect(rows.nth(1)).toContainText('opus');
  await expect(rows.nth(1)).toContainText('25%');
  await expect(rows.nth(1)).toContainText('$0.50');
  await expect(rows.nth(0)).not.toContainText('$0.00');

  // All time re-ranks: opus 7.0k (67%, $1.75) ahead of gpt-x 3.4k (33%).
  await page.getByTestId('overview-usage-models-period-allTime').click();
  await expect(rows.nth(0)).toContainText('opus');
  await expect(rows.nth(0)).toContainText('7.0k tokens');
  await expect(rows.nth(0)).toContainText('67%');
  await expect(rows.nth(0)).toContainText('$1.75');
  await expect(rows.nth(1)).toContainText('gpt-x');
  await expect(rows.nth(1)).toContainText('3.4k tokens');
  await expect(rows.nth(1)).toContainText('33%');
  await expect(page.getByTestId('overview-usage-no-cost')).toHaveCount(0);

  await page.screenshot({ path: path.join(__dirname, '..', 'output', 'playwright', 'overview-ai-usage.png'), fullPage: true });

  // "View details" opens Settings → AI Usage, which shows the same model breakdown.
  await page.getByTestId('overview-usage-details').click();
  const settingsRows = page.getByTestId('ai-usage-model-row');
  await expect(settingsRows).toHaveCount(2);
  await page.getByTestId('ai-usage-models-period-allTime').click();
  await expect(settingsRows.nth(0)).toContainText('opus');
  await expect(settingsRows.nth(0)).toContainText('7.0k tokens');
  await expect(settingsRows.nth(0)).toContainText('67%');
  await expect(settingsRows.nth(0)).toContainText('$1.75');
  await expect(settingsRows.nth(1)).toContainText('Not reported');
});

test('says cost comes from ACP agents only when no cost is reported', async () => {
  app = await launchWithLedger([POPULATED[1], POPULATED[2]]);
  const page = app.window;
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('overview-usage-tokens-all')).toHaveText('3.4k tokens');
  await expect(page.getByTestId('overview-usage-cost-all')).toHaveText('Not reported');
  await expect(page.getByTestId('overview-usage-no-cost')).toContainText('ACP agents');
  await expect(page.getByTestId('overview-usage-cost-all')).not.toContainText('$0.00');
});

test('invites a first conversation when the ledger is empty', async () => {
  app = await launchWithLedger([]);
  const page = app.window;
  await page.getByTestId('nav-overview').click();
  await expect(page.getByTestId('overview-usage-empty')).toBeVisible();
  await expect(page.getByTestId('overview-usage-tile-today')).toHaveCount(0);
});
