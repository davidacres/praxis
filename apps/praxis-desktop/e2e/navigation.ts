import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Navigation through the command palette. The sidebar is sessions and runs
 * (EasyMode), so boards, projects and a project's Git graph are reached the way a
 * person reaches them now: ⌘K, type, pick. Rows are matched on their label and
 * hint rather than the accessible name, which runs the two together.
 */

function paletteRows(page: Page): Locator {
  return page.locator('.command-palette .command-palette-row');
}

async function openPalette(page: Page, query: string): Promise<void> {
  const palette = page.locator('.command-palette');
  if (!(await palette.isVisible())) await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('textbox', { name: 'Go to' }).fill(query);
}

async function chooseRow(page: Page, row: Locator): Promise<void> {
  await row.click();
  await expect(page.locator('.command-palette')).toHaveCount(0);
}

function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/**
 * Open a board by name (a substring, like the sidebar rows the specs used to
 * click), or the first board the palette lists when no name is given.
 */
export async function openBoard(page: Page, name?: string | RegExp): Promise<void> {
  await openPalette(page, typeof name === 'string' ? name : '');
  let rows = paletteRows(page).filter({ has: page.locator('.command-palette-hint', { hasText: exactly('Board') }) });
  if (name) rows = rows.filter({ has: page.locator('.command-palette-label', { hasText: name }) });
  await chooseRow(page, rows.first());
  await expect(page.getByTestId('board-view')).toBeVisible();
}

/** Open a project's home by its exact name. */
export async function openProject(page: Page, name: string): Promise<void> {
  await openPalette(page, name);
  const row = paletteRows(page)
    .filter({ has: page.locator('.command-palette-label', { hasText: exactly(name) }) })
    .filter({ has: page.locator('.command-palette-hint', { hasText: ' · ' }) });
  await chooseRow(page, row.first());
}

/** Open one of a project's own destinations (`Git graph`, `Run`, `What Changed`, …). */
export async function openProjectPage(page: Page, projectName: string, destination: string): Promise<void> {
  const label = `${projectName}: ${destination}`;
  await openPalette(page, label);
  await chooseRow(page, paletteRows(page).filter({ has: page.locator('.command-palette-label', { hasText: exactly(label) }) }).first());
}

/** Open any palette destination by its exact label (a feature, a workflow, a settings page). */
export async function openFromPalette(page: Page, label: string, hint?: string): Promise<void> {
  await openPalette(page, label);
  let rows = paletteRows(page).filter({ has: page.locator('.command-palette-label', { hasText: exactly(label) }) });
  if (hint) rows = rows.filter({ has: page.locator('.command-palette-hint', { hasText: hint }) });
  await chooseRow(page, rows.first());
}

/** The board names the palette offers, closing it again afterwards. */
export async function listedBoards(page: Page): Promise<string[]> {
  await openPalette(page, '');
  const names = await paletteRows(page)
    .filter({ has: page.locator('.command-palette-hint', { hasText: exactly('Board') }) })
    .locator('.command-palette-label')
    .allTextContents();
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-palette')).toHaveCount(0);
  return names;
}

/**
 * Open a project's New workflow dialog. The project tree's per-project `+` is
 * gone; a project's Workflows page offers New workflow when no workflow is open.
 */
export async function openNewWorkflowDialog(page: Page, projectName: string): Promise<void> {
  await openProject(page, projectName);
  await openFromPalette(page, 'Workflows');
  await page.locator('.wf-page').getByRole('button', { name: 'New workflow' }).click();
  await expect(page.getByRole('dialog', { name: 'New workflow' })).toBeVisible();
}

/** Open the start-run dialog from the sidebar's Runs header. */
export async function openStartRunDialog(page: Page): Promise<void> {
  await page.getByTestId('section-header-add-automations').click();
  await expect(page.getByTestId('wf-runstart-dialog')).toBeVisible();
}

/**
 * Open a run from its card in the sidebar's Runs list. Clicks near the row's
 * left edge: hovering reveals the row's action buttons over its middle (further
 * left when the card has stages), so a centred click would press one of them.
 */
export async function openRunFromSidebar(page: Page, runId: string): Promise<void> {
  await page.getByTestId(`easymode-run-${runId}`).locator('.easymode-automation-row').click({ position: { x: 20, y: 10 } });
}
