import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// The Cmd+Shift+F results list: every row must be the same width (the list's) and the same
// height whatever its content — short or long names, long signatures, no location, external
// metadata. Rows used to shrink to their own text, so no two lined up. Stubbed results keep
// the geometry deterministic; codeSearchModes.spec.ts drives the real service.
let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

const symbol = (id: string, qualifiedName: string, signature: string, kind: string, declarations: string[] = [], external = false) =>
  ({ symbolId: id, qualifiedName, signature, kind, resolution: 'resolved', declarations, external });

async function openWithStub(): Promise<Page> {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }, fixtures) => {
    const searches: Array<{ mode: string; query: string }> = [];
    (globalThis as Record<string, unknown>).codeSearchRequests = searches;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') return { data: [{ id: 'pci:repo:layout', root: '/test/layout', state: 'ready', generation: 1 }] };
      if (request.action === 'query' && request.tool === 'search_code') {
        const args = request.arguments as { mode: string; query: string };
        searches.push({ mode: args.mode, query: args.query });
        return {
          data: {
            matches: fixtures.matches.map(match => ({ ...match, reasons: args.mode === 'vector' ? ['vector'] : args.mode === 'lexical' ? ['lexical'] : match.reasons })),
            // Semantic coverage still building: 3 of 12 symbols have vectors.
            eligibleSymbolCount: 12, vectorCoveredSymbolCount: args.mode === 'lexical' ? 0 : 3
          },
          evidence: fixtures.evidence,
          warnings: args.mode === 'hybrid' ? [{ code: 'MODEL_UNAVAILABLE', message: 'Local embedding search is unavailable; lexical results returned.' }] : []
        };
      }
      if (request.action === 'query') return { data: { fragments: [], items: [] }, evidence: [] };
      return { data: {} };
    });
  }, {
    matches: [
      { symbol: symbol('pci:sym:a', 'App.A', 'class A', 'type', ['pci:ev:a']), reasons: ['lexical', 'exact'] },
      { symbol: symbol('pci:sym:long', 'App.Billing.Invoices.Calculation.InvoiceTotalsCalculatorWithRegionalTaxRulesAndRounding', 'public decimal InvoiceTotalsCalculatorWithRegionalTaxRulesAndRounding.CalculateGrandTotalIncludingAllApplicableRegionalTaxes(Invoice invoice, Region region, RoundingMode rounding)', 'method', ['pci:ev:long']), reasons: ['lexical', 'vector'] },
      { symbol: symbol('pci:sym:noloc', 'App.Generated.Unlocated', 'void Unlocated()', 'method'), reasons: ['vector'] },
      { symbol: symbol('pci:sym:ext', 'System.String.Concat', 'string string.Concat(string, string)', 'method', [], true), reasons: ['lexical'] },
      { symbol: symbol('pci:sym:short', 'App.Run', '', 'function', ['pci:ev:short']), reasons: ['vector'] }
    ],
    evidence: [
      { id: 'pci:ev:a', path: 'src/A.cs', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } },
      { id: 'pci:ev:long', path: 'src/Billing/Invoices/Calculation/InvoiceTotalsCalculatorWithRegionalTaxRulesAndRounding.cs', range: { start: { line: 120, character: 4 }, end: { line: 180, character: 5 } } },
      { id: 'pci:ev:short', path: 'Run.ts', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 20 } } }
    ]
  });
  const win = app.window;
  await win.keyboard.press('ControlOrMeta+Shift+F');
  await expect(win.getByTestId('code-search-dialog')).toBeVisible();
  return win;
}

const searchCount = (win: Page) => app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).codeSearchRequests as unknown[]).length);

test('every result row is the full list width and the same height', async ({}, testInfo) => {
  const win = await openWithStub();
  const dialog = win.getByTestId('code-search-dialog');
  await dialog.getByTestId('code-search-input').fill('invoice');
  await dialog.getByTestId('code-search-submit-btn').click();
  const rows = dialog.locator('[data-testid^="code-search-item-"]');
  await expect(rows).toHaveCount(5);
  const list = await dialog.getByTestId('code-search-results-list').evaluate(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, width: element.clientWidth };
  });
  const boxes = await rows.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, width: box.width, height: box.height, overflows: element.scrollWidth > element.clientWidth + 1 };
  }));
  for (const box of boxes) {
    expect(box.left).toBeCloseTo(list.left, 0);
    expect(box.width).toBeCloseTo(list.width, 0);
    expect(box.height).toBeCloseTo(boxes[0].height, 0);
    expect(box.overflows).toBe(false);
  }
  // Each row says why it matched.
  await expect(dialog.getByTestId('code-search-item-pci:sym:a')).toContainText('Exact');
  await expect(dialog.getByTestId('code-search-item-pci:sym:long')).toContainText('Keyword · Semantic');
  await dialog.screenshot({ path: testInfo.outputPath('code-search-rows.png') });
});

