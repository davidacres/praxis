import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGadgetFenceMessage } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openFromPalette } from './navigation';
import { openSession } from './sessionNavigation';

/**
 * The Artifacts page lists everything saved for a project: Save on a chat
 * artifact copies it into the project's artifacts folder in the *main*
 * checkout (even from a worktree session) and remembers its title and source
 * session; files added by hand show too.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

const PICTURE = fs.readFileSync(path.resolve(__dirname, '../../renderer/src/assets/praxis-icon-v3.png'));

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
  app = undefined;
  mock = undefined;
  repo = undefined;
});

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-artifacts-page-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Praxis Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'praxis@example.test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('saved artifacts land in the main checkout and are listed, previewed and deleted on the Artifacts page', async () => {
  repo = initRepo();
  const gadget = {
    type: 'gadget' as const,
    blockId: 'artifacts-page-block',
    gadget: {
      version: 1,
      kind: 'artifact',
      gadgetId: 'artifacts-page-evidence',
      payload: {
        title: 'Login fix evidence',
        artifacts: [
          { name: 'Login verification', path: '.praxis/session-artifacts/login-report.md', mediaType: 'text/markdown', description: 'What was checked after the fix' },
          { name: 'Login screen', path: '.praxis/session-artifacts/login-screen.png', mediaType: 'image/png' }
        ]
      },
      actions: []
    }
  };
  mock = await startMockGatewayServer({ mode: 'complete', reply: buildGadgetFenceMessage([gadget], 'Evidence attached.') });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-artifacts-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  const projectId = await win.evaluate(async folderPath => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    const project = await window.praxis.projects.create({
      name: 'Artifact Home', key: 'ARTF', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath,
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [], defaultAiToolMode: 'full'
    }, workspaceId);
    return project.id;
  }, repo);
  const record = await win.evaluate(async ({ projectId, workingDirectory }) => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    toolMode: 'full',
    projectId,
    workingDirectory,
    runInWorktree: true,
    task: { goal: 'Fix the login page' }
  }), { projectId, workingDirectory: repo });
  expect(record.worktreePath).toBeTruthy();

  // The agent wrote its evidence inside its worktree.
  const worktreeArtifacts = path.join(record.worktreePath!, '.praxis', 'session-artifacts');
  fs.mkdirSync(worktreeArtifacts, { recursive: true });
  fs.writeFileSync(path.join(worktreeArtifacts, 'login-report.md'), '# Login verification\n\nThe **login** page renders.');
  fs.writeFileSync(path.join(worktreeArtifacts, 'login-screen.png'), PICTURE);

  await win.reload();
  await openSession(win, 'Fix the login page');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  const saves = win.locator('[data-testid="gadget-artifact-save"]');
  await saves.nth(0).click();
  await expect(saves.nth(0)).toHaveText('Saved');
  await saves.nth(1).click();
  await expect(saves.nth(1)).toHaveText('Saved');

  // Saved into the main checkout, byte for byte — not onto the worktree's branch.
  const published = path.join(repo, 'docs', 'published-artifacts');
  expect(fs.readFileSync(path.join(published, 'login-report.md'), 'utf8')).toContain('The **login** page renders.');
  expect(fs.readFileSync(path.join(published, 'login-screen.png')).equals(PICTURE)).toBe(true);
  expect(fs.existsSync(path.join(record.worktreePath!, 'docs', 'published-artifacts'))).toBe(false);

  // Files added by hand are listed too.
  fs.mkdirSync(path.join(published, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(published, 'notes', 'by-hand.txt'), 'written by a person');
  fs.writeFileSync(path.join(published, 'dashboard.html'), [
    '<!doctype html><html><head><style>',
    'body{margin:0;font:600 48px system-ui;background:#1f4e79;color:#fff}',
    'header{padding:48px}',
    '</style></head><body><header>Release dashboard</header></body></html>'
  ].join(''));

  // The title bar opens the active project's Artifacts page.
  await win.locator('[data-testid="titlebar-artifacts"]').click();
  const page = win.locator('[data-testid="artifacts-page"]');
  await expect(page.locator('[data-testid="artifacts-folder"]')).toContainText('docs/published-artifacts');
  const cards = page.locator('[data-testid="artifact-card"]');
  await expect(cards).toHaveCount(4);
  // Saved artifacts carry the gadget's names and their session. Newest first:
  // the files added by hand after both saves lead.
  const titles = await page.locator('[data-testid="artifact-card-title"]').allTextContents();
  expect(titles.slice(0, 2).sort()).toEqual(['by-hand.txt', 'dashboard.html']);
  expect(titles.slice(2).sort()).toEqual(['Login screen', 'Login verification']);
  await expect(cards.filter({ hasText: 'Login screen' })).toContainText('Fix the login page');
  await expect(cards.filter({ hasText: 'Login screen' }).locator('img')).toBeVisible();
  await expect(win.locator('[data-testid="titlebar-artifacts"]')).toHaveAttribute('aria-pressed', 'true');

  // A page shows a rendered snapshot of its top, cached for next time.
  const pageThumb = cards.filter({ hasText: 'dashboard.html' }).locator('[data-testid="artifact-card-page-thumb"]');
  await expect(pageThumb).toBeVisible({ timeout: 15000 });
  expect(await pageThumb.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(480);
  // The snapshot is the page's own colours, not a blank capture.
  const pixel = await pageThumb.evaluate(img => {
    const image = img as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(5, canvas.height - 5, 1, 1).data.slice(0, 3));
  });
  expect(Math.abs(pixel[0] - 0x1f) + Math.abs(pixel[1] - 0x4e) + Math.abs(pixel[2] - 0x79)).toBeLessThan(30);
  expect(fs.readdirSync(path.join(app.userDataDir, 'artifact-thumbnails'))).toHaveLength(1);

  // Filters and search narrow the grid.
  await page.locator('[data-testid="artifacts-filter-image"]').click();
  await expect(cards).toHaveCount(1);
  await page.locator('[data-testid="artifacts-filter-page"]').click();
  await expect(cards).toHaveCount(1);
  await page.locator('[data-testid="artifacts-filter-all"]').click();
  await page.locator('[data-testid="artifacts-search"]').fill('by-hand');
  await expect(cards).toHaveCount(1);
  await page.locator('[data-testid="artifacts-search"]').fill('');

  // Opening one shows the file itself, with its saved description.
  await cards.filter({ hasText: 'Login verification' }).click();
  const viewer = page.locator('[data-testid="artifacts-viewer"]');
  await expect(viewer.locator('[data-testid="artifacts-viewer-title"]')).toHaveText('Login verification');
  await expect(viewer).toContainText('What was checked after the fix');
  await expect(viewer.locator('[data-testid="artifact-preview-markdown"] strong')).toHaveText('login');
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/artifacts-page.png') });

  await cards.filter({ hasText: 'Login screen' }).click();
  await expect(viewer.locator('[data-testid="artifact-preview-image"] img')).toBeVisible();

  // Its session is one click away.
  await viewer.locator('[data-testid="artifacts-open-session"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed');

  // Deleting asks first, then removes the file and the card. (Back via ⌘K.)
  await openFromPalette(win, 'Artifact Home: Artifacts');
  await cards.filter({ hasText: 'by-hand.txt' }).click();
  await expect(viewer.locator('[data-testid="artifact-preview-text"]')).toContainText('written by a person');
  await viewer.locator('[data-testid="artifacts-delete"]').click();
  await win.getByRole('dialog', { name: 'Delete by-hand.txt?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(cards).toHaveCount(3);
  expect(fs.existsSync(path.join(published, 'notes', 'by-hand.txt'))).toBe(false);
  await expect(viewer).toBeHidden();

  // Paths outside the artifacts folder are refused.
  const refused = await win.evaluate(async id => {
    try {
      await window.praxis.artifacts.readText(id, 'README.md');
      return 'read';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, projectId);
  expect(refused).toContain('outside the project');
});

test('pages are named by their title, cards drag into groups, and a group can be added to a chat', async () => {
  repo = initRepo();
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'Ready when you are.' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-artifacts-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const published = path.join(repo, 'docs', 'published-artifacts');
  fs.mkdirSync(published, { recursive: true });
  fs.writeFileSync(path.join(published, 'dashboard.html'),
    '<!doctype html><html><head><title>Release dashboard</title></head><body style="background:#1f4e79"><h1>Q4</h1></body></html>');
  fs.writeFileSync(path.join(published, 'notes.md'), '# Rollout notes\n\nShip on Tuesday.');
  fs.writeFileSync(path.join(published, 'shot.png'), PICTURE);

  const projectId = await win.evaluate(async folderPath => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    return (await window.praxis.projects.create({
      name: 'Artifact Home', key: 'ARTF', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath,
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [], defaultAiToolMode: 'full'
    }, workspaceId)).id;
  }, repo);
  await win.evaluate(async ({ projectId, workingDirectory }) => window.praxis.ai.delegate({
    provider: 'vercel-gateway', toolMode: 'full', projectId, workingDirectory, task: { goal: 'Plan the release' }
  }), { projectId, workingDirectory: repo });
  await win.reload();
  await openSession(win, 'Plan the release');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  await win.locator('[data-testid="titlebar-artifacts"]').click();
  const page = win.locator('[data-testid="artifacts-page"]');
  const card = (title: string) => page.locator('[data-testid="artifact-card-item"]').filter({ hasText: title });
  // A page is named by its own <title>, not its file name.
  await expect(card('Release dashboard')).toHaveCount(1);
  await expect(page.locator('[data-testid="artifact-card-title"]', { hasText: 'dashboard.html' })).toHaveCount(0);

  // Hover actions appear over the card, and are reachable by keyboard too.
  const actions = card('notes.md').locator('.artifact-card-actions');
  await expect(actions).toHaveCSS('opacity', '0');
  await card('notes.md').hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect(card('Release dashboard').locator('[data-testid="artifact-card-page-thumb"]')).toBeVisible({ timeout: 15000 });
  await card('Release dashboard').locator('[data-testid="artifact-card-add-to-chat"]').focus();
  await expect(card('Release dashboard').locator('.artifact-card-actions')).toHaveCSS('opacity', '1');
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/artifacts-hover-actions.png') });

  // Dragging one card onto another makes a group; dragging onto the group adds to it.
  await card('notes.md').dragTo(card('shot.png'));
  const groupCard = page.locator('[data-testid="artifact-group-card"]');
  await expect(groupCard).toHaveCount(1);
  await expect(groupCard).toContainText('New group');
  await expect(groupCard).toContainText('2 artifacts');
  await card('Release dashboard').dragTo(groupCard);
  await expect(groupCard).toContainText('3 artifacts');
  await expect(page.locator('[data-testid="artifact-card-item"]')).toHaveCount(0);
  // Every tile in the group's stack fills its quarter of the thumbnail.
  const tiles = await groupCard.locator('.artifact-group-stack > .artifact-card-thumb').evaluateAll(nodes =>
    nodes.map(node => Math.round(node.getBoundingClientRect().height)));
  expect(tiles).toHaveLength(3);
  expect(new Set(tiles).size).toBe(1);
  await win.mouse.move(0, 0);
  await expect(groupCard.locator('.artifact-card-actions')).toHaveCSS('opacity', '0');
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/artifacts-group.png') });

  // Inside the group: rename it, and it stays renamed.
  await groupCard.locator('.artifact-card').click();
  await expect(page.locator('[data-testid="artifacts-group-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-card-item"]')).toHaveCount(3);
  const name = page.locator('[data-testid="artifacts-group-name"]');
  await name.fill('Release kit');
  await name.press('Enter');
  await page.locator('[data-testid="artifacts-group-back"]').click();
  await expect(groupCard).toContainText('Release kit');

  // Add the whole group to the chat: it waits as a chip; nothing is sent.
  const requestsBefore = mock.requests.length;
  await groupCard.hover();
  await groupCard.locator('[data-testid="artifact-group-add-to-chat"]').click();
  const dialog = win.locator('[data-testid="artifact-send-dialog"]');
  await expect(dialog).toContainText('Release kit');
  await expect(dialog.locator('[data-testid="artifact-send-destination"]')).toContainText('Plan the release');
  await dialog.locator('[data-testid="artifact-send-confirm"]').click();
  const chip = win.locator('[data-testid="session-context-reference"]');
  await expect(chip).toHaveText('Artifacts: Release kit (3 files)');
  await expect(win.locator('[data-testid="session-follow-up-input"]')).toHaveValue('');
  expect(mock.requests.length).toBe(requestsBefore);

  // Sending a message carries the artifacts' content and paths to the model.
  await win.locator('[data-testid="session-follow-up-input"]').fill('Summarise these');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect.poll(() => mock!.requests.length).toBeGreaterThan(requestsBefore);
  const sent = JSON.stringify(mock.requests.slice(requestsBefore));
  expect(sent).toContain('Ship on Tuesday.');
  expect(sent).toContain('docs/published-artifacts/shot.png');
  expect(sent).toContain('Release dashboard');

  // Ungrouping keeps the files.
  await win.locator('[data-testid="titlebar-artifacts"]').click();
  await groupCard.hover();
  await groupCard.locator('[data-testid="artifact-group-ungroup"]').click();
  await expect(groupCard).toHaveCount(0);
  await expect(page.locator('[data-testid="artifact-card-item"]')).toHaveCount(3);
});
