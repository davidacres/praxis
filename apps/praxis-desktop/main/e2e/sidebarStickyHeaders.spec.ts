import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * The top sidebar panel's tree headers stick as it scrolls, nested: the project row sticks below the
 * "Projects" heading, a subsection (docs) below the project, `plans` below docs, a document-type group
 * below plans. Measured, not eyeballed — each stuck header's top must meet its parent's bottom exactly
 * (a gap lets rows show through, an overlap hides a border), and the rows scrolled beneath must not
 * change the tree's indentation.
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

test('tree headers stick nested beneath their parents as the top sidebar panel scrolls', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-sticky-repo-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  const plans = path.join(repo, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  // Enough documents that the "STORY" group alone is taller than the sidebar.
  for (let i = 1; i <= 40; i += 1) {
    const type = i <= 6 ? 'Bug' : 'Story';
    fs.writeFileSync(path.join(plans, `plan-${String(i).padStart(2, '0')}.md`), `# Plan ${i}\n\n**Status:** Proposed\n**Type:** ${type}\n`);
  }
  git('add', '.');
  git('commit', '-m', 'initial');

  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      { name: 'Sticky Project', key: 'STK', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only' },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id }));
  }, repo);
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByTestId('project-document-nav-item').first()).toBeVisible({ timeout: 15000 });

  const scroll = page.locator('.sidebar-scroll');
  const tree = page.locator('.project-tree').filter({ hasText: 'Sticky Project' });
  const projectsHeading = page.locator('.sidebar-scroll > .sidebar-section-heading').first();
  const projectRow = tree.locator('.project-tree-parent');
  const docs = tree.getByTestId('project-docs-nav-item');
  const plansFolder = tree.getByTestId('project-plans-nav-item');
  const storyGroup = tree.getByTestId('project-document-type-nav-item').filter({ hasText: /story/i });
  const firstStoryDoc = tree.locator('.project-document-group')
    .filter({ has: page.getByTestId('project-document-type-nav-item').filter({ hasText: /story/i }) })
    .getByTestId('project-document-nav-item').first();

  const box = async (locator: typeof scroll) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error('not rendered');
    return { top: Math.round(b.y), bottom: Math.round(b.y + b.height), left: Math.round(b.x) };
  };
  const docLeftBefore = (await box(firstStoryDoc)).left;
  const fillOf = (locator: typeof scroll) => locator.evaluate(el => getComputedStyle(el, '::after').backgroundColor);
  const transparent = /^rgba\(0, 0, 0, 0\)$|^transparent$/;

  // At rest (nothing scrolled beneath it) a header paints no fill, so the tree looks exactly as it did
  // before headers were sticky — no band over the pane's grain, no break in the connector line.
  expect(await fillOf(docs)).toMatch(transparent);
  expect(await fillOf(storyGroup)).toMatch(transparent);

  // Mid-scroll, as the STORY group arrives: the BUGS group has ended, so its header is pushed up
  // out of the way rather than left stuck beneath its successor.
  const bugsGroup = tree.getByTestId('project-document-type-nav-item').filter({ hasText: /bug/i });
  await storyGroup.evaluate(el => { el.scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(200);
  await page.locator('.sidebar').screenshot({ path: test.info().outputPath('sticky-handover.png') });
  expect((await box(bugsGroup)).bottom).toBeLessThanOrEqual((await box(storyGroup)).top);

  // Scroll deep into the STORY group: every ancestor header should be stuck, stacked.
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 200; });
  await page.waitForTimeout(200);
  await page.locator('.sidebar').screenshot({ path: test.info().outputPath('sticky-deep.png') });

  const scrollTop = (await box(scroll)).top;
  const h0 = await box(projectsHeading);
  const h1 = await box(projectRow);
  const h2 = await box(docs);
  const h3 = await box(plansFolder);
  const h4 = await box(storyGroup);
  expect(h0.top).toBe(scrollTop);
  expect(h1.top).toBe(h0.bottom);
  expect(h2.top).toBe(h1.bottom);
  expect(h3.top).toBe(h2.bottom);
  expect(h4.top).toBe(h3.bottom);

  // Stuck headers are on top (the element under a stuck header's centre is the header) and opaque, so
  // the rows travelling beneath them never show through.
  for (const header of [projectsHeading, projectRow, docs, plansFolder, storyGroup]) {
    const state = await header.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { onTop: !!hit && el.contains(hit), fill: getComputedStyle(el, '::after').backgroundColor };
    });
    expect(state.onTop).toBe(true);
    expect(state.fill).not.toMatch(transparent);
  }

  // Sticking changes nothing horizontal: rows keep their indent.
  expect((await box(tree.getByTestId('project-document-nav-item').last())).left).toBe(docLeftBefore);

  // A stuck header still works: collapsing the STORY group from its stuck position collapses it.
  await storyGroup.click();
  await expect(storyGroup).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.sidebar').screenshot({ path: test.info().outputPath('sticky-after-collapse.png') });
});
