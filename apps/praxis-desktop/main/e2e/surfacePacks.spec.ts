import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/**
 * Phase 1 of Surface Packs — the premium material layer applied on the
 * `data-surface` axis, composed over whatever theme is active. The suite seeds
 * the shipped appearance defaults, so every launch starts on `parchment`.
 */
let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp({ appearance: DEFAULT_APP_SETTINGS.appearance });
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

/**
 * Navigate to Settings → Appearance → Surfaces from wherever the app is.
 *
 * Must be idempotent: several tests call it again after visiting another node,
 * and the titlebar button *toggles* Settings, so clicking it blindly would
 * close an already-open dialog. The Appearance group's children only exist in
 * the DOM while it is expanded, hence the separate expand step.
 */
async function openSurface(): Promise<void> {
  const surfaces = window.locator('[data-testid="settings-nav-appearance-surfaces"]');
  // The settings dialog toggles from the titlebar; the Appearance group is
  // expanded by default, so its children just need the dialog open.
  if (!(await surfaces.isVisible())) {
    await window.locator('[data-testid="titlebar-settings"]').click();
  }
  await surfaces.click();
  await window.locator('[data-testid="surface-section"]').scrollIntoViewIfNeeded();
  await expect(window.locator('[data-testid="surface-section"]')).toBeVisible();
}

/** Jump to the Themes node (its palette gallery) without leaving the open dialog. */
async function openThemesGallery(): Promise<void> {
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
}

/** Loads the pane's watermark tile as an image — proves the data URI is not CSP-blocked. */
async function watermarkLoads(): Promise<string> {
  return window.evaluate(async () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image').trim();
    if (!raw || raw === 'none') return 'NONE';
    const src = raw.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    return new Promise<string>(resolve => {
      const img = new Image();
      img.onload = () => resolve(`OK ${img.naturalWidth}x${img.naturalHeight}`);
      img.onerror = () => resolve('BLOCKED');
      img.src = src;
    });
  });
}

test('ships default-on with the Parchment surface over the Praxis theme', async () => {
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');
  await expect(window.locator('html')).toHaveAttribute('data-theme', DEFAULT_APP_SETTINGS.appearance.themeId);

  // The pack drives a real texture layer on the panel shells.
  const textureOpacity = await window.locator('.pane-main').evaluate(el =>
    parseFloat(getComputedStyle(el, '::after').opacity)
  );
  expect(textureOpacity).toBeGreaterThan(0);
});

test('the pack renders its hexagon watermark on every pane and the tile actually loads', async () => {
  // Regression guard for the CSP that silently blocked every `data:` image:
  // without `img-src … data:` the pattern and grain layers compute correctly
  // but never paint, so assert the tile decodes rather than just that it is set.
  expect(await watermarkLoads()).toMatch(/^OK /);

  for (const pane of ['.pane-sidebar', '.pane-main', '.pane-aux']) {
    const layer = await window.locator(pane).evaluate(el => {
      const before = getComputedStyle(el, '::before');
      return { image: before.backgroundImage, opacity: parseFloat(before.opacity) };
    });
    expect(layer.image, `${pane} watermark image`).toContain('svg');
    expect(layer.opacity, `${pane} watermark opacity`).toBeGreaterThan(0);
  }
});

test('built-in surfaces use their intended default pattern', async () => {
  await openSurface();
  const markup = () => window.evaluate(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-watermark-image').trim();
    return raw === 'none' ? 'none' : decodeURIComponent(raw);
  });

  await window.locator('[data-testid="surface-card-parchment"]').click();
  expect(await markup()).toContain('Z'); // hexagon

  await window.locator('[data-testid="surface-card-graphite"]').click();
  expect(await markup()).toContain('M-'); // diagonal lines cross tile edges

  await chooseOption(window.locator('[data-testid="motif-pattern"]'), 'grid');
  expect(await markup()).toContain('stroke-opacity="0.4"'); // drafting grid motif

  await chooseOption(window.locator('[data-testid="motif-pattern"]'), 'binary');
  expect(await markup()).toContain('<text');

  await window.locator('[data-testid="surface-card-aurora-glass"]').click();
  expect(await markup()).toBe('none');
});

