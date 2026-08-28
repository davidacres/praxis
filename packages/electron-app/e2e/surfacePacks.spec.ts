import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@ticket-manager/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

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

async function openSurface(): Promise<void> {
  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="surface-section"]').scrollIntoViewIfNeeded();
  await expect(window.locator('[data-testid="surface-section"]')).toBeVisible();
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
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');

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

test('the watermark is tinted from the live theme and re-bakes when the palette changes', async () => {
  // A pattern's colour is baked into its SVG data URI, so it cannot ride a
  // `var()` — `refreshSurfacePattern` must re-render it on `tm-theme-changed`.
  const inkOf = () => window.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image');
    return decodeURIComponent(raw).match(/stroke="([^"]+)"/)?.[1] ?? '';
  });
  const praxisInk = await inkOf();
  expect(praxisInk.toLowerCase()).toBe('#c6431f');

  await window.locator('[data-testid="titlebar-themes"]').click();
  await window.locator('[data-testid="theme-card-github-dark"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'github-dark');
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

test('the motif rides over any pack, and Reset hands it back', async () => {
  // The point of splitting motif from material: pick hexagon on a pack whose
  // own motif is a triangle lattice, recolour it, and the pack keeps its own
  // grain and bevel underneath.
  await openSurface();
  await window.locator('[data-testid="surface-card-graphite"]').click();
  await window.locator('[data-testid="motif-pattern"]').selectOption('hexagon');
  await window.locator('[data-testid="motif-ink"]').selectOption('custom');
  await window.locator('[data-testid="motif-ink-color"]').fill('#4ec9b0');

  const tile = () => window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
  await expect.poll(tile).toContain('#4ec9b0');
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');

  await window.reload();
  await window.locator('[data-testid="titlebar-themes"]').click();
  await expect.poll(tile).toContain('#4ec9b0');

  // Reset drops the override; the pack's own triangle motif returns.
  await window.locator('[data-testid="motif-panel"]').scrollIntoViewIfNeeded();
  await window.locator('[data-testid="motif-reset"]').click();
  await expect.poll(tile).not.toContain('#4ec9b0');
});

test('solid cells scatter through a super-tile rather than repeating in step', async () => {
  // With fill > 0 the hexagon repeat grows to 3×2 cells so the filled ones do
  // not land in the same spot in every tile.
  await openSurface();
  await window.locator('[data-testid="motif-placement"]').selectOption('tile');
  await window.locator('[data-testid="motif-fill"]').fill('0');
  const size = () => window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-size').trim());
  const plain = await size();

  await window.locator('[data-testid="motif-fill"]').fill('51');
  await expect.poll(size).not.toBe(plain);
  const tile = await window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));
  expect(tile).toContain('fill-opacity="0.5"');
  // 3 cells wide, so the repeat is three times the plain tile's width.
  expect(Number((await size()).split('px')[0])).toBeCloseTo(Number(plain.split('px')[0]) * 3, 0);
});

test('the letterpress outline is opt-in and draws a second offset line', async () => {
  await openSurface();
  const tile = () => window.evaluate(() =>
    decodeURIComponent(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-image')));

  // Off by default — no second pass, no translate group.
  expect(await tile()).not.toContain('<g transform="translate');

  await window.locator('[data-testid="motif-outline"]').fill('70');
  await expect.poll(tile).toContain('<g transform="translate');
  // On a dark theme the offset line is a highlight, drawn behind the main ink.
  expect(await tile()).toContain('rgba(255,255,255,0.9)');

  await window.locator('[data-testid="motif-outline"]').fill('0');
  await expect.poll(tile).not.toContain('<g transform="translate');
});

test('motif strength is normalised so one value reads the same on every palette', async () => {
  // A fixed opacity does not mean a fixed *perceived* strength: it depends on
  // how far the ink sits from the panel. Praxis Dark is the reference pairing,
  // so it keeps its declared value; higher-contrast palettes must come down.
  const strength = () => window.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--surface-watermark-opacity')));

  const praxis = await strength();
  expect(praxis).toBeGreaterThan(0.25);
  expect(praxis).toBeLessThanOrEqual(0.32);

  await window.locator('[data-testid="titlebar-themes"]').click();
  for (const theme of ['catppuccin-mocha', 'github-light', 'nord-dark']) {
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

test('switches surface pack, composing over the current theme, and persists it', async () => {
  await openSurface();
  await expect(window.locator('[data-testid="surface-card-parchment"]')).toHaveAttribute('aria-pressed', 'true');

  await window.locator('[data-testid="surface-card-graphite"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-surface', 'graphite');
  await expect(window.locator('[data-testid="surface-card-graphite"]')).toHaveAttribute('aria-pressed', 'true');
  // The theme axis is untouched.
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');

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
  await window.locator('[data-testid="titlebar-themes"]').click();
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
    const packs = ['flat', 'parchment', 'graphite', 'blueprint', 'aurora-glass', ...(mode === 'dark' ? ['noir'] : [])];
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
  await openSurface();
  for (const pack of ['flat', 'parchment', 'graphite', 'blueprint', 'aurora-glass', 'noir']) {
    await window.locator(`[data-testid="surface-card-${pack}"]`).click();
    await expect(window.locator('html')).toHaveAttribute('data-surface', pack);
    const layer = await window.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        opacity: style.getPropertyValue('--surface-watermark-opacity').trim(),
        image: style.getPropertyValue('--surface-watermark-image').trim()
      };
    });
    if (pack === 'flat' || pack === 'noir') {
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

  await expect.poll(async () => isTranslucent(await fill())).toBe(true);
  expect(await backdrop()).toContain('blur');

  // Turning translucency off forces the gate to 0 → panel resolves back to opaque.
  await window.locator('[data-testid="surface-translucency-toggle"]').click();
  await expect.poll(() =>
    window.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--surface-translucency').trim())
  ).toBe('0');
  await expect.poll(async () => isTranslucent(await fill())).toBe(false);
});

test('Noir is offered under a dark theme and hidden under a light one', async () => {
  await openSurface();
  await expect(window.locator('[data-testid="surface-card-noir"]')).toBeVisible();

  // Swap to the light Praxis theme, reopen the panel.
  await window.locator('[data-testid="theme-card-praxis-light"]').click();
  await expect(window.locator('html')).toHaveAttribute('data-mode', 'light');
  await window.locator('[data-testid="surface-section"]').scrollIntoViewIfNeeded();
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
  await expect.poll(inlineOpacity).toBe('0.70');

  await window.reload();
  await expect(window.locator('html')).toHaveAttribute('data-surface', /^custom-/);
  await expect.poll(inlineOpacity).toBe('0.70');
});

test('a user can swap the material by picking a pattern — no code, no new CSS', async () => {
  // The point of the pattern library: choosing "Topographic" from a dropdown
  // changes the material, and the choice survives a relaunch.
  await openSurface();
  await window.locator('[data-testid="surface-new"]').click();
  await window.locator('[data-testid="custom-surface-name"]').fill('Contours');
  await window.locator('[data-testid="custom-surface-pattern"]').selectOption('topo');
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
  await window.locator('[data-testid="titlebar-themes"]').click();
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
