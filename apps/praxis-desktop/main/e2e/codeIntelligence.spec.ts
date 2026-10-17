import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

async function openPanel() {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    let root = '/fixture/original';
    let generation = 1;
    let modelInstalled = false;

    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') return { data: [{ id: 'pci:repo:fixture', root, state: 'ready', generation }] };
      if (request.action === 'rebuild') { generation++; return { data: { queued: true } }; }
      if (request.action === 'relocate') { root = String(request.root); generation++; return { data: { relocated: true } }; }
      if (request.action === 'query') {
        return {
          indexGeneration: generation,
          freshness: { state: 'current' },
          data: { contexts: [], diagnostics: [], models: [], jobsByState: {} }
        };
      }
      return { error: { code: 'FIXTURE_UNEXPECTED_REQUEST', message: JSON.stringify(request) } };
    });

    ipcMain.removeHandler('ai:getSemanticModelStatus');
    ipcMain.handle('ai:getSemanticModelStatus', () => ({
      installed: modelInstalled,
      active: modelInstalled,
      fingerprint: modelInstalled ? 'sha256:fixture-fingerprint' : undefined,
      sizeBytes: modelInstalled ? 90636722 : 0,
      downloading: false,
      progressPercent: modelInstalled ? 100 : 0
    }));

    ipcMain.removeHandler('ai:downloadSemanticModel');
    ipcMain.handle('ai:downloadSemanticModel', () => {
      modelInstalled = true;
      return {
        installed: true,
        active: true,
        fingerprint: 'sha256:fixture-fingerprint',
        sizeBytes: 90636722,
        downloading: false,
        progressPercent: 100
      };
    });

    ipcMain.removeHandler('ai:deleteSemanticModel');
    ipcMain.handle('ai:deleteSemanticModel', () => {
      modelInstalled = false;
    });
  });

  const win = app.window;
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-tab-tools').click();
  const panel = win.getByTestId('code-intelligence-panel');
  await expect(panel).toContainText('Generation 1');
  return { win, panel };
}

test('rebuild and relocation use the themed recovery flow and refresh status', async ({}, testInfo) => {
  const { win, panel } = await openPanel();
  win.on('dialog', () => { throw new Error('Recovery must use an in-app dialog.'); });

  // Rebuild index
  await panel.getByTestId('code-intel-rebuild-btn').click();
  await expect(panel).toContainText('Generation 2');

  // Relocate repository
  await panel.getByRole('button', { name: 'Relocate', exact: true }).click();
  const dialog = win.getByRole('dialog', { name: 'Relocate repository', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('/fixture/moved');
  await dialog.getByRole('button', { name: 'Relocate repository', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('/fixture/moved');
  await expect(panel).toContainText('Generation 3');
  await panel.screenshot({ path: testInfo.outputPath('code-intelligence-recovery.png') });
});

test('semantic search card shows status, allows downloading model, and deleting model', async () => {
  const { win, panel } = await openPanel();

  const semanticCard = panel.getByTestId('semantic-model-card');
  await expect(semanticCard).toBeVisible();
  await expect(semanticCard).toContainText('Semantic Search');

  // Initial state: standard keyword search active
  const badge = semanticCard.getByTestId('semantic-model-badge');
  await expect(badge).toHaveText('Standard keyword search active');

  // Download button
  const downloadBtn = semanticCard.getByTestId('semantic-model-download-btn');
  await expect(downloadBtn).toBeVisible();
  await expect(downloadBtn).toContainText('Enable Semantic Search (~90 MB)');

  // Trigger download
  await downloadBtn.click();

  // Model is now active
  await expect(badge).toHaveText('Semantic search active');
  const deleteBtn = semanticCard.getByTestId('semantic-model-delete-btn');
  await expect(deleteBtn).toBeVisible();

  // Delete model
  await deleteBtn.click();
  const confirmDialog = win.getByRole('dialog', { name: 'Remove Semantic Search Model?' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Remove Model' }).click();

  // Returns to standard keyword search
  await expect(badge).toHaveText('Standard keyword search active');
});

test('code intelligence panel maintains accessibility in light and dark modes', async ({}, testInfo) => {
  const { win, panel } = await openPanel();
  await win.setViewportSize({ width: 1000, height: 800 });

  for (const mode of ['light', 'dark']) {
    await win.evaluate(m => {
      document.documentElement.setAttribute('data-mode', m);
      document.documentElement.setAttribute('data-theme', `praxis-${m}`);
      document.documentElement.style.setProperty('--ui-scale', '1.25');
    }, mode);

    const downloadBtn = panel.getByTestId('semantic-model-download-btn');
    await downloadBtn.focus();
    await expect(downloadBtn).toBeFocused();
    expect(await downloadBtn.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);

    await win.screenshot({ path: testInfo.outputPath(`code-intelligence-${mode}-panel.png`) });
  }
});
