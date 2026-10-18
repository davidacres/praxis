import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// Each mode of the Cmd+Shift+F search against the real packaged service and the real pinned
// model: Keyword finds names and nothing by meaning, Semantic finds by meaning, Hybrid does
// both, and without a model Semantic says so and Hybrid says it fell back to keywords.
const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE;
const bundle = process.env.PRAXIS_MODEL_BUNDLE;

const SOURCE = `namespace Fixture;

public class InvoiceCalculator
{
    public decimal ApplySalesTax(decimal subtotal, decimal rate) => subtotal * (1 + rate);
}

public class AuthenticationTokenParser
{
    public string ParseBearerToken(string header) => header.Substring(7);
}

public class ShipmentTracker
{
    public string LookupParcelLocation(string trackingNumber) => trackingNumber;
}

public class ImageResizer
{
    public byte[] ScaleThumbnail(byte[] pixels, int width) => pixels;
}
`;

let app: TestApp | undefined;
let temporary: string | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (temporary) {
    try { execFileSync(executable!, ['stop', '--data', path.join(temporary, 'data')]); } catch { /* none running */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  temporary = undefined;
});

async function launch(withModel: boolean): Promise<{ win: Page; repositoryId: string }> {
  // The owner's Unix socket lives in the data directory, so keep the path short.
  temporary = fs.mkdtempSync('/tmp/pci-modes-');
  const source = path.join(temporary, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Services.cs'), SOURCE);
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'gateway-fixture-key',
    PRAXIS_CODE_INTELLIGENCE_EXE: executable!,
    PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY: path.join(temporary, 'data'),
    PRAXIS_MODEL_BUNDLE: withModel ? bundle! : ''
  });
  const win = app.window;
  if (withModel) await expect.poll(() => win.evaluate(() => window.praxis.ai.getSemanticModelStatus().then(status => status.installed))).toBe(true);
  const registered = await win.evaluate(root => window.praxis.ai.codeIntelligence({ action: 'register', root }), source);
  expect(registered.error).toBeUndefined();
  const repositoryId = (registered.data as { repositoryId: string }).repositoryId;
  await win.evaluate(id => window.praxis.ai.codeIntelligence({ action: 'index', repositoryId: id }), repositoryId);
  if (withModel) {
    // Vectors build in the background; search once they are complete.
    await expect.poll(async () => {
      const status = await win.evaluate(id => window.praxis.ai.codeIntelligence({ action: 'query', tool: 'get_index_status', arguments: { repositoryId: id, responseBudgetTokens: 8000 } }), repositoryId);
      return ((status.data as { models?: Array<{ state: string }> } | undefined)?.models ?? []).map(model => model.state);
    }, { timeout: 60_000 }).toEqual(['active']);
  }
  await win.keyboard.press('ControlOrMeta+Shift+F');
  await expect(win.getByTestId('code-search-dialog')).toBeVisible();
  return { win, repositoryId };
}

async function search(dialog: Locator, mode: 'lexical' | 'vector' | 'hybrid', query: string): Promise<string[]> {
  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), mode);
  await dialog.getByTestId('code-search-input').fill(query);
  await dialog.getByTestId('code-search-submit-btn').click();
  await expect(dialog.getByText('Searching…')).toHaveCount(0);
  return dialog.locator('[data-testid^="code-search-item-"] .code-search-item-name').allTextContents();
}

const rankOf = (names: string[], name: string) => names.findIndex(entry => entry.startsWith(name));

test('keyword, semantic and hybrid each find what they should with the real model', async ({}, testInfo) => {
  test.skip(!executable || !bundle, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a host package and PRAXIS_MODEL_BUNDLE to the pinned model.');
  test.setTimeout(180_000);
  const { win } = await launch(true);
  const dialog = win.getByTestId('code-search-dialog');
  const row = (name: string) => dialog.locator('[data-testid^="code-search-item-"]').filter({ has: win.locator('.code-search-item-name', { hasText: name }) }).first();

  // Keyword: names only.
  let names = await search(dialog, 'lexical', 'ParseBearerToken');
  expect(rankOf(names, 'ParseBearerToken')).toBe(0);
  await expect(row('ParseBearerToken')).toContainText('Keyword');
  names = await search(dialog, 'lexical', 'decode the access credential');
  expect(names).toEqual([]);
  await expect(dialog).toContainText('No symbols or code matches found.');

  // Semantic: by meaning, with no shared words.
  names = await search(dialog, 'vector', 'decode the access credential');
  expect(rankOf(names, 'AuthenticationTokenParser')).toBe(0);
  await expect(row('AuthenticationTokenParser')).toContainText('Semantic');
  names = await search(dialog, 'vector', 'where is my package');
  expect(rankOf(names, 'ShipmentTracker')).toBe(0);
  await dialog.screenshot({ path: testInfo.outputPath('semantic.png') });

  // Hybrid: an exact name stays first, a description still finds its code.
  names = await search(dialog, 'hybrid', 'ParseBearerToken');
  expect(rankOf(names, 'ParseBearerToken')).toBe(0);
  await expect(row('ParseBearerToken')).toContainText('Exact');
  names = await search(dialog, 'hybrid', 'compute the amount owed with levies included');
  expect(rankOf(names, 'InvoiceCalculator')).toBe(0);
  await expect(row('InvoiceCalculator')).toContainText('Semantic');

  // A complete index with an active model has nothing to warn about, and no internal
  // containment records are offered as code.
  await expect(dialog.getByTestId('code-search-notice')).toHaveCount(0);
  expect(names.some(name => name.includes('synthetic'))).toBe(false);
});

test('without a model, only keyword search is offered and the dialog says why', async () => {
  test.skip(!executable, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a host package.');
  test.setTimeout(120_000);
  const { win } = await launch(false);
  const dialog = win.getByTestId('code-search-dialog');
  const modeChip = dialog.getByRole('button', { name: 'Search mode' }).and(win.locator('button.chip-select'));

  await expect(modeChip).toHaveAttribute('data-value', 'lexical');
  await expect(dialog.getByTestId('code-search-semantic-status')).toContainText('need the semantic model');
  await modeChip.click();
  const menu = win.locator(`[id="${await modeChip.getAttribute('aria-controls')}"]`);
  await expect(menu.locator('[role="option"][data-value="vector"]')).toBeDisabled();
  await expect(menu.locator('[role="option"][data-value="hybrid"]')).toBeDisabled();
  await modeChip.click(); // Escape would close the whole dialog
  await expect(menu).toHaveCount(0);

  const names = await search(dialog, 'lexical', 'ParseBearerToken');
  expect(rankOf(names, 'ParseBearerToken')).toBe(0);
  await expect(dialog.locator('.error-banner')).toHaveCount(0);
});