test('selecting a surface restores its default motif after a custom override', async () => {
  await openSurface();
  await chooseOption(window.locator('[data-testid="motif-pattern"]'), 'grid');
  await expect(window.locator('[data-testid="motif-reset"]')).toBeVisible();

  await window.locator('[data-testid="surface-card-graphite"]').click();
  await expect(window.locator('[data-testid="motif-pattern"]')).toHaveAttribute('data-value', 'diagonal');
  await expect(window.locator('[data-testid="motif-reset"]')).not.toBeVisible();

  await window.locator('[data-testid="surface-card-aurora-glass"]').click();
  await expect(window.locator('[data-testid="motif-pattern"]')).toHaveAttribute('data-value', 'none');
});

test('the watermark is tinted from the live theme and re-bakes when the palette changes', async () => {
  // A pattern's colour is baked into its SVG data URI, so it cannot ride a
  // `var()` — `refreshSurfacePattern` must re-render it on `tm-theme-changed`.
  const inkOf = () => window.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image');
    return decodeURIComponent(raw).match(/stroke="([^"]+)"/)?.[1] ?? '';
  });
  const praxisInk = await inkOf();
  expect(praxisInk.toLowerCase()).toBe('#c6431f');

  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-tm-default-2"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'tm-default-2');
  await expect.poll(inkOf).not.toBe(praxisInk);
});

test('the default motif is one anchored corner mark, not wallpaper', async () => {
  // A corner motif must be painted `fixed` — that is what makes a single mark
  // span every pane instead of restarting at each pane boundary.
  const layer = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      repeat: style.getPropertyValue('--surface-watermark-repeat').trim(),
      attachment: style.getPropertyValue('--surface-watermark-attachment').trim(),
      position: style.getPropertyValue('--surface-watermark-position').trim()
    };
  });
  expect(layer.repeat).toBe('no-repeat');
  expect(layer.attachment).toBe('fixed');
  expect(layer.position).toBe('right top');

  // Every pane samples that same viewport-anchored image.
  for (const pane of ['.pane-sidebar', '.pane-main', '.pane-aux']) {
    const attachment = await window.locator(pane).evaluate(el => getComputedStyle(el, '::before').backgroundAttachment);
    expect(attachment, `${pane} attachment`).toBe('fixed');
  }
});

