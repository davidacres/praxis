import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { createProject, openShelf, openShelfNotes } from './notesTestKit';

// Not in the smoke set: it measures layout in a real window and takes screenshots.

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

/** Sessions enough to fill the rail (the shelf shows the latest five). */
function seedSessions(userDataDir: string): void {
  const sessions: Record<string, unknown> = {};
  for (let index = 0; index < 8; index++) {
    const issueKey = `SESSION-geo${index}`;
    const timestamp = new Date(Date.now() - index * 60_000).toISOString();
    sessions[issueKey] = {
      issueKey, sessionId: `geo-${index}`, title: `Geometry session ${index}`, state: 'completed', startedAt: timestamp,
      completedAt: timestamp, provider: 'openai', model: 'mock/model',
      taskDefinition: { goal: `Geometry ${index}` }, events: []
    };
  }
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': sessions }));
}

/** `gap` is the workspace inset: the space between the rail's right edge and the main pane. */
interface Rail { width: number; left: number; right: number; paneLeft: number; gap: number }

async function measure(page: Page, shelf: Locator): Promise<Rail> {
  const box = (await shelf.boundingBox())!;
  const pane = (await page.getByTestId('main-content-pane').boundingBox())!;
  return { width: box.width, left: box.x, right: box.x + box.width, paneLeft: pane.x, gap: pane.x - (box.x + box.width) };
}

const setScale = (page: Page, scale: number) =>
  page.evaluate(value => document.documentElement.style.setProperty('--ui-scale', String(value)), scale);

/**
 * The rail as it was before the new-session and notes controls: the same document with the
 * action block taken out. The controls must add nothing to its width or to the workspace inset.
 */
async function measureBaseline(page: Page, shelf: Locator): Promise<Rail> {
  const style = await page.addStyleTag({ content: '.session-shelf__actions { display: none !important; }' });
  const baseline = await measure(page, shelf);
  await style.evaluate(node => (node as Element).remove());
  return baseline;
}

for (const [label, scale] of [['compact', 1], ['large', 1.16]] as const) {
  test(`the ${label} rail is 14 x scale wide, matches the baseline and leaves the workspace inset alone`, async () => {
    test.slow();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-geometry-'));
    app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') }, undefined, { openNewSession: false });
    const page = app.window;
    await createProject(page, 'Rail Notes', 'RLN');
    const shelf = await openShelf(page);
    await setScale(page, scale);

    const baseline = await measureBaseline(page, shelf);
    const withControls = await measure(page, shelf);
    // The old formula: flex-basis calc(14px * var(--ui-scale)).
    expect(Math.abs(baseline.width - 14 * scale)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(withControls.width - baseline.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(withControls.paneLeft - baseline.paneLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(withControls.gap - baseline.gap)).toBeLessThanOrEqual(0.5);

    for (const id of ['session-shelf-new', 'session-shelf-notes']) {
      const box = (await shelf.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(withControls.left - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(withControls.right + 0.5);
    }
  });
}

test('a full rail keeps its width and keeps both controls reachable inside it', async () => {
  test.slow();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-geometry-'));
  seedSessions(userDataDir);
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') }, undefined, { openNewSession: false });
  const page = app.window;
  const shelf = await openShelf(page);
  await expect(shelf.getByTestId('session-shelf-spine')).toHaveCount(5);
  const full = await measure(page, shelf);
  const baseline = await measureBaseline(page, shelf);
  expect(Math.abs(full.width - baseline.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(full.paneLeft - baseline.paneLeft)).toBeLessThanOrEqual(0.5);

  for (const id of ['session-shelf-new', 'session-shelf-notes']) {
    const control = shelf.getByTestId(id);
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(full.left - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(full.right + 0.5);
    const shelfBox = (await shelf.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(shelfBox.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(shelfBox.y + shelfBox.height + 0.5);
    await expect(control).toBeVisible();
  }
  // Nothing in the rail scrolls sideways. (The shelf element itself is not measured: its
  // hidden notes sleeve is an absolutely positioned child that counts toward scrollWidth.)
  for (const selector of ['.session-shelf__spines', '.session-shelf__actions']) {
    const overflow = await shelf.locator(selector).evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow, selector).toBeLessThanOrEqual(1);
  }
});

test('keyboard focus on a control does not move the rail or the workspace, and the ring stays inside', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const shelf = await openShelf(page);
  const before = await measure(page, shelf);
  for (const id of ['session-shelf-new', 'session-shelf-notes']) {
    const control = shelf.getByTestId(id);
    await control.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(control).toBeFocused();
    const after = await measure(page, shelf);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.paneLeft - before.paneLeft)).toBeLessThanOrEqual(0.5);
    // The ring's outer edge (width + offset past the control) stays within the rail.
    const ring = await control.evaluate(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const shelfRect = el.closest('[data-testid="session-shelf"]')!.getBoundingClientRect();
      const reach = (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0);
      return { rightEdge: rect.right + (style.outlineStyle === 'none' ? 0 : reach), shelfRight: shelfRect.right };
    });
    expect(ring.rightEdge).toBeLessThanOrEqual(ring.shelfRight + 0.5);
  }
});

test('the open notes card is the only part that reaches into the workspace', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page, 'Rail Notes', 'RLN');
  await page.reload();
  const shelf = await openShelf(page);
  const closed = await measure(page, shelf);
  const card = await openShelfNotes(page, 'Rail Notes');
  const sleeve = (await card.locator('xpath=..').boundingBox())!;
  // The sleeve starts flush with the rail's right edge.
  expect(Math.abs(sleeve.x - closed.right)).toBeLessThanOrEqual(1);
  const open = await measure(page, shelf);
  expect(Math.abs(open.width - closed.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(open.paneLeft - closed.paneLeft)).toBeLessThanOrEqual(0.5);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the rail measures the same under a ${colorScheme} colour scheme`, async () => {
    test.slow();
    app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
    const page = app.window;
    await page.emulateMedia({ colorScheme });
    const shelf = await openShelf(page);
    const rail = await measure(page, shelf);
    const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1);
    expect(Math.abs(rail.width - 14 * scale)).toBeLessThanOrEqual(0.5);
    expect(rail.gap).toBeGreaterThanOrEqual(0);
    // Evidence for the visual review (TASK-503); a plain capture, not a baseline comparison.
    const dir = path.join(__dirname, '..', '..', '..', '.praxis', 'session-artifacts');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `notes-rail-${colorScheme}.png`) });
  });
}

test('whole-window zoom at 110% leaves the rail 14 x scale in CSS pixels', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByTestId('titlebar-zoom-in').click();
  await expect(page.getByTestId('titlebar-zoom-reset')).toHaveText('110%');
  const shelf = await openShelf(page);
  const rail = await measure(page, shelf);
  const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1);
  // Bounding boxes are in CSS pixels, so the page zoom does not change them.
  expect(Math.abs(rail.width - 14 * scale)).toBeLessThanOrEqual(0.5);
  expect(rail.gap).toBeGreaterThanOrEqual(0);
});
