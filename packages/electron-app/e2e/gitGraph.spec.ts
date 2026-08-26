import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

async function expectHistoryColumnsAligned(window: TestApp['window']) {
  const textLeft = async (selector: string) => window.locator(selector).first().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().left;
  });
  const headerCells = window.locator('.git-history-header > span');
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(2)') - await textLeft('.git-commit-message strong'))).toBeLessThanOrEqual(1);
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(3)') - await textLeft('.git-commit-author'))).toBeLessThanOrEqual(1);
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(4)') - await textLeft('.git-commit-date'))).toBeLessThanOrEqual(1);
  await expect(headerCells).toHaveCount(4);
  const edges = await window.locator('.git-history').evaluate(history => {
    const header = history.querySelector('.git-history-header');
    const row = history.querySelector('.git-commit-row');
    return { headerRight: header?.getBoundingClientRect().right ?? 0, rowRight: row?.getBoundingClientRect().right ?? 0 };
  });
  expect(Math.abs(edges.headerRight - edges.rowRight)).toBeLessThanOrEqual(1);
  expect(await window.locator('.git-history').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const dateFits = await window.locator('.git-history').evaluate((history) => {
    const date = history.querySelector('.git-commit-date');
    if (!date) return false;
    return date.getBoundingClientRect().right <= history.getBoundingClientRect().right + 1;
  });
  expect(dateFits).toBe(true);
}

test.beforeEach(async () => {
  app = await launchTestApp();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('renders the visual Git graph and commit inspector', async () => {
  const window = app.window;
  await window.setViewportSize({ width: 1280, height: 720 });
  await window.getByTestId('nav-git').click();
  await expect(window.getByTestId('git-graph-page')).toBeVisible();
  await expect(window.getByText('History', { exact: true })).toBeVisible();
  await expect(window.getByRole('complementary', { name: 'Branches' })).toContainText('Branches');
  await expect(window.getByRole('complementary', { name: 'Branches' })).not.toContainText('%x00');
  await expect(window.getByRole('list', { name: 'Commit history' }).getByRole('listitem').first()).toBeVisible();
  const firstCommit = window.getByRole('list', { name: 'Commit history' }).getByRole('listitem').first();
  await expectHistoryColumnsAligned(window);
  await firstCommit.focus();
  await firstCommit.press('Enter');
  await expect(window.getByRole('complementary', { name: 'Commit details' })).toContainText('COMMIT DETAILS');
  await expect(window.locator('.git-lines .git-edge, .git-horizontal-lines .git-edge')).not.toHaveCount(0);
  await window.getByRole('button', { name: '◇ Merges only' }).click();
  await expect(window.getByRole('button', { name: '◇ Merges only' })).toHaveClass(/active/);
  await window.getByRole('button', { name: 'Zoom in' }).click();
  await expect(window.getByRole('region', { name: 'Git Graph' })).toContainText('110%');
  await window.getByTestId('git-changes').click();
  await expect(window.getByTestId('git-changes-panel')).toContainText('changed files');
  await window.getByRole('button', { name: 'Git settings' }).click();
  await expect(window.getByRole('region', { name: 'Git Graph' })).toContainText('Git Graph settings');
  await expect(window.getByLabel('Git executable path')).toBeVisible();
  const branchColors = window.getByRole('checkbox', { name: 'Branch colors' });
  await branchColors.click();
  await expect(branchColors).not.toBeChecked();
  await window.getByRole('button', { name: 'Git settings' }).click();
  await window.getByRole('button', { name: 'Git settings' }).click();
  await expect(window.getByRole('checkbox', { name: 'Branch colors' })).not.toBeChecked();
  await window.getByRole('combobox', { name: 'Graph orientation' }).selectOption('horizontal');
  await expect(window.locator('.git-history-horizontal')).toBeVisible();
  await expect(window.getByRole('list', { name: 'Commit history' }).getByRole('listitem').first()).toBeVisible();
  await window.screenshot({ path: 'output/playwright/git-graph-horizontal.png', fullPage: true });
  await window.screenshot({ path: 'output/playwright/git-graph.png', fullPage: true });
});

test('keeps the graph usable in a narrow reduced-motion window', async () => {
  const window = app.window;
  await window.setViewportSize({ width: 900, height: 650 });
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await window.getByTestId('nav-git').click();
  await expect(window.getByTestId('git-graph-page')).toBeVisible();
  await expect(window.getByRole('list', { name: 'Commit history' })).toBeVisible();
  await expect(window.getByText('History', { exact: true })).toBeVisible();
  await expect(window.getByRole('button', { name: '↻ Refresh' })).toBeVisible();
  await expectHistoryColumnsAligned(window);
  await window.setViewportSize({ width: 760, height: 650 });
  await expectHistoryColumnsAligned(window);
  await window.screenshot({ path: 'output/playwright/git-graph-narrow-reduced-motion.png', fullPage: true });
});
