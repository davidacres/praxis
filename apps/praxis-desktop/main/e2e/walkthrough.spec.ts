import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * The first-run walkthrough. It annotates the user's real project rather than
 * seeding a demo one, so these tests create a project and then drive the tour
 * over the controls the shell already renders.
 *
 * The two properties that matter most: the highlighted control stays clickable
 * (a tour that traps the user is worse than no tour), and a stop whose target
 * is missing is skipped rather than shown empty.
 */

let app: TestApp;

/**
 * The ring must actually enclose the control the callout is describing. This
 * caught a real bug: transitioning the ring's geometry left it lagging a stop
 * behind, pointing at the previous control while the callout had moved on.
 */
async function expectRingWraps(page: TestApp['window'], selector: string): Promise<void> {
  const boxes = await page.evaluate(target => {
    const ring = document.querySelector('.walkthrough-ring');
    const element = document.querySelector(target);
    if (!ring || !element) return undefined;
    const r = ring.getBoundingClientRect();
    const t = element.getBoundingClientRect();
    return { r: { top: r.top, left: r.left, right: r.right, bottom: r.bottom }, t: { top: t.top, left: t.left, right: t.right, bottom: t.bottom } };
  }, selector);
  expect(boxes, `ring or target missing for ${selector}`).toBeTruthy();
  const { r, t } = boxes!;
  expect(r.left).toBeLessThanOrEqual(t.left);
  expect(r.top).toBeLessThanOrEqual(t.top);
  expect(r.right).toBeGreaterThanOrEqual(t.right);
  expect(r.bottom).toBeGreaterThanOrEqual(t.bottom);
}

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  await app.window.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Tour Project',
        key: 'TOUR',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First slice', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'project-only'
      },
      workspace.id
    );
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('walks the shell, rings each control, and remembers it was seen', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-dashboard')).toBeVisible();

  await page.getByTestId('project-getstarted-tour').click();
  const callout = page.getByTestId('walkthrough-callout');
  await expect(callout).toBeVisible();
  await expect(callout).toContainText('Your project lives here');
  // One ring, over the control being described.
  await expect(page.locator('.walkthrough-ring')).toHaveCount(1);
  await expectRingWraps(page, '[data-testid="project-nav-item"]');

  await page.getByTestId('walkthrough-next').click();
  await expect(callout).toContainText('Work sits on the board');
  await expectRingWraps(page, '[data-testid="board-nav-item"]');
  await page.getByTestId('walkthrough-next').click();
  await expect(callout).toContainText('Hand a ticket to an agent');
  await expectRingWraps(page, '[data-testid="project-getstarted-start"]');
  await page.getByTestId('walkthrough-next').click();
  await expect(callout).toContainText('Bring in your real tickets');
  await expectRingWraps(page, '[data-testid="nav-connections"]');

  // Last stop offers a close, not another Next.
  await expect(page.getByTestId('walkthrough-next')).toHaveCount(0);
  await page.getByTestId('walkthrough-done').click();
  await expect(callout).toHaveCount(0);
  await expect(page.locator('.walkthrough-ring')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('praxis-walkthrough-seen'))).toBe('1');
});

/**
 * Proven non-vacuous by restoring the old `2px solid var(--focus-ring)` ring and
 * watching this fail (`Expected: "dashed" / Received: "solid"`).
 */
test('the ring is visibly not a control, and not the focus ring', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
  await page.getByTestId('project-getstarted-tour').click();
  await expect(page.getByTestId('walkthrough-callout')).toBeVisible();

  const style = await page.evaluate(() => {
    const ring = getComputedStyle(document.querySelector('.walkthrough-ring')!);
    const callout = getComputedStyle(document.querySelector('.walkthrough-callout')!);
    const root = getComputedStyle(document.documentElement);
    const resolve = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    return {
      borderStyle: ring.borderTopStyle,
      borderColor: ring.borderTopColor,
      calloutTop: callout.borderTopColor,
      calloutSide: callout.borderLeftColor,
      tour: resolve(root.getPropertyValue('--tone-tour').trim()),
      accent: resolve(root.getPropertyValue('--accent').trim()),
      focusRing: resolve(root.getPropertyValue('--focus-ring').trim())
    };
  });
  // Dashed, so it reads as an annotation drawn over the app rather than a
  // border on a control.
  expect(style.borderStyle).toBe('dashed');
  // And in a hue the chrome never uses — a solid accent ring was both a fourth
  // meaning for the accent and indistinguishable from the keyboard focus ring.
  expect(style.borderColor).not.toBe(style.accent);
  expect(style.borderColor).not.toBe(style.focusRing);
  // The callout carries the same hue on its top edge and nowhere else, so the
  // ring and its label read as one annotation. This caught a real cascade bug:
  // `border-top` sat above the `border` shorthand, which reset all four sides
  // and left the callout unbranded.
  expect(style.calloutTop).toBe(style.tour);
  expect(style.calloutSide).not.toBe(style.tour);
});

test('the ring never blocks the control it highlights', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
  await page.getByTestId('project-getstarted-tour').click();
  await expect(page.getByTestId('walkthrough-callout')).toBeVisible();

  // Stop 1 rings the sidebar project row — which must still be clickable while
  // the tour is open, so the highlight cannot be an interaction trap.
  const ring = page.locator('.walkthrough-ring');
  await expect(ring).toHaveCSS('pointer-events', 'none');
  await page.getByTestId('project-nav-item').first().click();
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
});

test('Escape dismisses the tour, and that counts as seen', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
  await page.getByTestId('project-getstarted-tour').click();
  await expect(page.getByTestId('walkthrough-callout')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('walkthrough-callout')).toHaveCount(0);
  // Escape is a dismissal, and dismissal is how the tour ends — so it counts.
  expect(await page.evaluate(() => localStorage.getItem('praxis-walkthrough-seen'))).toBe('1');
});

test('a stop whose target disappears mid-tour is skipped, not shown empty', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
  await page.getByTestId('project-getstarted-tour').click();

  const callout = page.getByTestId('walkthrough-callout');
  await expect(callout).toContainText('Your project lives here');
  await page.getByTestId('walkthrough-next').click();
  await expect(callout).toContainText('Work sits on the board');

  // Remove stop 3's target while the tour is open: the strip carries the
  // "Start a session" button the third stop rings.
  await page.getByTestId('project-getstarted').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('project-getstarted')).toHaveCount(0);

  // Next must land on stop 4, not on an empty stop 3.
  await page.getByTestId('walkthrough-next').click();
  await expect(callout).toContainText('Bring in your real tickets');
  await expect(callout).not.toContainText('Hand a ticket to an agent');
  await expect(page.locator('.walkthrough-ring')).toHaveCount(1);
});
