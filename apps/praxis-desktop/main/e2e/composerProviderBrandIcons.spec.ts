import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockAnthropicServer, type MockAnthropicServer } from './mockAnthropicServer';

/**
 * Every composer's AI-provider list and picker chip shows the provider's actual
 * brand artwork — the same `ui/ProviderBrandLogo` marks the AI usage cards use —
 * rather than the abstract `provider-*`/globe/terminal glyphs.
 *
 * Because the logo always sits beside the provider's own name in a composer, it
 * is rendered decorative (`aria-hidden`) so a screen reader hears "Anthropic"
 * once, not twice. Surfaces where the logo *is* the only label — Settings'
 * provider cards — keep it announced, which is asserted here too so the
 * distinction cannot silently regress in either direction.
 */

let app: TestApp | undefined;
let anthropic: MockAnthropicServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (anthropic) await anthropic.close();
  app = undefined;
  anthropic = undefined;
});

async function launchWithAnthropic(): Promise<TestApp['window']> {
  anthropic = await startMockAnthropicServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key' });
  const win = app.window;
  await win.evaluate(async ({ baseUrl }) => {
    await window.praxis.settings.set({ ai: { providers: { anthropic: { baseUrl } } } });
    await window.praxis.ai.setProviderApiKey('anthropic', 'e2e-key');
  }, { baseUrl: anthropic.baseUrl });
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');
  return win;
}

test('the new-session composer lists providers with their brand logo, not a glyph', async () => {
  const win = await launchWithAnthropic();
  await win.locator('[data-testid="new-session-provider-chip"]').click();

  const option = win.locator('[data-testid="new-session-provider-option-anthropic"]');
  await option.waitFor();
  const logo = option.locator('svg.provider-brand-logo');
  await expect(logo).toHaveCount(1);
  // A codicon glyph would carry `.ui-icon` instead of the brand class.
  await expect(option.locator('svg.ui-icon')).toHaveCount(0);
  // Decorative: the row's own text already names the provider.
  await expect(logo).toHaveAttribute('aria-hidden', 'true');
  await expect(logo).toHaveAttribute('role', 'presentation');
  await expect(option).toContainText('Anthropic');
});

test('the composer provider chip keeps the brand logo after a choice', async () => {
  const win = await launchWithAnthropic();
  await win.locator('[data-testid="new-session-provider-chip"]').click();
  await win.locator('[data-testid="new-session-provider-option-anthropic"]').click();

  const chip = win.locator('[data-testid="new-session-provider-chip"]');
  await expect(chip.locator('svg.provider-brand-logo')).toHaveCount(1);
  await expect(chip.locator('svg.provider-brand-logo')).toHaveAttribute('aria-hidden', 'true');
  await expect(chip).toContainText('Anthropic');
});

test("Settings' provider card still announces its logo, where the mark is the label", async () => {
  const win = await launchWithAnthropic();
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();

  const logo = win.locator('[data-testid="ai-provider-row-anthropic"] svg.provider-brand-logo');
  await expect(logo).toHaveAttribute('role', 'img');
  // The mark's own brand name; this artwork labels the Anthropic mark "Claude".
  await expect(logo).toHaveAttribute('aria-label', /Claude/);
});
