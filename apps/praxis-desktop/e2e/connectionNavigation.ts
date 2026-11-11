import { expect, type Page } from '@playwright/test';

/** Connection management remains available through the command palette. */
export async function openConnections(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill('connections');
  await palette.getByRole('option', { name: 'Connections', exact: true }).click();
  await expect(page.getByTestId('connections-page')).toBeVisible();
}