test('the corner picker mirrors the motif into every selected corner', async () => {
  await openSurface();
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();

  const layer = () => window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      image: style.getPropertyValue('--surface-watermark-image').trim(),
      position: style.getPropertyValue('--surface-watermark-position').trim(),
      attachment: style.getPropertyValue('--surface-watermark-attachment').trim()
    };
  });
  // One `data:` SVG per corner layer (the tile's own `url(#sp)` refs live
  // inside each URI, so counting `url(` would over-count).
  const layerCount = (value: string) => (value.match(/data:image\/svg\+xml/g) ?? []).length;

  // Parchment ships one corner (top-right).
  await expect(window.locator('[data-testid="motif-corner-top-right"]')).toHaveAttribute('aria-pressed', 'true');
  expect(layerCount((await layer()).image)).toBe(1);

  // Add the opposite corner — now two independent faded layers, one per corner.
  await window.locator('[data-testid="motif-corner-bottom-left"]').click();
  await expect(window.locator('[data-testid="motif-corner-bottom-left"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => layerCount((await layer()).image)).toBe(2);
  const twoUp = await layer();
  expect(twoUp.position).toBe('right top, left bottom');
  expect(twoUp.attachment).toBe('fixed, fixed');

  // Deselecting down to one corner works; deselecting the last is a no-op —
  // a corner motif always keeps at least one.
  await window.locator('[data-testid="motif-corner-top-right"]').click();
  await window.locator('[data-testid="motif-corner-bottom-left"]').click();
  await expect(window.locator('[data-testid="motif-corner-bottom-left"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => layerCount((await layer()).image)).toBe(1);

  // That two-corner-then-trimmed choice survives a relaunch.
  await window.locator('[data-testid="motif-corner-top-right"]').click();
  await window.reload();
  await openSurface();
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();
  await expect.poll(async () => layerCount((await layer()).image)).toBe(2);
});

test('the motif rides over any pack, and Reset hands it back', async () => {
  // The point of splitting motif from material: pick hexagon on a pack whose
  // own motif is a diagonal pattern, recolour it, and the pack keeps its own
  // grain and bevel underneath.
  await openSurface();
  await window.locator('[data-testid="surface-card-graphite"]').click();
  await chooseOption(window.locator('[data-testid="motif-pattern"]'), 'hexagon');
  await chooseOption(window.locator('[data-testid="motif-ink"]'), 'custom');
  await window.locator('[data-testid="motif-ink-color"]').fill('#4ec9b0');

  const tile = () => window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
  await expect.poll(tile).toContain('#4ec9b0');
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');

  await window.reload();
  await openSurface();
  await expect.poll(tile).toContain('#4ec9b0');

  // Reset drops the override; the pack's own diagonal motif returns.
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();
  await window.locator('[data-testid="motif-reset"]').click();
  await expect.poll(tile).not.toContain('#4ec9b0');
});

test('solid cells scatter through a super-tile rather than repeating in step', async () => {
  // With fill > 0 the hexagon repeat grows to 3×2 cells so the filled ones do
  // not land in the same spot in every tile.
  await openSurface();
  await chooseOption(window.locator('[data-testid="motif-placement"]'), 'tile');
  const width = async () => Number((await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-size').trim()))
    .split('px')[0]);
  const cell = Number(await window.locator('[data-testid="motif-scale"]').inputValue());

  // Every dial round-trips through settings before the layer re-bakes, so poll
  // for the repeat to actually collapse to one cell rather than reading the
  // previous super-tile as the baseline — that race made this flake under load.
  await window.locator('[data-testid="motif-fill"]').fill('0');
  await expect.poll(width).toBe(cell);

  await window.locator('[data-testid="motif-fill"]').fill('51');
  // 3 cells wide, so the repeat is three times the plain tile's width.
  await expect.poll(width).toBe(cell * 3);
  const tile = await window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
  expect(tile).toContain('fill-opacity="0.5"');
});

test('the letterpress outline is opt-in and draws a second offset line', async () => {
  await openSurface();
  const tile = () => window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));

  // Off by default — no second pass, no translate group.
  expect(await tile()).not.toContain('<g transform="translate');

  await window.locator('[data-testid="motif-outline"]').fill('70');
  await expect.poll(tile).toContain('<g transform="translate');
  // On a light theme the offset line is a shadow (rgba(0,0,0,0.85)); on a dark theme it is a highlight (rgba(255,255,255,0.9)).
  expect(await tile()).toMatch(/rgba\((0,0,0,0\.85|255,255,255,0\.9)\)/);

  await window.locator('[data-testid="motif-outline"]').fill('0');
  await expect.poll(tile).not.toContain('<g transform="translate');
});

test('motif strength is normalised so one value reads the same on every palette', async () => {
  // A fixed opacity does not mean a fixed *perceived* strength: it depends on
  // how far the ink sits from the panel. Praxis Dark is the reference pairing,
  // so it keeps its declared value; higher-contrast palettes must come down.
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-praxis-dark"]').click();
  await window.keyboard.press('Escape');

  const strength = () => window.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-opacity')));

  const praxis = await strength();
  expect(praxis).toBeGreaterThan(0.25);
  expect(praxis).toBeLessThanOrEqual(0.32);

  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  for (const theme of ['praxis-light', 'tm-default-1', 'tm-default-2']) {
    await window.locator(`[data-testid="theme-card-${theme}"]`).click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
    const scaled = await strength();
    // Each of these has a brighter ink against its panel than Praxis Dark, so
    // the correction must pull it down — never leave it at, or above, the base.
    expect(scaled, `${theme} strength`).toBeLessThan(praxis);
    expect(scaled, `${theme} strength`).toBeGreaterThan(0.05);
  }
});

test('the startup splash carries the same watermark as the panes', async () => {
  // Relaunching is the only way to see the splash again; it reads the very same
  // custom properties, set before React mounts so there is no bare first frame.
  await window.reload();
  const splash = window.locator('[data-testid="startup-splash"]');
  await splash.waitFor();
  const layer = await splash.evaluate(el => {
    const before = getComputedStyle(el, '::before');
    return { image: before.backgroundImage, opacity: parseFloat(before.opacity) };
  });
  expect(layer.image).toContain('svg');
  expect(layer.opacity).toBeGreaterThan(0);
});

/* ── Motif animation ──────────────────────────────────────────────────────
   The Mandelbrot is the first singular motif — an emblem drawn once rather
   than a lattice — and the first to carry motion. Both halves matter: an
   animated motif must move, and a still one must show the FINISHED mark
   immediately rather than a half-drawn one. */

/** The decoded SVG of the live watermark, so the baked-in animation is inspectable. */
async function watermarkSvg(): Promise<string> {
  return window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
}

/** Picks the Mandelbrot, and returns the Motif panel ready for more edits. */
async function chooseMandelbrot(): Promise<void> {
  await openSurface();
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();
  await chooseOption(window.locator('[data-testid="motif-pattern"]'), 'mandelbrot');
}

test('the Mandelbrot motif paints as real geometry and its tile actually loads', async () => {
  await chooseMandelbrot();
  // The CSP guard: the motif is a data: URI, and `img-src data:` is what lets
  // it paint at all. Without it the layer computes fine and silently never
  // shows — so decode it through a real Image() rather than trusting the token.
  expect(await watermarkLoads()).toMatch(/^OK /);

  const svg = await watermarkSvg();
  // The exact cardioid and the period-2 disc are what make this the Mandelbrot
  // rather than a blob: cubic segments for the boundary, circles for the bulbs.
  expect(svg).toContain('<path');
  expect(svg).toContain('<circle');
  expect(svg.match(/<circle/g)!.length).toBeGreaterThan(8);
});

test('with animation off the motif is baked complete, with no keyframes at all', async () => {
  await chooseMandelbrot();
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'none');

  const svg = await watermarkSvg();
  // "Off" must mean the finished mark, immediately — not a stopped animation.
  expect(svg).not.toContain('@keyframes');
  expect(svg).not.toContain('stroke-dashoffset');
  expect(svg).toContain('<path');
  await expect(window.locator('html')).not.toHaveAttribute('data-motif-anim', /./);

  const layer = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      anim: style.getPropertyValue('--surface-watermark-anim').trim(),
      mask: style.getPropertyValue('--surface-watermark-mask').trim(),
      filter: style.getPropertyValue('--surface-watermark-filter').trim()
    };
  });
  expect(layer.anim).toBe('none');
  expect(layer.mask).toBe('none');
  expect(layer.filter).toBe('none');
});

