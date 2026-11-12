import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// The Codex and Claude Code usage cards read real plan windows from the CLIs themselves. The
// backend takes the executables from PRAXIS_CODEX_CLI / PRAXIS_CLAUDE_CLI, so fixtures stand in
// for both (`fixtures/mockCodexCli.mjs`, `fixtures/mockClaudeCli.mjs`).

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

const BUILT_IN = ['openai', 'anthropic', 'gemini', 'z-ai', 'claude-code-cli', 'codex-cli', 'copilot-cli', 'antigravity-cli', 'cursor-cli'];
const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

function launch(enabled: string[], env: Record<string, string | undefined>) {
  const providers = Object.fromEntries(BUILT_IN.map(id => [id, { enabled: enabled.includes(id) }]));
  return launchTestApp({ ai: { providers } }, undefined, env);
}

test('Codex and Claude Code cards show their real windows and cumulative tokens', async () => {
  test.slow();
  app = await launch(['codex-cli', 'claude-code-cli'], {
    PRAXIS_CODEX_CLI: fixture('mockCodexCli.mjs'),
    PRAXIS_CLAUDE_CLI: fixture('mockClaudeCli.mjs')
  });
  const page = app.window;
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.getByTestId('settings-nav-ai-usage').click();

  const codex = page.getByTestId('ai-usage-budgets-card-codex-cli');
  await expect(codex).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('ai-usage-budgets-nodata-codex-cli')).toHaveCount(0);
  await expect(codex).toContainText('41%');
  await expect(codex).toContainText('12%');

  const claude = page.getByTestId('ai-usage-budgets-card-claude-code-cli');
  await expect(page.getByTestId('ai-usage-budgets-nodata-claude-code-cli')).toHaveCount(0);
  await expect(claude).toContainText('23%');
  await expect(claude).toContainText('35%');

  // The snapshot itself, as the renderer receives it.
  const snapshots = await page.evaluate(async () => {
    const result = await window.praxis.aiUsage.providerSnapshots(['codex-cli', 'claude-code-cli']);
    return result.snapshots;
  });
  const [codexSnapshot, claudeSnapshot] = snapshots;
  expect(codexSnapshot.windows.map(w => w.period)).toEqual(['hour', 'week']);
  expect(codexSnapshot.totalTokens).toBe(987654);
  expect(codexSnapshot.credits).toEqual({ remaining: 2, currency: 'reset credits' });
  expect(claudeSnapshot.windows.map(w => w.label)).toEqual(['5-hour window', 'Weekly window']);
  expect(claudeSnapshot.windows[0].resetsAt).toBeTruthy();
});

test('provider history reports the cumulative tokens each CLI can state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-claude-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'stats-cache.json'), JSON.stringify({
    modelUsage: { 'claude-sonnet': { inputTokens: 1000, outputTokens: 234, cacheReadInputTokens: 99999 } }
  }));
  try {
    app = await launch(['codex-cli', 'claude-code-cli'], {
      PRAXIS_CODEX_CLI: fixture('mockCodexCli.mjs'),
      PRAXIS_CLAUDE_CLI: fixture('mockClaudeCli.mjs'),
      PRAXIS_NATIVE_SOURCES_HOME: home
    });
    const [claude, codex] = await app.window.evaluate(async () => [
      await window.praxis.aiUsage.providerHistory('claude-code-cli'),
      await window.praxis.aiUsage.providerHistory('codex-cli')
    ]);
    expect(claude).toMatchObject({ source: 'local-cli', totalTokens: 1234 });
    expect(codex).toMatchObject({ source: 'provider-summary', totalTokens: 987654 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a missing CLI is a stated reason, not a zero', async () => {
  app = await launch(['codex-cli'], { PRAXIS_CODEX_CLI: path.join(os.tmpdir(), 'no-such-codex-cli') });
  const snapshot = await app.window.evaluate(() => window.praxis.aiUsage.providerSnapshot('codex-cli'));
  expect(snapshot.windows).toEqual([]);
  expect(snapshot.unavailableReasonCode).toBe('cli-unavailable');
  expect(snapshot.unavailableReason).toContain('Codex CLI is unavailable');
});