test('changing the mode searches again and the dialog reports fallback and coverage', async () => {
  const win = await openWithStub();
  const dialog = win.getByTestId('code-search-dialog');
  await dialog.getByTestId('code-search-input').fill('invoice');
  await dialog.getByTestId('code-search-submit-btn').click();
  await expect(dialog.locator('[data-testid^="code-search-item-"]')).toHaveCount(5);
  // Hybrid without a model falls back to keywords: say so instead of looking like hybrid.
  await expect(dialog.getByTestId('code-search-notice')).toContainText('lexical results returned');
  // With no model nothing is building, so no coverage line contradicts the fallback.
  await expect(dialog.getByTestId('code-search-notice')).not.toContainText('still building');
  const before = await searchCount(win);

  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'vector');
  await expect.poll(() => searchCount(win)).toBe(before + 1);
  const last = await app!.electronApp.evaluate(() => ((globalThis as Record<string, unknown>).codeSearchRequests as Array<{ mode: string }>).at(-1));
  expect(last?.mode).toBe('vector');
  await expect(dialog.getByTestId('code-search-item-pci:sym:a')).toContainText('Semantic');
  await expect(dialog.getByTestId('code-search-notice')).toContainText('3 of 12');

  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'lexical');
  await expect.poll(() => searchCount(win)).toBe(before + 2);
  await expect(dialog.getByTestId('code-search-notice')).toHaveCount(0);
});

// A first model build: the service refuses vector search until every symbol has a vector
// (it never searches a partial profile), so the dialog must say how far the build has got,
// not "install a model", and search again on its own once the model is active.
test('while the model is still building, semantic and hybrid show progress and search again when it is active', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    const state = { model: 'building', current: 4000, searches: [] as string[] };
    (globalThis as Record<string, unknown>).modelState = state;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') return { data: [{ id: 'pci:repo:build', root: '/test/build', state: 'ready', generation: 1 }] };
      if (request.action !== 'query') return { data: {} };
      if (request.tool === 'get_index_status')
        return { data: { models: [{ fingerprint: 'sha256:model', state: state.model, coverage: { eligible: 20865, current: state.current } }] }, evidence: [] };
      if (request.tool !== 'search_code') return { data: { fragments: [], items: [] }, evidence: [] };
      const mode = (request.arguments as { mode: string }).mode;
      state.searches.push(mode);
      const match = { symbol: { symbolId: 'pci:sym:tok', qualifiedName: 'App.TokenParser', signature: 'class TokenParser', kind: 'type', declarations: [] }, reasons: [mode === 'vector' ? 'vector' : 'lexical'] };
      if (state.model !== 'active') {
        if (mode === 'vector') return { error: { code: 'MODEL_UNAVAILABLE', message: 'Install and activate a local embedding model before vector search.' } };
        return { data: { matches: mode === 'hybrid' ? [match] : [], eligibleSymbolCount: 20865, vectorCoveredSymbolCount: 0 }, evidence: [],
          warnings: mode === 'hybrid' ? [{ code: 'MODEL_UNAVAILABLE', message: 'Local embedding search is unavailable; lexical results returned.' }] : [] };
      }
      return { data: { matches: [match], eligibleSymbolCount: 20865, vectorCoveredSymbolCount: 20865 }, evidence: [], warnings: [] };
    });
  });
  const win = app.window;
  await win.keyboard.press('ControlOrMeta+Shift+F');
  const dialog = win.getByTestId('code-search-dialog');
  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'vector');
  await dialog.getByTestId('code-search-input').fill('decode the access credential');
  await dialog.getByTestId('code-search-submit-btn').click();

  const notice = dialog.getByTestId('code-search-notice');
  await expect(notice).toContainText('4,000 of 20,865 symbols embedded');
  await expect(notice).toContainText('Semantic search starts when it finishes');
  await expect(dialog.locator('.error-banner')).toHaveCount(0);
  await expect(dialog).not.toContainText('No symbols or code matches found.');

  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'hybrid');
  await expect(notice).toContainText('Keyword results are shown until it finishes');
  await expect(dialog.getByTestId('code-search-item-pci:sym:tok')).toBeVisible();

  // Progress moves on while the dialog is open.
  await app.electronApp.evaluate(() => { ((globalThis as Record<string, unknown>).modelState as { current: number }).current = 12000; });
  await expect(notice).toContainText('12,000 of 20,865', { timeout: 10_000 });

  // The build finishes: the dialog searches again by itself and the notice goes.
  await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'vector');
  await expect(notice).toContainText('Semantic search starts when it finishes');
  await app.electronApp.evaluate(() => { ((globalThis as Record<string, unknown>).modelState as { model: string }).model = 'active'; });
  await expect(dialog.getByTestId('code-search-item-pci:sym:tok')).toContainText('Semantic', { timeout: 10_000 });
  await expect(notice).toHaveCount(0);
});