test('Draw bakes the reveal into the motif SVG and rests on the complete mark', async () => {
  await chooseMandelbrot();
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'draw');
  await expect(window.locator('html')).toHaveAttribute('data-motif-anim', 'draw');

  const svg = await watermarkSvg();
  // The reveal has to live INSIDE the image: only the SVG knows the geometry.
  expect(svg).toContain('@keyframes mkd');
  expect(svg).toContain('stroke-dashoffset');
  // `pathLength` is what lets one dasharray reveal every shape exactly, with no
  // per-pattern length maths.
  expect(svg).toContain('pathLength="1000"');
  // `both` (not `infinite`) is what makes it settle on the finished mark.
  expect(svg).toMatch(/animation:mkd \d+ms [^;]* 1 both/);
  // The parts are staggered so the set assembles rather than flashing in.
  expect(svg).toContain('animation-delay');
});

test('Repeat is what turns a one-shot reveal into a loop', async () => {
  await chooseMandelbrot();
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'draw');
  expect(await watermarkSvg()).not.toContain('infinite');

  // `.click()` rather than `.check()`: the Repeat row mounts only for a reveal
  // style, so it can be re-created by the settings echo mid-action and `.check()`
  // reads the fresh element as unchanged. `toBeChecked` retries past that.
  await window.locator('[data-testid="motif-repeat"]').click();
  await expect(window.locator('[data-testid="motif-repeat"]')).toBeChecked();
  expect(await watermarkSvg()).toContain('infinite');
});

test('layer-family styles drive CSS and leave the motif SVG untouched', async () => {
  await chooseMandelbrot();
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'shimmer');
  await expect(window.locator('html')).toHaveAttribute('data-motif-anim', 'shimmer');

  // Shimmer is pure CSS over the painted layer, so it works on every pattern in
  // the library without any pattern knowing about it.
  const svg = await watermarkSvg();
  expect(svg).not.toContain('@keyframes');

  const layer = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      anim: style.getPropertyValue('--surface-watermark-anim').trim(),
      mask: style.getPropertyValue('--surface-watermark-mask').trim(),
      flicker: style.getPropertyValue('--surface-watermark-flicker').trim()
    };
  });
  expect(layer.anim).toContain('motif-shimmer');
  expect(layer.mask).toContain('linear-gradient');
  // A mask can only subtract, so the resting alpha sits below 1 and this puts
  // the average strength back — deliberately NOT by raising the declared opacity.
  expect(Number(layer.flicker)).toBeGreaterThan(1);
});

