import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

async function createProject(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    await window.praxis.projects.create({
      name: 'Sidebar Notes', key: 'SBN', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }]
    } as never, workspace.id);
  });
}

/** Writes a note through the sidebar editor and waits for it to autosave. */
async function addNote(page: Page, title: string, body: string) {
  const section = page.getByTestId('notes-section');
  await section.getByRole('button', { name: 'Create new note' }).click();
  const picker = section.getByRole('button', { name: 'Save note to project' });
  if (await picker.count()) await chooseOption(picker, { label: 'Sidebar Notes' });
  await section.getByTestId('note-title').fill(title);
  await section.getByTestId('note-body').fill(body);
  await expect(section.getByTestId('note-save-state')).toHaveText('Saved');
  await expect(section.getByTestId('notes-tree').or(section).getByRole('button', { name: title, exact: true }).first()).toBeVisible();
}

async function menu(page: Page, label: string, item: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: item, exact: true }).click();
}

test('notes created in the sidebar tree show in the shelf editor, and groups link without duplicating', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  await page.reload();
  const section = page.getByTestId('notes-section');
  await expect(section).toBeVisible();
  await expect(section.getByText('No notes yet')).toBeVisible();

  await addNote(page, 'Alpha', 'first body');
  await section.getByRole('button', { name: 'Close editor' }).click();
  await addNote(page, 'Beta', 'second body');
  await section.getByRole('button', { name: 'Close editor' }).click();

  // A group; a note in two groups; the notes stay in one place.
  await menu(page, 'Actions for note Alpha', 'Add to new group…');
  await page.getByLabel('Group name').fill('Ideas');
  await page.getByRole('button', { name: 'Create' }).click();
  const group = section.getByRole('button', { name: /Ideas/ });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await menu(page, 'Actions for note Beta', 'Add to Ideas');
  await expect(section.getByTestId('notes-tree').getByRole('listitem').filter({ hasText: 'Beta' })).toHaveCount(1);

  // Collapse and expand.
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();

  // Remove from the group keeps the note.
  await menu(page, 'Actions for note Beta', 'Remove from this group');
  await expect(section.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();

  // The shelf shows the same open note.
  await section.getByRole('button', { name: 'Alpha', exact: true }).click();
  await expect(section.getByTestId('note-body')).toHaveValue('first body');
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('session-shelf-notes').click();
  await expect(page.getByTestId('session-shelf-notes-card').getByTestId('note-body')).toHaveValue('first body');
});

test('deleting an open note asks first, resets the editor and removes it from groups; deleting a group keeps notes', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page);
  await page.reload();
  const section = page.getByTestId('notes-section');
  await addNote(page, 'Doomed', 'bye');
  await menu(page, 'Actions for note Doomed', 'Add to new group…');
  await page.getByLabel('Group name').fill('Temp');
  await page.getByRole('button', { name: 'Create' }).click();

  await menu(page, 'Actions for note Doomed', 'Delete note');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(section.getByRole('button', { name: 'Doomed', exact: true })).toBeVisible();

  await menu(page, 'Actions for note Doomed', 'Delete note');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Doomed', exact: true })).toHaveCount(0);
  await expect(section.getByTestId('note-body')).toHaveValue('');
  await expect(section.getByText('No notes in this group')).toBeVisible();

  await menu(page, 'Actions for group Temp', 'Delete group');
  await page.getByRole('button', { name: 'Delete group' }).last().click();
  await expect(section.getByRole('button', { name: /Temp/ })).toHaveCount(0);
});
