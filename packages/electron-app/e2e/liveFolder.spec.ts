import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
let liveFolderDir: string;

function writeFixtureLiveFolder(root: string): void {
  const featureDir = path.join(root, 'features', 'feature-01-demo-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    ['# Demo Feature', '', '**Status:** 📋 Proposed', '**Type:** Feature', '', '## Description', '', 'A demo feature for e2e testing.', ''].join(
      '\n'
    )
  );
  fs.writeFileSync(
    path.join(featureDir, 'task-01-01-do-the-thing.md'),
    [
      '# Do the thing',
      '',
      '**Status:** 📋 Proposed',
      '**Type:** Task',
      '',
      '## Description',
      '',
      'Do the thing for e2e testing.',
      '',
      '## Comments',
      ''
    ].join('\n')
  );
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-e2e-'));
  liveFolderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-livefolder-'));
  writeFixtureLiveFolder(liveFolderDir);

  electronApp = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    cwd: path.join(__dirname, '..')
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await electronApp.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(liveFolderDir, { recursive: true, force: true });
});

async function addLiveFolderConnection(name: string): Promise<void> {
  await window.locator('[data-testid="nav-connections"]').click();
  await window.getByPlaceholder('Connection name').fill(name);
  await window.locator('select').selectOption('livefolder');
  await window.getByTestId('livefolder-path-input').fill(liveFolderDir);
  await window.getByRole('button', { name: 'Add' }).click();
  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).toBeVisible();
}

test('live folder board lists the fixture feature task', async () => {
  await addLiveFolderConnection('e2e-livefolder');

  await window.locator('[data-testid="nav-board"]').click();
  const boardItem = window.locator('[data-testid="board-nav-item"]', { hasText: '(Live)' });
  await expect(boardItem).toBeVisible();
  await boardItem.click();

  const issueCard = window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' });
  await expect(issueCard).toBeVisible();
});

test('transitioning a live folder issue writes the new status back to markdown', async () => {
  await addLiveFolderConnection('e2e-livefolder');
  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: '(Live)' }).click();
  await window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' }).click();

  await window.getByRole('button', { name: 'Move to Done' }).click();
  await expect(window.getByText(/·\s*Done\s*·/)).toBeVisible();

  const taskPath = path.join(liveFolderDir, 'features', 'feature-01-demo-feature', 'task-01-01-do-the-thing.md');
  await expect
    .poll(() => fs.readFileSync(taskPath, 'utf-8'))
    .toMatch(/\*\*Status:\*\*.*Complete/);
});

test('adding a comment on a live folder issue writes it back to markdown', async () => {
  await addLiveFolderConnection('e2e-livefolder');
  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: '(Live)' }).click();
  await window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' }).click();

  const commentBody = `e2e live folder comment ${Date.now()}`;
  await window.getByPlaceholder('Add a comment…').fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect(window.locator(`text=${commentBody}`)).toBeVisible();

  const taskPath = path.join(liveFolderDir, 'features', 'feature-01-demo-feature', 'task-01-01-do-the-thing.md');
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toContain(commentBody);
});