test('an animated motif never raises the declared strength past the contrast ceiling', async () => {
  // The masking styles compensate through `--surface-watermark-flicker`, so the
  // token the contrast guard polices must be untouched by the animation choice.
  await chooseMandelbrot();
  const strength = async () => window.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-opacity')));

  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'none');
  const still = await strength();
  for (const style of ['shimmer', 'ripple', 'cyberpunk', 'glow']) {
    await chooseOption(window.locator('[data-testid="motif-animation"]'), style);
    expect(await strength(), `${style} watermark opacity`).toBeCloseTo(still, 5);
    expect(await strength(), `${style} contrast ceiling`).toBeLessThanOrEqual(0.4);
  }
});

test('the master switch stops every motif animation, whatever the style says', async () => {
  await chooseMandelbrot();
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'draw');
  await expect(window.locator('html')).toHaveAttribute('data-motif-anim', 'draw');

  // The gate is applied at bake time, not by disabling a running animation —
  // which is the only thing the in-SVG reveal styles would respect.
  await window.locator('[data-testid="surface-animate-toggle"]').scrollIntoViewIfNeeded();
  await window.locator('[data-testid="surface-animate-toggle"]').click();
  await expect(window.locator('html')).not.toHaveAttribute('data-motif-anim', /./);
  expect(await watermarkSvg()).not.toContain('@keyframes');

  // ...and the style is remembered, so switching back restores it.
  await window.locator('[data-testid="surface-animate-toggle"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-motif-anim', 'draw');
});

test('the motif rides over any pack, and animation rides over any motif', async () => {
  await openSurface();
  await window.locator('[data-testid="surface-card-graphite"]').click();
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();
  // Graphite ships a diagonal pattern; it takes the same layer styles.
  await chooseOption(window.locator('[data-testid="motif-animation"]'), 'glow');
  await expect(window.locator('html')).toHaveAttribute('data-motif-anim', 'glow');
  const filter = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-filter').trim());
  expect(filter).toContain('drop-shadow');
  // The glow tints from the live theme, so the ink has to be published as its
  // own token — CSS cannot read a colour back out of a data URI.
  const ink = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-ink').trim());
  expect(ink).toMatch(/^#|^rgb/);
});

test('switches surface pack, composing over the current theme, and persists it', async () => {
  await openSurface();
  await expect(window.locator('[data-testid="surface-card-parchment"]')).toHaveAttribute('aria-pressed', 'true');

  await window.locator('[data-testid="surface-card-graphite"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');
  await expect(window.locator('[data-testid="surface-card-graphite"]')).toHaveAttribute('aria-pressed', 'true');
  // The theme axis is untouched.
  await expect(window.locator('html')).toHaveAttribute('data-theme', DEFAULT_APP_SETTINGS.appearance.themeId);

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');
});

test('the Intensity dial scales the texture and is disabled for Flat', async () => {
  await openSurface();

  const readIntensity = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-intensity').trim());
  expect(await readIntensity()).toBe('1');

  await window.locator('[data-testid="surface-intensity"]').fill('40');
  await expect.poll(readIntensity).toBe('0.4');

  await window.reload();
  await openSurface();
  expect(await readIntensity()).toBe('0.4');

  await window.locator('[data-testid="surface-card-flat"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'flat');
  await expect(window.locator('[data-testid="surface-intensity"]')).toBeDisabled();
  await expect(window.locator('[data-testid="surface-texture-toggle"]')).toBeDisabled();
});

test('contrast guard: flat is inert and every pack keeps a readable panel ground', async () => {
  // The grain ::after now sits BEHIND the pane content (z-index 0, children
  // lifted to z-index 1), so texture opacity no longer erodes text contrast.
  // The remaining risk is the panel *fill* going too translucent to read text
  // against — flat must be a total no-op, and every pack must keep the
  // .pane-main fill at >= 0.45 alpha (aurora is the glassiest and still clears
  // it, over a dark shell). Noir is dark-only.
  for (const mode of ['dark', 'light']) {
    const packs = ['flat', 'parchment', 'graphite', 'aurora-glass', ...(mode === 'dark' ? ['noir'] : [])];
    for (const pack of packs) {
      const probe = await window.locator('.pane-main').evaluate((el, [m, p]) => {
        const root = document.documentElement;
        root.setAttribute('data-mode', m);
        root.setAttribute('data-theme', `praxis-${m}`);
        root.setAttribute('data-surface', p);
        root.setAttribute('data-translucency', 'on');
        root.style.setProperty('--surface-intensity', '1');
        root.style.setProperty('--surface-texture', '1');
        const cs = getComputedStyle(el);
        const m1 = /rgba?\([^)]*?[,/]\s*([\d.]+)\s*\)|\/\s*([\d.]+)\s*\)/.exec(cs.backgroundColor);
        return {
          afterOpacity: parseFloat(getComputedStyle(el, '::after').opacity),
          tintLayer: cs.getPropertyValue('--surface-panel-tint-layer').trim(),
          fillAlpha: m1 ? Number(m1[1] ?? m1[2]) : 1
        };
      }, [mode, pack] as const);

      if (pack === 'flat') {
        expect(probe.afterOpacity, 'flat ::after').toBe(0);
        expect(['none', ''], 'flat tint layer').toContain(probe.tintLayer);
      }
      expect(probe.fillAlpha, `${pack} @ praxis-${mode} panel fill`).toBeGreaterThanOrEqual(0.45);
    }
  }
});

