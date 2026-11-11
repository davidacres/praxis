import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { launchTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/** Shared helpers for the notes journeys (persistence, geometry). */

/** Creates an app-storage project in the first workspace and returns its id. */
export async function createProject(page: Page, name: string, key: string): Promise<string> {
  return page.evaluate(async ({ name, key }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({
      name, key, type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }], defaultAiToolMode: 'read-only'
    } as never, workspace.id)).id as string;
  }, { name, key });
}

/** Creates notes then groups through the real preload bridge; returns the ids in the order given. */
export async function seedNotes(
  page: Page,
  projectId: string,
  notes: { title: string; body: string }[],
  groups: { title: string; members: number[] }[] = []
): Promise<{ noteIds: string[]; groupIds: string[] }> {
  return page.evaluate(async ({ projectId, notes, groups }) => {
    const noteIds: string[] = [];
    for (const input of notes) {
      const result = await window.praxis.notes.createNote(projectId, input);
      if (!result.ok) throw new Error(`createNote failed: ${JSON.stringify(result)}`);
      noteIds.push(result.value.id);
    }
    const groupIds: string[] = [];
    for (const group of groups) {
      const result = await window.praxis.notes.createGroup(projectId, { title: group.title, noteIds: group.members.map(i => noteIds[i]) });
      if (!result.ok) throw new Error(`createGroup failed: ${JSON.stringify(result)}`);
      groupIds.push(result.value.id);
    }
    return { noteIds, groupIds };
  }, { projectId, notes, groups });
}

/**
 * Every IPC channel that can start a provider turn. Each is replaced with a recorder that
 * throws, so a hidden AI call both counts and fails loudly. `count()` also covers the
 * session list, which grows if anything creates a session.
 */
const PROVIDER_CHANNELS = [
  'ai:delegate', 'ai:continueSession', 'ai:startConversation',
  'ai:sendConversationMessage', 'ai:handoverSession', 'ai:resumeInterruptedSession'
];

export async function spyProviderCalls(app: TestApp): Promise<{ count: () => Promise<number>; sessions: () => Promise<number> }> {
  const calls: string[] = [];
  for (const channel of PROVIDER_CHANNELS) {
    await app.overrideChannel(channel, () => { calls.push(channel); throw new Error(`unexpected provider call: ${channel}`); });
  }
  return {
    count: async () => calls.length,
    sessions: () => app.window.evaluate(async () => (await window.praxis.ai.listSessions()).length)
  };
}

/** Hides the sidebar so the shelf shows (the choice persists across a restart, so check first). */
export async function openShelf(page: Page) {
  const shelf = page.getByTestId('session-shelf');
  if (!await shelf.isVisible()) {
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await expect(shelf).toBeVisible();
  return shelf;
}

/** Brings the sidebar back if it is hidden. */
export async function showSidebar(page: Page) {
  const section = page.getByTestId('notes-section');
  if (!await section.isVisible()) await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(section).toBeVisible();
  return section;
}

/** Opens the shelf notes card, choosing the project if the card asks for one. */
export async function openShelfNotes(page: Page, projectLabel: string) {
  await page.getByTestId('session-shelf').getByTestId('session-shelf-notes').click();
  const card = page.getByTestId('session-shelf-notes-card');
  await expect(card).toBeVisible();
  const picker = card.getByRole('button', { name: 'Save note to project' });
  if (await picker.count()) await chooseOption(picker, { label: projectLabel });
  return card;
}

/** Writes a note through the sidebar editor and waits for it to autosave. */
export async function addSidebarNote(page: Page, projectLabel: string, title: string, body: string) {
  const section = page.getByTestId('notes-section');
  await section.getByRole('button', { name: 'Create new note' }).click();
  const picker = section.getByRole('button', { name: 'Save note to project' });
  if (await picker.count()) await chooseOption(picker, { label: projectLabel });
  await section.getByTestId('note-title').fill(title);
  await section.getByTestId('note-body').fill(body);
  await expect(section.getByTestId('note-save-state')).toHaveText('Saved');
  return section;
}

export async function menu(page: Page, label: string, item: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: item, exact: true }).click();
}

/** Closes the app and launches a new one on the same profile, landing on the project home. */
export async function relaunch(app: TestApp): Promise<TestApp> {
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  return launchTestApp(undefined, reuse, undefined, { openNewSession: false });
}

export const notesFilePath = (app: TestApp) => path.join(app.userDataDir, 'notes.json');

export interface NotesFile {
  notes: { id: string; projectId: string; title: string; body: string }[];
  groups: { id: string; projectId: string; title: string; noteIds: string[] }[];
}

export function readNotesFile(app: TestApp): NotesFile {
  return JSON.parse(fs.readFileSync(notesFilePath(app), 'utf8')) as NotesFile;
}

/** Swaps the notes file for a non-empty directory so the atomic rename fails; returns a restore function. */
export function blockNotesFile(app: TestApp): () => void {
  const file = notesFilePath(app);
  const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  fs.rmSync(file, { force: true });
  fs.mkdirSync(path.join(file, 'blocker'), { recursive: true });
  return () => {
    fs.rmSync(file, { recursive: true, force: true });
    if (saved !== undefined) fs.writeFileSync(file, saved);
  };
}
