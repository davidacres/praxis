import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.afterEach(async () => {
  await closeTestApp(app);
});

async function setupMockCodeIntelligence(app: TestApp) {
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') {
        return {
          data: [{ id: 'pci:repo:fixture', root: '/test/workspace', state: 'ready', generation: 2 }]
        };
      }
      if (request.action === 'query') {
        const tool = request.tool;
        if (tool === 'search_code') {
          return {
            data: {
              matches: [
                {
                  symbol: {
                    symbolId: 'pci:sym:auth-handler',
                    qualifiedName: 'MyApp.Auth.AuthenticationHandler',
                    signature: 'public class AuthenticationHandler',
                    kind: 'class',
                    resolution: 'resolved',
                    declarations: ['pci:ev:auth-loc']
                  },
                  score: 0.95
                },
                {
                  symbol: {
                    symbolId: 'pci:sym:validate-token',
                    qualifiedName: 'MyApp.Auth.AuthenticationHandler.ValidateTokenAsync',
                    signature: 'public async Task<bool> ValidateTokenAsync(string token)',
                    kind: 'method',
                    resolution: 'resolved',
                    declarations: ['pci:ev:val-loc']
                  },
                  score: 0.88
                }
              ]
            },
            evidence: [
              {
                id: 'pci:ev:auth-loc',
                path: 'src/Auth/AuthenticationHandler.cs',
                range: { start: { line: 23, character: 0 }, end: { line: 85, character: 1 } }
              },
              {
                id: 'pci:ev:val-loc',
                path: 'src/Auth/AuthenticationHandler.cs',
                range: { start: { line: 41, character: 4 }, end: { line: 52, character: 5 } }
              }
            ]
          };
        }
        if (tool === 'get_source') {
          return {
            data: {
              fragments: [
                {
                  text: 'public class AuthenticationHandler {\n    public async Task<bool> ValidateTokenAsync(string token) => true;\n}',
                  range: { start: { line: 23, character: 0 }, end: { line: 85, character: 1 } }
                }
              ]
            },
            evidence: [{ id: 'pci:ev:auth-loc', path: 'src/Auth/AuthenticationHandler.cs' }]
          };
        }
        if (tool === 'get_callers') {
          return {
            data: {
              items: [
                {
                  // Real IDs are opaque hashes; the far end is named by `symbol`.
                  edgeId: 'pci:edge:5b1f0c2a9d7e4f6a8b3c1d2e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a',
                  sourceSymbolId: 'pci:sym:3f9c2b7e1a0d4c8b9e6f5a2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b',
                  symbol: { symbolId: 'pci:sym:3f9c2b7e1a0d4c8b9e6f5a2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b', qualifiedName: 'MyApp.Controllers.AuthController.Login(MyApp.Models.LoginRequest)' },
                  evidenceIds: ['pci:ev:caller-loc']
                }
              ]
            },
            evidence: [
              {
                id: 'pci:ev:caller-loc',
                path: 'src/Controllers/AuthController.cs',
                range: { start: { line: 54, character: 8 } }
              }
            ]
          };
        }
        if (tool === 'get_callees') {
          return {
            data: {
              items: [
                {
                  edgeId: 'pci:edge:9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d',
                  targetSymbolId: 'pci:sym:7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b',
                  symbol: { symbolId: 'pci:sym:7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b', qualifiedName: 'MyApp.Auth.TokenValidator.Verify(string)' },
                  evidenceIds: ['pci:ev:callee-loc']
                }
              ]
            },
            evidence: [
              {
                id: 'pci:ev:callee-loc',
                path: 'src/Auth/TokenValidator.cs',
                range: { start: { line: 12, character: 8 } }
              }
            ]
          };
        }
        if (tool === 'explain_symbol') {
          return {
            data: {
              description: { text: 'Handles token verification and user authentication flows.' },
              facts: [{ text: 'Declared class MyApp.Auth.AuthenticationHandler' }]
            }
          };
        }
      }
      return { data: {} };
    });
  });
}

