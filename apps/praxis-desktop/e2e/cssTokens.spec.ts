import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * `--border-subtle` and `--radius-xs` were referenced across theme.css without
 * ever being declared, so rules without a fallback lost their border / rounding
 * silently. Both must now resolve, and `--border-subtle` must follow each theme's
 * own `--border`.
 */
let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

test('--border-subtle follows the theme border and --radius-xs scales with the display', async () => {
  app = await launchTestApp();
  const page = app.window;

  const read = (themeAttrs: Record<string, string>) => page.evaluate(attrs => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(attrs)) root.setAttribute(key, value);
    const style = getComputedStyle(root);
    return {
      border: style.getPropertyValue('--border').trim(),
      subtle: style.getPropertyValue('--border-subtle').trim(),
      radiusXs: style.getPropertyValue('--radius-xs').trim(),
      probe: (() => {
        const el = document.createElement('div');
        el.style.cssText = 'border:1px solid var(--border-subtle);border-radius:var(--radius-xs)';
        document.body.appendChild(el);
        const computed = getComputedStyle(el);
        const result = { width: computed.borderTopWidth, radius: computed.borderTopLeftRadius };
        el.remove();
        return result;
      })()
    };
  }, themeAttrs);

  for (const mode of ['light', 'dark']) {
    const tokens = await read({ 'data-mode': mode });
    expect(tokens.subtle, `${mode}: --border-subtle resolves`).not.toBe('');
    expect(tokens.subtle).toBe(tokens.border);
    expect(tokens.radiusXs).not.toBe('');
    expect(tokens.probe.width).toBe('1px');
    expect(tokens.probe.radius).toBe('4px');
  }

  // A named palette overrides --border; the subtle border must track it.
  const dracula = await read({ 'data-theme': 'dracula-dark' });
  expect(dracula.border).toBe('#6272a4');
  expect(dracula.subtle).toBe('#6272a4');
});
