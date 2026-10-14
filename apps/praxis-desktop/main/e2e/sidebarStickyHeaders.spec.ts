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
  await page.locator('.project-tree').filter({ hasText: 'Sticky Project' }).getByTestId('project-docs-toggle').click();
  await expect(page.getByTestId('project-document-nav-item').first()).toBeVisible({ timeout: 15000 });

  const scroll = page.locator('.sidebar-scroll');
  const tree = page.locator('.project-tree').filter({ hasText: 'Sticky Project' });
  const projectsHeading = page.locator('.sidebar-scroll > .projects-section-header').first();
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
  await tree.getByTestId('project-document-nav-item').nth(25).evaluate(el => { el.scrollIntoView({ block: 'start' }); });
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

  // Section headers in the lower half of the project (Sessions' recency buckets, Team Chats) used to
  // inherit top: 0 / z-index: 5 from the footer chrome, covering Projects instead of stacking below
  // it. This project has no sessions, so no buckets render; the last section header stands in (the
  // bucket headers themselves are measured by the next test).
  await page.setViewportSize({ width: 1280, height: 500 });
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const category = tree.locator('.project-sidebar-section > .feature-section-header').last();
  const categoryBox = await box(category);
  // Once its section ends, the header is pushed up: out of view, or sliding away *beneath* the stuck
  // project row — never over it.
  const rowBox = await box(projectRow);
  if (categoryBox.top < rowBox.bottom && categoryBox.bottom > (await box(scroll)).top) {
    expect(await projectRow.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.bottom - 2));
    }), 'a header handing over must slide beneath the project row').toBe(true);
  }
  expect(await projectsHeading.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })).toBe(true);
  await page.locator('.sidebar').screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'sidebar-sticky-section-handover.png') });

  await page.setViewportSize({ width: 1280, height: 720 });
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 200; });
  await page.waitForTimeout(200);

  // A stuck header still works: collapsing the STORY group from its stuck position collapses it.
  await storyGroup.click();
  await expect(storyGroup).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.sidebar').screenshot({ path: test.info().outputPath('sticky-after-collapse.png') });
});

test('recency buckets stack below the project row and hand over within their own lists', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const projectId = await app.window.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Session Stack', key: 'STACK', type: 'research', purpose: '', brief: {},
      startingPoint: 'app-storage', workflowStages: [{ id: 'backlog', name: 'Backlog', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }], defaultAiToolMode: 'read-only'
    }, workspace.id);
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    return project.id;
  });
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  // Sessions group by recency (Today / This week / Last week): half today, half three days ago,
  // so there are two long buckets to stick and hand over between.
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const records: Record<string, unknown> = {};
  for (let i = 0; i < 80; i += 1) {
    const issueKey = i < 40 ? `SESSION-${i.toString(16).padStart(6, '0')}` : `STACK-${i}`;
    const at = i < 40 ? now : threeDaysAgo;
    records[issueKey] = { issueKey, sessionId: `stack-${i}`, projectId, title: `Sticky session ${i}`,
      state: 'completed', provider: 'claude', model: 'test', startedAt: at, completedAt: at,
      taskDefinition: { goal: `Session ${i}` }, events: [] };
  }
  fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': records }));
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  const page = app.window;
  await page.setViewportSize({ width: 1280, height: 720 });
  const tree = page.getByTestId('project-tree').filter({ hasText: 'Session Stack' });
  const projects = page.locator('.projects-section-header');
  const project = tree.locator('.project-tree-parent');
  const categories = tree.locator('.project-session-category');
  await expect(categories.first().locator('.session-nav-row')).toHaveCount(40);
  const bottom = (el: Element) => el.getBoundingClientRect().bottom;
  for (const index of [0, 1]) {
    const group = categories.nth(index);
    await group.locator('.session-nav-row').nth(20).evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(200);
    const header = group.locator('.project-session-category-header');
    expect(Math.round(await project.evaluate(el => el.getBoundingClientRect().top))).toBe(Math.round(await projects.evaluate(bottom)));
    // A recency bucket's header sticks straight under the project row (there is no Sessions header between).
    expect(Math.round(await header.evaluate(el => el.getBoundingClientRect().top))).toBe(Math.round(await project.evaluate(bottom)));
    for (const ancestor of [projects, project, header]) {
      const hitState = await ancestor.evaluate(el => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { onTop: el.contains(hit), header: el.className, hit: hit?.outerHTML };
      });
      expect(hitState.onTop, JSON.stringify(hitState)).toBe(true);
    }
    if (index === 1) {
      expect(await categories.first().evaluate(bottom)).toBeLessThanOrEqual(await header.evaluate(el => el.getBoundingClientRect().top));
      await page.locator('.sidebar').screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'sidebar-sticky-sessions.png') });
      await header.getByTestId('project-session-bucket-this-week').click();
      await expect(header.getByTestId('project-session-bucket-this-week')).toHaveAttribute('aria-expanded', 'false');
    }
  }
});