test('contrast guard: no pack pushes its watermark past a readable ceiling', async () => {
  // The watermark is applied by `applySurfacePack` (it is data on the pack, not
  // a `[data-surface]` rule), so this drives the real gallery rather than the
  // attribute. It must stay a watermark: strong enough to read as material,
  // never strong enough to compete with body text. The ceiling is the value at
  // the motif's *strongest* point — a `corner` motif fades away from there, so
  // it can carry a higher peak than wall-to-wall tiling.
  const CEILING = 0.4;
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-praxis-dark"]').click();
  await openSurface();
  for (const pack of ['flat', 'parchment', 'graphite', 'aurora-glass', 'noir']) {
    await window.locator(`[data-testid="surface-card-${pack}"]`).click();
    await expect(window.locator('html')).toHaveAttribute('data-surface', pack);
    const layer = await window.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        opacity: style.getPropertyValue('--surface-watermark-opacity').trim(),
        image: style.getPropertyValue('--surface-watermark-image').trim()
      };
    });
    if (pack === 'flat' || pack === 'aurora-glass' || pack === 'noir') {
      // Neither declares a pattern, so the inline value is cleared and the
      // property falls back to the inert `none` declared on :root.
      expect(['none', ''], `${pack} watermark image`).toContain(layer.image);
      continue;
    }
    expect(Number(layer.opacity), `${pack} watermark opacity`).toBeGreaterThan(0);
    expect(Number(layer.opacity), `${pack} watermark opacity`).toBeLessThanOrEqual(CEILING);
  }
});

test('Aurora Glass frosts the sidebar and the translucency dial collapses it', async () => {
  await openSurface();
  await window.locator('[data-testid="surface-card-aurora-glass"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'aurora-glass');

  // The color-mix fill resolves to a translucent rgba(); the backdrop-filter is real.
  const fill = () => window.locator('.pane-sidebar').evaluate(el => getComputedStyle(el).backgroundColor);
  const backdrop = () => window.locator('.pane-sidebar').evaluate(el => {
    const style = getComputedStyle(el) as unknown as Record<string, string>;
    const values = [style.webkitBackdropFilter, style.backdropFilter].filter(value => value && value !== 'none');
    return values[0] ?? 'none';
  });
  const isTranslucent = (color: string) => /\/\s*0?\.\d+\s*\)/.test(color) || /,\s*0?\.\d+\s*\)/.test(color);
  const translucencyAllowed = await window.evaluate(
    () => !matchMedia('(prefers-reduced-transparency: reduce)').matches
  );

  await expect.poll(async () => isTranslucent(await fill())).toBe(translucencyAllowed);
  expect(await backdrop()).toBe(translucencyAllowed ? 'blur(26px) saturate(1.6)' : 'none');

  // The session console must keep the premium material visible instead of
  // covering the pane with an opaque legacy fill: it is fully transparent so
  // `.pane-main`'s themed surface shows straight through. The session list is
  // the shell's sidebar now, whose translucency is asserted above.
  await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await window.locator('[data-testid="nav-sessions"]').click();
  await expect(window.locator('[data-testid="sessions-view"]')).toBeVisible();
  const consoleFill = await window.locator('[data-testid="sessions-view"]').evaluate(
    view => getComputedStyle(view.querySelector('.session-console')!).backgroundColor
  );
  const isSeeThrough = (color: string) =>
    color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || isTranslucent(color);
  expect(isSeeThrough(consoleFill)).toBe(true);
  await window.screenshot({ path: 'output/playwright/sessions-aurora-glass.png', fullPage: true });

  // Turning translucency off forces the gate to 0 → panel resolves back to opaque.
  await openSurface();
  await window.locator('[data-testid="surface-translucency-toggle"]').click();
  await expect.poll(() =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-translucency').trim())
  ).toBe('0');
  await expect.poll(async () => isTranslucent(await fill())).toBe(false);
});

