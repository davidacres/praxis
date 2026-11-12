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
  source?: string;
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
    source: event.source ?? 'session',
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

async function openAiUsage(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.getByTestId('settings-nav-ai-usage').click();
}

test('shows exact period totals, cost and ranked models from a seeded ledger', async () => {
  // The Overview tiles were retired with OverviewPage (f977690f); the same ledger now drives the
  // Settings -> AI Usage page: the all-time tokens card, the ranked model list and the feature list.
  app = await launchWithLedger(POPULATED);
  const page = app.window;
  await openAiUsage(page);

  const allTime = page.locator('.ai-usage-stat-card', { hasText: 'Tokens recorded by Praxis' });
  await expect(allTime.locator('strong')).toHaveText('10k');
  await expect(allTime).toContainText('Since');

  // Top models, default period (this week): gpt-x outranks opus, and its missing cost is labelled, never $0.00.
  const rows = page.getByTestId('ai-usage-model-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('gpt-x');
  await expect(rows.nth(0)).toContainText('3.0k');
  await expect(rows.nth(0)).toContainText('75%');
  await expect(rows.nth(0)).toContainText('Not reported');
  await expect(rows.nth(0)).not.toContainText('$0.00');
  await expect(rows.nth(1)).toContainText('opus');
  await expect(rows.nth(1)).toContainText('25%');
  await expect(rows.nth(1)).toContainText('$0.50');

  // This week's cost by feature: only the session event reports one ($0.50), the week's 4.0k tokens in total.
  const sourceRows = page.getByTestId('ai-usage-source-row');
  await expect(sourceRows).toHaveCount(1);
  await expect(sourceRows.nth(0)).toContainText('Sessions');
  await expect(sourceRows.nth(0)).toContainText('4.0k');
  await expect(sourceRows.nth(0)).toContainText('$0.50');

  // All time re-ranks: opus 7.0k (67%, $1.75) ahead of gpt-x 3.4k (33%).
  await page.getByTestId('ai-usage-models-period-allTime').click();
  await expect(rows.nth(0)).toContainText('opus');
  await expect(rows.nth(0)).toContainText('7.0k');
  await expect(rows.nth(0)).toContainText('67%');
  await expect(rows.nth(0)).toContainText('$1.75');
  await expect(rows.nth(1)).toContainText('gpt-x');
  await expect(rows.nth(1)).toContainText('3.4k');
  await expect(rows.nth(1)).toContainText('33%');
  await expect(rows.nth(1)).toContainText('Not reported');

  await page.getByTestId('ai-usage-sources-period-allTime').click();
  await expect(sourceRows.nth(0)).toContainText('Sessions');
  await expect(sourceRows.nth(0)).toContainText('10k');
  await expect(sourceRows.nth(0)).toContainText('$1.75');

  await page.screenshot({ path: path.join(__dirname, '..', 'output', 'playwright', 'overview-ai-usage.png'), fullPage: true });
});

test('labels cost as not reported when the ledger carries none', async () => {
  app = await launchWithLedger([POPULATED[1], POPULATED[2]]);
  const page = app.window;
  await openAiUsage(page);
  await expect(page.locator('.ai-usage-stat-card', { hasText: 'Tokens recorded by Praxis' }).locator('strong')).toHaveText('3.4k');
  await page.getByTestId('ai-usage-models-period-allTime').click();
  const rows = page.getByTestId('ai-usage-model-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('gpt-x');
  await expect(rows.nth(0)).toContainText('3.4k');
  await expect(rows.nth(0)).toContainText('Not reported');
  await expect(rows.nth(0)).not.toContainText('$0.00');
});

test('shows an empty state when the ledger is empty', async () => {
  app = await launchWithLedger([]);
  const page = app.window;
  await openAiUsage(page);
  await expect(page.getByTestId('ai-usage-empty')).toBeVisible();
  await expect(page.getByTestId('ai-usage-model-row')).toHaveCount(0);
});

test('AI usage page shows costs for prompt analysis and calibration', async () => {
  const events: SeedEvent[] = [
    { secondsAgo: 0, todayOffsetSeconds: 1, model: 'opus', provider: 'claude-code-cli', source: 'session', totalTokens: 1000, cost: { amount: 0.5, currency: 'USD' } },
    { secondsAgo: 0, todayOffsetSeconds: 2, model: 'claude-3-5-haiku', provider: 'anthropic', source: 'prompt-analysis', totalTokens: 500, cost: { amount: 0.02, currency: 'USD' } },
    { secondsAgo: 0, todayOffsetSeconds: 3, model: 'minimax-m3.1-flash-preview', provider: 'minimax', source: 'prompt-calibration', totalTokens: 2500, cost: { amount: 0.1, currency: 'USD' } }
  ];
  app = await launchWithLedger(events);
  const page = app.window;

  // Navigate to Settings -> AI Usage
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.getByTestId('settings-nav-ai-usage').click();

  // The Top Models list includes prompt analysis and calibration models with costs
  const modelsSection = page.getByTestId('ai-usage-models');
  await expect(modelsSection).toBeVisible();
  await expect(modelsSection).toContainText('minimax-m3.1-flash-preview');
  await expect(modelsSection).toContainText('$0.10');
  await expect(modelsSection).toContainText('claude-3-5-haiku');
  await expect(modelsSection).toContainText('$0.02');

  // Activity by feature breakdown shows prompt analysis and calibration costs
  const sourcesSection = page.getByTestId('ai-usage-sources');
  await expect(sourcesSection).toBeVisible();
  await expect(sourcesSection).toContainText('Prompt analysis');
  await expect(sourcesSection).toContainText('$0.02');
  await expect(sourcesSection).toContainText('Prompt calibration');
  await expect(sourcesSection).toContainText('$0.10');
  await expect(sourcesSection).toContainText('Sessions');
  await expect(sourcesSection).toContainText('$0.50');

  // Capture visual verification screenshot to .praxis/session-artifacts
  await sourcesSection.scrollIntoViewIfNeeded();
  const repoArtifactDir = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
  const desktopArtifactDir = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(repoArtifactDir, { recursive: true });
  fs.mkdirSync(desktopArtifactDir, { recursive: true });
  const shot = await page.screenshot();
  fs.writeFileSync(path.join(repoArtifactDir, 'ai-usage-prompt-analysis-costs.png'), shot);
  fs.writeFileSync(path.join(desktopArtifactDir, 'ai-usage-prompt-analysis-costs.png'), shot);
});
