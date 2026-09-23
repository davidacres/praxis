import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * Every icon-only control has a tooltip saying what it does.
 *
 * A glyph alone means nothing until someone has learnt it. `ui/iconButtonTooltips.ts`
 * shows an icon-only control's accessible name (`aria-label`) as its tooltip, so the
 * one thing that can still go wrong is a control with neither visible text, a `title`,
 * nor an accessible name. This walks the main screens and fails on any such control,
 * naming each so it can be fixed at its call site.
 */

test.slow();

let app: TestApp;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
});

interface Untitled {
  where: string;
  html: string;
}

/** Visible icon-only controls on the page that would show no tooltip. */
async function untitledIconControls(page: Page, where: string): Promise<Untitled[]> {
  const found = await page.evaluate(() => {
    const visibleText = (element: Element): string => {
      let text = '';
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest('.sr-only')) continue;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        text += node.textContent ?? '';
      }
      return text.trim();
    };
    const name = (element: Element): string => {
      const own = element.getAttribute('title') || element.getAttribute('aria-label') || '';
      if (own.trim()) return own.trim();
      const ids = element.getAttribute('aria-labelledby');
      return ids ? ids.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim() : '';
    };
    return [...document.querySelectorAll('button, [role="button"], a[href]')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        // A decorative element outside the accessibility tree is not a control a person reaches.
        if (element.closest('[aria-hidden="true"]')) return false;
        return !visibleText(element) && !name(element);
      })
      .map(element => {
        const clone = element.cloneNode(true) as Element;
        clone.querySelectorAll('svg').forEach(svg => svg.replaceWith('<svg/>'));
        const parent = element.parentElement;
        return `${clone.outerHTML.slice(0, 220)}  ⟵ in .${(parent?.className || parent?.tagName || '').toString().split(' ').join('.')}`;
      });
  });
  return found.map(html => ({ where, html }));
}

async function seedProjectWithWorkflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Tooltip Project',
        key: 'TIP',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'backlog', name: 'Backlog' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: project.id, feature: 'workflows' })
    );
  });
  await page.reload();
}

test('every visible icon-only control on the main screens has a tooltip', async () => {
  app = await launchTestApp();
  const page = app.window;
  const missing: Untitled[] = [];
  const audit = async (where: string) => {
    await page.waitForTimeout(300);
    missing.push(...(await untitledIconControls(page, where)));
  };

  await audit('new session');

  await page.locator('[data-testid="board-nav-item"]').first().click();
  await page.locator('[data-testid="issue-card"]').first().waitFor();
  await audit('board');
  await page.locator('[data-testid="titlebar-context"]').click();
  await page.locator('[data-testid="board-filter-bar"]').waitFor();
  await audit('board filters');
  await page.keyboard.press('Escape');

  await page.locator('[data-testid="issue-card"]').first().click();
  await audit('issue detail');
  await page.keyboard.press('Escape');

  await page.locator('[data-testid="board-new-issue-btn"]').click();
  await audit('new issue');

  await page.getByLabel('Toggle panel').click();
  await page.getByTestId('integrated-terminal').waitFor();
  await audit('terminal panel');
  await page.getByLabel('Toggle panel').click();

  await page.getByTestId('titlebar-settings').click();
  const nav = page.locator('[data-testid^="settings-nav-"]');
  await nav.first().waitFor();
  // Every page, not the group headers (clicking one of those collapses it).
  const pages = (await nav.evaluateAll(items => items.map(item => item.getAttribute('data-testid') ?? ''))).filter(id => !id.endsWith('-group'));
  expect(pages.length).toBeGreaterThan(10);
  for (const id of pages) {
    const item = page.getByTestId(id);
    if (!(await item.isVisible())) continue;
    await item.click();
    await audit(`settings: ${id.replace('settings-nav-', '')}`);
  }
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();

  await page.getByTestId('nav-agents').click();
  await audit('agent hub');

  await seedProjectWithWorkflow(page);
  await page.getByRole('button', { name: 'New workflow in Tooltip Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await audit('new workflow dialog');
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).click();
  await dialog.getByRole('button', { name: /^Use/ }).click();
  await expect(dialog).toBeHidden();
  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await audit('workflow designer');
  await canvas.locator('[data-testid^="wf-canvas-edge-line-"]').first().click({ force: true });
  await audit('workflow designer: connection');

  const report = missing.map(entry => `[${entry.where}] ${entry.html}`).join('\n');
  expect(missing, `Icon-only controls with no tooltip or accessible name:\n${report}`).toEqual([]);
});

test('an icon-only button shows its accessible name as its tooltip', async () => {
  app = await launchTestApp();
  const page = app.window;
  // The panel toggle has an aria-label and no title of its own.
  const toggle = page.getByLabel('Toggle panel');
  expect(await toggle.getAttribute('title')).toBeNull();
  await toggle.hover();
  await expect(toggle).toHaveAttribute('title', 'Toggle panel');

  // An explicit title is never overwritten.
  const explicit = page.locator('button[title][aria-label]:not([data-auto-title])').first();
  const before = await explicit.getAttribute('title');
  await explicit.hover();
  await expect(explicit).toHaveAttribute('title', before!);
});
