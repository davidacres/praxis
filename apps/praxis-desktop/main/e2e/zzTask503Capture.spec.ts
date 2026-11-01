// THROWAWAY (TASK-503 validation): not committed. Captures the evidence matrix.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { createProject, seedNotes, openShelf, showSidebar, spyProviderCalls } from './notesTestKit';

const OUT = path.resolve(__dirname, '../../../../.praxis/session-artifacts/task-503');
fs.mkdirSync(OUT, { recursive: true });
const results = { push: (r: Record<string, unknown>) => fs.writeFileSync(path.join(OUT, `m-${r.name}.json`), JSON.stringify(r, null, 2)) };

let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

function seedSessions(dir: string) {
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < 8; i++) {
    const issueKey = `SESSION-t503${i}`;
    const t = new Date(Date.now() - i * 60_000).toISOString();
    sessions[issueKey] = { issueKey, sessionId: `t503-${i}`, title: `Evidence session ${i}`, state: 'completed', startedAt: t,
      completedAt: t, provider: 'openai', model: 'mock/model', taskDefinition: { goal: `Evidence ${i}` }, events: [] };
  }
  fs.writeFileSync(path.join(dir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': sessions }));
}

async function launch(appearance: Record<string, unknown>, extra: Record<string, unknown> = {}, sessions = true) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-t503-'));
  if (sessions) seedSessions(userDataDir);
  app = await launchTestApp({ appearance, ...extra }, { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  const projectId = await createProject(page, 'Evidence Notes', 'EVN');
  await seedNotes(page, projectId, [
    { title: 'Release checklist', body: 'Confirm the rail stays 14px.\nCheck focus rings.' },
    { title: 'Retro ideas', body: 'Shelf pencil is quick to reach.' },
    { title: 'Loose thought', body: 'Ungrouped note.' }
  ], [{ title: 'Ideas', members: [0, 1] }, { title: 'Release', members: [0] }]);
  await page.reload();
  return page;
}

async function rail(page: Page, shelf: Locator) {
  const m = async () => {
    const box = (await shelf.boundingBox())!;
    const pane = (await page.getByTestId('main-content-pane').boundingBox())!;
    return { width: +box.width.toFixed(2), paneLeft: +pane.x.toFixed(2), gap: +(pane.x - box.x - box.width).toFixed(2) };
  };
  const style = await page.addStyleTag({ content: '.session-shelf__actions { display: none !important; }' });
  const baseline = await m();
  await style.evaluate(n => (n as Element).remove());
  const withControls = await m();
  const env = await page.evaluate(() => ({
    scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1,
    theme: document.documentElement.getAttribute('data-theme'),
    surface: document.documentElement.getAttribute('data-surface'),
    displaySize: document.documentElement.getAttribute('data-display-size'),
    innerWidth: window.innerWidth,
    scrollOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  const sleeve = await page.getByTestId('session-shelf-notes-card').boundingBox().catch(() => null);
  return { ...env, baseline, withControls, sleeveLeft: sleeve ? +sleeve.x.toFixed(2) : null,
    railRight: +((await shelf.boundingBox())!.x + (await shelf.boundingBox())!.width).toFixed(2) };
}

const matrix: [string, Record<string, unknown>, { zoom?: number; narrow?: boolean }][] = [
  ['light-parchment-standard', { themeId: 'praxis-light', themeMode: 'light', surfacePackId: 'parchment', activeLookId: 'look-parchment' }, {}],
  ['dark-parchment-standard', { themeId: 'praxis-dark', themeMode: 'dark', surfacePackId: 'parchment', activeLookId: 'look-parchment' }, {}],
  ['light-aurora-glass', { themeId: 'praxis-light', themeMode: 'light', surfacePackId: 'aurora-glass', activeLookId: 'look-aurora' }, {}],
  ['dark-graphite', { themeId: 'praxis-dark', themeMode: 'dark', surfacePackId: 'graphite', activeLookId: '' }, {}],
  ['light-large-scale', { themeId: 'praxis-light', themeMode: 'light', displayMode: 'large' }, {}],
  ['light-zoom-110', { themeId: 'praxis-light', themeMode: 'light', zoomFactor: 1.1 }, { zoom: 1.1 }],
  ['dark-narrow-720', { themeId: 'praxis-dark', themeMode: 'dark' }, { narrow: true }]
];

for (const [name, appearance, opts] of matrix) {
  test(`capture ${name}`, async () => {
    test.slow();
    const page = await launch(appearance);
    let narrowProbe: unknown;
    if (opts.narrow) {
      await app!.electronApp.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(720, 760); });
      await page.waitForTimeout(800);
      narrowProbe = await page.evaluate(() => {
        const t = document.querySelector('[aria-label="Toggle sidebar"]') as HTMLElement | null;
        const r = t?.getBoundingClientRect();
        return { innerWidth: window.innerWidth, toggleExists: !!t, toggleRect: r ? [r.x, r.y, r.width, r.height] : null,
          shelfVisible: !!document.querySelector('[data-testid="session-shelf"]'), sidebarVisible: !!document.querySelector('[data-testid="notes-section"]') };
      });
      await page.screenshot({ path: path.join(OUT, 'narrow-720-on-resize.png') });
      await app!.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 800); });
      await page.waitForTimeout(500);
      await openShelf(page);
      await app!.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(720, 760); });
      await page.waitForTimeout(800);
    }
    const shelf = await openShelf(page);
    const closed = await rail(page, shelf);
    await shelf.getByTestId('session-shelf-notes').click();
    const card = page.getByTestId('session-shelf-notes-card');
    await expect(card).toBeVisible();
    const picker = card.getByRole('button', { name: 'Save note to project' });
    if (await picker.count()) {
      await picker.click();
      await page.getByRole('option', { name: 'Evidence Notes' }).click();
    }
    await card.getByTestId('note-title').fill('Evidence note');
    await card.getByTestId('note-body').fill(`Captured in ${name}.`);
    await expect(card.getByTestId('note-save-state')).toHaveText('Saved');
    const open = await rail(page, shelf);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    results.push({ name, closed, open, narrowProbe });
  });
}

