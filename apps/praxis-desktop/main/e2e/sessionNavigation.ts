import { expect, type Page } from '@playwright/test';

/** Open a persisted session through the real palette, regardless of its sidebar scope. */
export async function openSession(page: Page, keyOrTitle?: string): Promise<void> {
  const session = await page.evaluate(async query => {
    const sessions = await window.praxis.ai.listSessions();
    const matches = query ? sessions.filter(s => s.issueKey === query || s.title?.includes(query) || s.taskDefinition.goal.includes(query)) : sessions.slice(0, 1);
    if (matches.length > 1) throw new Error(`Ambiguous session: ${query}`);
    const record = matches[0];
    if (!record) throw new Error(`Session not found: ${query ?? 'latest'}`);
    return { title: record.title?.trim() || record.taskDefinition.goal.split('\n')[0], key: record.issueKey };
  }, keyOrTitle);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.locator('.command-palette');
  await palette.getByRole('textbox', { name: 'Go to' }).fill(session.key);
  await palette.getByRole('option').filter({ hasText: session.title }).click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('sessions-view')).toBeVisible();
}
