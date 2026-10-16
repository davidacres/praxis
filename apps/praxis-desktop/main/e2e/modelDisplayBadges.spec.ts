import { expect, test } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Context and price badges on the settings-side model lists.
 *
 * Two surfaces read the same catalog metadata: the provider card's "Manage models"
 * list and the Fast/Standard/Strong tier dropdowns beside it. Both must show a
 * model's context length and price, and both must stay quiet for a model the
 * catalog has no metadata for rather than printing a dangling separator.
 *
 * Two bugs motivated these assertions, neither caught by typecheck or unit tests:
 * the catalog built entries with no context length whenever a provider omitted
 * `context_length`, and the price badge was fed a `pricingLabel` lookup that only
 * formats an existing string and never reads `pricing` rates — so both rendered
 * empty. Assert on the badge text, not just that rows exist.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined
} as const;

/** A priced model, one whose context only comes from the known-context table, one known to neither. */
const MODELS = [
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_length: 200000 },
  // Deliberately sent without context_length, so its badge can only come from the
  // known-context fallback. gemini-2.5-pro has no catalog entry, so only the known-context
  // table can size it — a model whose provider omits context_length would render no badge.
  { id: 'vendor/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'vendor/unknown-model', name: 'Unknown Model' }
];

async function openProviderPage() {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'ok',
    models: MODELS
  });
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway' } },
    undefined,
    { ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl }
  );
  const win = app.window;
  await win.locator('[data-testid="titlebar-settings"]').click();
  await win.locator('[data-testid="settings-nav-ai"]').click();
  await win.locator('[data-testid="ai-provider-row-vercel-gateway"]').click();
  return win;
}

/**
 * The settings rows carry no per-model testid — the row's checkbox is what
 * addresses a specific model, so the row is located through it.
 */
async function rowFor(win: Awaited<ReturnType<typeof openProviderPage>>, modelId: string) {
  return win.locator('[data-testid="model-manager-row"]').filter({ has: win.locator(`[data-testid="model-manager-checkbox-${modelId}"]`) });
}

test('Manage models shows a context and price badge for every model the catalog prices', async () => {
  const win = await openProviderPage();
  await win.locator('[data-testid="ai-manage-models-btn"]').click();
  await win.locator('[data-testid="model-manager-list"]').waitFor({ timeout: 10000 });
  await expect(win.locator('[data-testid="model-manager-checkbox-anthropic/claude-sonnet-4-6"]')).toBeVisible();

  // Both badges, on the same row, for a model the catalog reports rates for.
  const priced = await rowFor(win, 'anthropic/claude-sonnet-4-6');
  await expect(priced.locator('[data-testid="model-badges"] .composer-model-badge.is-context')).toHaveText('200k');
  await expect(priced.locator('[data-testid="model-badges"] .composer-model-badge.is-cost')).toContainText('$');

  // Context still resolves when the provider sent no context_length, because the
  // catalog falls back to the known-context table rather than emitting an empty badge.
  const known = await rowFor(win, 'vendor/gemini-2.5-pro');
  await expect(known.locator('[data-testid="model-badges"] .composer-model-badge.is-context')).toHaveText('2.1M');

  // A model the catalog knows nothing about shows neither badge — and no orphaned
  // separator, which is what a partially-resolved badge string used to produce.
  const unknown = await rowFor(win, 'vendor/unknown-model');
  await expect(unknown.locator('[data-testid="model-badges"] .composer-model-badge')).toHaveCount(0);
  await expect(unknown.locator('[data-testid="model-badges"]')).toHaveText('');
});

test('a tier dropdown carries the same badges as Manage models, and omits them for unpriced models', async () => {
  const win = await openProviderPage();

  await win.locator('[data-testid="ai-model-tier-vercel-gateway-fast"]').click();
  const menu = win.locator('[role="listbox"]');
  await expect(menu).toBeVisible();

  /**
   * A chip option renders its trailing `meta` as a bare <small>, and renders none
   * at all when the meta string is undefined — so count before reading.
   */
  const optionMeta = async (label: string): Promise<string> => {
    const option = menu.locator('[role="option"]').filter({ hasText: label }).first();
    await expect(option).toBeVisible();
    const meta = option.locator('small');
    return (await meta.count()) ? ((await meta.textContent()) ?? '').trim() : '';
  };

  // Context and price, joined on one line, trailing the label.
  const priced = await optionMeta('Claude Sonnet 4.6');
  expect(priced).toContain('200k');
  expect(priced).toContain('$');

  // The unknown model is still a choice, just with nothing to describe it by: no
  // <small> at all, rather than a dangling separator left by a half-empty badge string.
  const unknown = await optionMeta('Unknown Model');
  expect(unknown).toBe('');

  await win.keyboard.press('Escape');
});

test('a settings row shows the model name and badges without a raw model id', async () => {
  const win = await openProviderPage();
  await win.locator('[data-testid="ai-manage-models-btn"]').click();
  await win.locator('[data-testid="model-manager-list"]').waitFor({ timeout: 10000 });
  await expect(win.locator('[data-testid="model-manager-checkbox-anthropic/claude-sonnet-4-6"]')).toBeVisible();

  // The model id was dropped from the row to make room for the badges: with both
  // present the name wrapped onto two lines and the id truncated. The checkbox
  // still carries the id, so the row no longer needs it.
  const row = await rowFor(win, 'anthropic/claude-sonnet-4-6');
  await expect(row.locator('.model-manager-row-name')).toHaveText('Claude Sonnet 4.6');
  await expect(row.locator('.model-manager-row-id')).toHaveCount(0);

  // And the row fits on one line now, which is why the id could go.
  const name = row.locator('.model-manager-row-name');
  const box = await name.boundingBox();
  const lineHeight = await name.evaluate(node => parseFloat(getComputedStyle(node).fontSize) * 1.4);
  expect(box!.height).toBeLessThan(lineHeight * 2);
});