for (const easy of [false, true]) {
  test(`capture sidebar notes ${easy ? 'easy' : 'classic'}`, async () => {
    test.slow();
    const page = await launch({ themeId: 'praxis-light', themeMode: 'light' }, { preview: { enableEasyMode: easy } }, false);
    const section = await showSidebar(page);
    const group = section.getByRole('button', { name: /^Ideas/ }).first();
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    await expect(section.getByText('Retro ideas')).toBeVisible();
    await section.screenshot({ path: path.join(OUT, `sidebar-notes-${easy ? 'easy' : 'classic'}.png`) });
    await page.screenshot({ path: path.join(OUT, `sidebar-notes-${easy ? 'easy' : 'classic'}-window.png`) });
    results.push({ name: `sidebar-${easy ? 'easy' : 'classic'}`, rows: await section.getByRole('listitem').allInnerTexts() });
  });
}

test('keyboard and pointer journeys, send preview and cancel', async () => {
  test.slow();
  const page = await launch({ themeId: 'praxis-light', themeMode: 'light' }, {}, true);
  const spy = await spyProviderCalls(app!);
  const sessionsBefore = await spy.sessions();
  const journal: Record<string, unknown> = {};

  // Keyboard: focus the pencil, Enter, see where focus lands.
  const shelf = await openShelf(page);
  const pencil = shelf.getByTestId('session-shelf-notes');
  await pencil.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('session-shelf-notes-card')).toBeVisible();
  await page.waitForTimeout(400);
  journal.focusAfterPencilEnter = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? `${a.tagName} testid=${a.dataset.testid ?? ''} label=${a.getAttribute('aria-label') ?? ''}` : null;
  });
  journal.pickerShown = await page.getByTestId('session-shelf-notes-card').getByRole('button', { name: 'Save note to project' }).count();
  await page.screenshot({ path: path.join(OUT, 'journey-keyboard-pencil.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  journal.focusAfterEscape = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid ?? document.activeElement?.tagName);

  // Keyboard: plus opens a new session view and sends nothing.
  await shelf.getByTestId('session-shelf-new').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-session-view')).toBeVisible();
  journal.sessionsAfterPlus = await spy.sessions();

  // Pointer: sidebar group -> Send to session… -> preview -> Cancel.
  const section = await showSidebar(page);
  await section.getByRole('button', { name: 'Actions for group Ideas', exact: true }).click();
  await page.getByRole('option', { name: 'Send to session…', exact: true }).click();
  const dialog = page.getByTestId('note-send-dialog');
  await expect(dialog).toBeVisible();
  journal.previewNotes = await page.getByTestId('note-send-preview-note').locator('strong').allInnerTexts();
  await page.screenshot({ path: path.join(OUT, 'send-preview-dialog.png') });
  await page.getByTestId('note-send-cancel').click();
  await expect(dialog).toHaveCount(0);
  journal.providerCallsAfterCancel = await spy.count();
  journal.sessionsBefore = sessionsBefore;
  journal.sessionsAfterCancel = await spy.sessions();
  results.push({ name: 'journeys', ...journal });
});
