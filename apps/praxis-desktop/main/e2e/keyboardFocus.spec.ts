import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * Keyboard focus must stay visible.
 *
 * `theme.css` ends with one global `:focus-visible` ring, and component rules
 * are not allowed to swallow it with a bare `outline: none`. That invariant had
 * already eroded once — 26 outline resets against 15 `:focus-visible` rules,
 * while `:hover` was styled 91 times — which is invisible in a screenshot and
 * only bites the people who drive this app from the keyboard.
 *
 * These tests tab through real controls and assert the focused element actually
 * paints something. They are deliberately behavioural rather than a grep: a rule
 * can exist and still lose the cascade.
 *
 * Proven non-vacuous: an earlier draft still passed with the global ring
 * deleted, because removing the `outline: none` resets let the browser's own
 * default outline satisfy it. Anchored on the real regression it fails as it
 * should — `controls focused with no visible ring: button[Filter],
 * button[Search boards]`. Re-prove it that way if you change what these assert.
 */

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
});

test.afterEach(async () => {
  await closeTestApp(app);
});

/** The computed outline on whatever currently holds focus. */
async function focusedOutline(app: TestApp): Promise<{ tag: string; testId: string; outline: string; width: string }> {
  return app.window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) {
      return { tag: 'none', testId: '', outline: '', width: '0px' };
    }
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '',
      outline: style.outlineStyle,
      width: style.outlineWidth
    };
  });
}

test('every control reached by Tab paints a visible focus ring', async () => {
  const page = app.window;
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

  // Walk a real run of the shell's tab order rather than one hand-picked
  // control — the regression this guards against was scattered, not local.
  const unfocused: string[] = [];
  for (let step = 0; step < 25; step += 1) {
    await page.keyboard.press('Tab');
    const focused = await focusedOutline(app);
    if (focused.tag === 'none') continue;
    // The terminal canvas opts out on purpose: it draws its own cursor.
    if (focused.tag === 'canvas') continue;
    const painted = focused.outline !== 'none' && focused.width !== '0px';
    if (!painted) {
      unfocused.push(`${focused.tag}${focused.testId ? `[${focused.testId}]` : ''}`);
    }
  }

  expect(unfocused, `controls focused with no visible ring: ${unfocused.join(', ')}`).toEqual([]);
});

test('the ring is themed, and pointer clicks stay quiet', async () => {
  const page = app.window;
  const button = page.getByRole('button', { name: 'Toggle secondary sidebar' });
  await expect(button).toBeVisible();

  // Clicking is a pointer interaction: `:focus-visible` must not fire, or every
  // click would leave a ring behind.
  await button.click();
  const afterClick = await button.evaluate(el => getComputedStyle(el).outlineStyle);
  expect(afterClick).toBe('none');

  // Keyboard focus on the same control must paint, in the theme's accent.
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await button.evaluate(el => {
    const style = getComputedStyle(el);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.appendChild(probe);
    const resolvedAccent = getComputedStyle(probe).color;
    probe.remove();
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, resolvedAccent };
  });
  expect(ring.style).toBe('solid');
  expect(ring.width).toBe('2px');
  expect(ring.color).toBe(ring.resolvedAccent);
});