test('opens code search from command palette, searches symbols, and displays source and usages', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const win = app.window;
  await setupMockCodeIntelligence(app);

  await expect(win.getByTestId('easymode-sidebar')).toBeVisible();

  // Open Command Palette
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await expect(palette).toBeVisible();

  // Find and trigger Search code action
  await palette.getByRole('textbox').fill('Search code');
  await expect(palette.getByRole('option', { name: /Search code & symbols/ })).toBeVisible();
  await win.keyboard.press('Enter');

  // Verify Code Search Dialog is open
  const dialog = win.getByTestId('code-search-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Code & Symbol Search')).toBeVisible();

  // Perform search
  const input = win.getByTestId('code-search-input');
  await input.fill('Auth');
  await win.getByTestId('code-search-submit-btn').click();

  // Verify results list
  const resultsList = win.getByTestId('code-search-results-list');
  await expect(resultsList).toBeVisible();
  await expect(win.getByTestId('code-search-item-pci:sym:auth-handler')).toBeVisible();
  await expect(win.getByTestId('code-search-item-pci:sym:validate-token')).toBeVisible();

  // Source view is active by default
  const sourceView = win.getByTestId('code-search-source-view');
  await expect(sourceView).toBeVisible();
  await expect(sourceView).toContainText('public class AuthenticationHandler');

  // Switch to Usages (Callers) tab
  await win.getByTestId('code-search-tab-callers').click();
  const callersList = win.getByTestId('code-search-callers-list');
  await expect(callersList).toBeVisible();
  await expect(callersList).toContainText('AuthController.Login');
  await expect(callersList).toContainText('src/Controllers/AuthController.cs:55');
  // Named from the item's symbol, never from the opaque ID or a parameter type.
  await expect(callersList).not.toContainText('pci:sym');
  await expect(callersList).not.toContainText('3f9c2b7e');
  await expect(callersList).not.toContainText('LoginRequest)');
  await expect(callersList.locator('.code-search-relation-symbol')).toHaveAttribute('title', 'MyApp.Controllers.AuthController.Login(MyApp.Models.LoginRequest)');

  // Switch to Callees tab
  await win.getByTestId('code-search-tab-callees').click();
  const calleesList = win.getByTestId('code-search-callees-list');
  await expect(calleesList).toBeVisible();
  await expect(calleesList).toContainText('TokenValidator.Verify');
  await expect(calleesList).not.toContainText('7a6b5c4d');

  // Switch to Explanation tab
  await win.getByTestId('code-search-tab-explain').click();
  const explainView = win.getByTestId('code-search-explain-view');
  await expect(explainView).toBeVisible();
  await expect(explainView).toContainText('Handles token verification and user authentication flows.');

  // Test Copy button
  await win.getByTestId('code-search-copy-symbol-btn').click();
  await expect(dialog.getByText('Copied symbol name')).toBeVisible();

  // Close on Escape
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('opens code search via shortcut ControlOrMeta+Shift+F and from session code intel chip', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: true });
  const win = app.window;
  await setupMockCodeIntelligence(app);

  // Shortcut test
  await win.keyboard.press('ControlOrMeta+Shift+F');
  const dialog = win.getByTestId('code-search-dialog');
  await expect(dialog).toBeVisible();

  // Close with close button
  await dialog.getByRole('button', { name: 'Close code search' }).click();
  await expect(dialog).toHaveCount(0);

  // Popover menu test
  const chip = win.getByTestId('new-session-code-intel-chip');
  await expect(chip).toBeVisible();
  await chip.click();

  const searchBtn = win.getByTestId('new-session-code-intel-search-btn');
  await expect(searchBtn).toBeVisible();
  await searchBtn.click();

  // Verify dialog opened from chip action
  await expect(win.getByTestId('code-search-dialog')).toBeVisible();
});