test('Noir is offered under a dark theme and hidden under a light one', async () => {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await window.locator('[data-testid="theme-card-praxis-dark"]').click();

  await openSurface();
  await expect(window.locator('[data-testid="surface-card-noir"]')).toBeVisible();

  // Swap to the light Praxis theme on the Themes node, then back to Surfaces.
  await openThemesGallery();
  await window.locator('[data-testid="theme-card-praxis-light"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-mode', 'light');
  await openSurface();
  await expect(window.locator('[data-testid="surface-card-noir"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="surface-card-aurora-glass"]')).toBeVisible();
});

test('a custom surface pack can be created, applied, and survives a reload', async () => {
  await openSurface();
  await window.locator('[data-testid="surface-new"]').click();
  await window.locator('[data-testid="custom-surface-name"]').fill('Vellum');
  await window.locator('[data-testid="custom-surface-opacity"]').fill('70');
  await window.locator('.custom-theme-editor .primary').click();

  await expect(window.locator('html')).toHaveAttribute('data-surface', /^custom-/);
  const inlineOpacity = () => window.locator('html').evaluate(el => el.style.getPropertyValue('--surface-panel-opacity').trim());
  const expectedOpacity = await window.evaluate(
    () => matchMedia('(prefers-reduced-transparency: reduce)').matches ? '' : '0.70'
  );
  await expect.poll(inlineOpacity).toBe(expectedOpacity);

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', /^custom-/);
  await expect.poll(inlineOpacity).toBe(expectedOpacity);
});

test('a user can swap the material by picking a pattern — no code, no new CSS', async () => {
  // The point of the pattern library: choosing "Topographic" from a dropdown
  // changes the material, and the choice survives a relaunch.
  await openSurface();
  await window.locator('[data-testid="surface-new"]').click();
  await window.locator('[data-testid="custom-surface-name"]').fill('Contours');
  await chooseOption(window.locator('[data-testid="custom-surface-pattern"]'), 'topo');
  await window.locator('[data-testid="custom-surface-pattern-scale"]').fill('96');
  await window.locator('.custom-theme-editor .primary').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', /^custom-/);

  // `topo` draws circles; `hexagon` (the default) draws a stroked path — so the
  // rendered tile itself proves which pattern is live.
  const tile = () => window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
  await expect.poll(tile).toContain('<circle');
  const size = () => window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-size').trim());
  expect(await size()).toBe('96px 96px');

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', /^custom-/);
  await expect.poll(tile).toContain('<circle');
});

test('the Window-blur toggle is present on a vibrancy-capable OS and persists', async () => {
  test.skip(process.platform === 'linux', 'no OS vibrancy on Linux');
  await openSurface();
  await window.locator('[data-testid="surface-card-aurora-glass"]').click();

  const toggle = window.locator('[data-testid="surface-vibrancy-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await window.reload();
  await openSurface();
  await expect(window.locator('[data-testid="surface-vibrancy-toggle"]')).toHaveAttribute('aria-checked', 'true');
});

test('the Texture toggle gates the grain layer without changing the pack', async () => {
  await openSurface();
  const readTextureGate = () =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-texture').trim());
  expect(await readTextureGate()).toBe('1');

  await window.locator('[data-testid="surface-texture-toggle"]').click();
  await expect.poll(readTextureGate).toBe('0');
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'parchment');

  const textureOpacity = await window.locator('.pane-main').evaluate(el =>
    parseFloat(getComputedStyle(el, '::after').opacity)
  );
  expect(textureOpacity).toBe(0);
});
