import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

async function createProject(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({
      name: 'Shelf Notes', key: 'SHN', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }]
    } as never, workspace.id)).id;
  });
}

/** Hides the sidebar so the shelf shows, then picks the note's project if the shelf has none. */
async function openShelf(page: Page) {
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  const shelf = page.getByTestId('session-shelf');
  await expect(shelf).toBeVisible();
  return shelf;
}

async function openNotes(page: Page) {
  const shelf = page.getByTestId('session-shelf');
  await shelf.getByTestId('session-shelf-notes').click();
  const card = page.getByTestId('session-shelf-notes-card');
  await expect(card).toBeVisible();
  const picker = card.getByRole('button', { name: 'Save note to project' });
  if (await picker.count()) await chooseOption(picker, { label: 'Shelf Notes' });
  return card;
}

test('the rail stays 14px with both controls inside it, and the plus opens a new session without sending', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const shelf = await openShelf(page);
  const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1);
  const bounds = (await shelf.boundingBox())!;
  expect(Math.abs(bounds.width - 14 * scale)).toBeLessThanOrEqual(0.5);
  for (const id of ['session-shelf-new', 'session-shelf-notes']) {
    const box = (await shelf.getByTestId(id).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 0.5);
  }
  const before = await page.evaluate(async () => (await window.praxis.ai.listSessions()).length);
  await shelf.getByTestId('session-shelf-new').click();
  await expect(page.getByTestId('new-session-view')).toBeVisible();
  // Opening the composer creates nothing and sends nothing.
  const after = await page.evaluate(async () => (await window.praxis.ai.listSessions()).length);
  expect(after).toBe(before);
  expect((await shelf.boundingBox())!.width).toBeCloseTo(bounds.width, 0);
});

test('the notes pencil opens the editor with focus in the title; typing saves; Escape returns focus and reopening keeps the text', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  const shelf = await openShelf(page);
  const pencil = shelf.getByTestId('session-shelf-notes');
  await pencil.focus();
  await page.keyboard.press('Enter');
  const card = page.getByTestId('session-shelf-notes-card');
  await expect(card).toBeVisible();
  await expect(pencil).toHaveAttribute('aria-expanded', 'true');
  const picker = card.getByRole('button', { name: 'Save note to project' });
  if (await picker.count()) await chooseOption(picker, { label: 'Shelf Notes' });
  // Focus moved into the editor, so the pointer leaving does not tuck the card away.
  await card.getByTestId('note-title').click();
  await page.keyboard.type('Plan');
  await card.getByTestId('note-body').fill('remember the milk');
  await expect(card.getByTestId('note-save-state')).toHaveText('Saved');
  await page.mouse.move(700, 400);
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(pencil).toBeFocused();
  await pencil.click();
  await expect(card.getByTestId('note-body')).toHaveValue('remember the milk');
  const stored = fs.readFileSync(path.join(app.userDataDir, 'notes.json'), 'utf8');
  expect(stored).toContain('remember the milk');
});

test('activating the pencil with the keyboard puts focus in the note title', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-notes').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note-title')).toBeFocused();
});

test('a failed save keeps the draft, flags the pencil and recovers on Retry', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  const shelf = await openShelf(page);
  const card = await openNotes(page);
  await card.getByTestId('note-body').fill('first line');
  await expect(card.getByTestId('note-save-state')).toHaveText('Saved');
  // Make the atomic rename fail: a non-empty directory where the file belongs.
  const file = path.join(app.userDataDir, 'notes.json');
  const saved = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  fs.mkdirSync(path.join(file, 'blocker'), { recursive: true });
  await card.getByTestId('note-body').fill('first line, then more');
  await expect(card.getByTestId('note-save-error')).toBeVisible();
  // Dismiss by pressing outside, then reopen: the text is intact.
  await page.mouse.click(700, 400);
  await expect(card).toBeHidden();
  await expect(shelf.getByTestId('session-shelf-notes-unsaved')).toBeVisible();
  await shelf.getByTestId('session-shelf-notes').click();
  await expect(card.getByTestId('note-body')).toHaveValue('first line, then more');
  await expect(card.getByTestId('note-save-state')).toHaveCount(0);
  fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, saved);
  await card.getByRole('button', { name: 'Retry' }).click();
  await expect(card.getByTestId('note-save-state')).toHaveText('Saved');
  await expect(shelf.getByTestId('session-shelf-notes-unsaved')).toHaveCount(0);
  expect(fs.readFileSync(file, 'utf8')).toContain('first line, then more');
});

test('Escape closes the project picker before it closes the notes card', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-notes').click();
  const card = page.getByTestId('session-shelf-notes-card');
  const picker = card.getByRole('button', { name: 'Save note to project' });
  test.skip(await picker.count() === 0, 'The shelf already has a project, so there is no picker to layer.');
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toBeVisible();
});

test('picking a project with the mouse keeps the notes card open', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  const shelf = await openShelf(page);
  await shelf.getByTestId('session-shelf-notes').click();
  const card = page.getByTestId('session-shelf-notes-card');
  const picker = card.getByRole('button', { name: 'Save note to project' });
  test.skip(await picker.count() === 0, 'The shelf already has a project, so there is no picker to click.');
  await picker.click();
  await page.getByRole('option', { name: /Shelf Notes/ }).click();
  await expect(card).toBeVisible();
  await expect(picker).toHaveCount(0);
});
