import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOBILE_PALETTE, fitCornerMotifSvg, mixHex, motifSpreadScale, paletteFromAppearance, readMobileAppearance, tiledMotifSvg } from './mobileTheme';

const praxisLight = {
  themeId: 'praxis-light',
  themeName: 'Praxis Light',
  mode: 'light' as const,
  colors: {
    bg: '#f5f2eb', bgElevated: '#fffdf8', bgSunken: '#ebe7de', bgInput: '#fffdf8', border: '#d5c8b8',
    borderStrong: '#ad9a85', text: '#2c2620', textSecondary: '#74695e', textTertiary: '#958878',
    accent: '#c6431f', accentContrast: '#fffdf8', success: '#467a5b', warning: '#9b6b22', danger: '#b94a48',
  },
};

test('a desktop theme maps its surfaces, text and accent straight onto the phone palette', () => {
  const palette = paletteFromAppearance(praxisLight);
  assert.equal(palette.bg, '#f5f2eb');
  assert.equal(palette.surface, '#fffdf8');
  assert.equal(palette.text, '#2c2620');
  assert.equal(palette.textDim, '#958878');
  assert.equal(palette.accent, '#c6431f');
  assert.equal(palette.onAccent, '#fffdf8');
  assert.equal(palette.ok, '#467a5b');
  assert.match(palette.chrome, /^rgba\(235, 231, 222, 0\.95\)$/);
});

test('tints are mixed from the theme, so a light theme gets light wells and a dark one dark', () => {
  const light = paletteFromAppearance(praxisLight);
  assert.equal(light.accentSoft, mixHex('#f5f2eb', '#c6431f', 0.12));
  assert.notEqual(light.accentSoft, DEFAULT_MOBILE_PALETTE.accentSoft);
  assert.equal(DEFAULT_MOBILE_PALETTE.bg, '#100e0b', 'the unpaired phone wears Praxis Dark');
});

test('mixHex blends channel by channel', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#102030', '#102030', 0.7), '#102030');
});

test('only a complete, hex-coloured appearance is worn', () => {
  assert.deepEqual(readMobileAppearance(praxisLight), praxisLight);
  assert.equal(readMobileAppearance({ ...praxisLight, colors: { ...praxisLight.colors, accent: 'tomato' } }), undefined);
  assert.equal(readMobileAppearance({ ...praxisLight, mode: 'sepia' }), undefined);
  assert.equal(readMobileAppearance({ ...praxisLight, colors: { ...praxisLight.colors, danger: undefined } }), undefined);
  assert.equal(readMobileAppearance(null), undefined);
  assert.equal(readMobileAppearance({ ...praxisLight, themeName: '' })?.themeName, 'praxis-light');
});

const cornerLayer = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="760"><rect width="760" height="760"/></svg>', width: 760, height: 760, anchor: 'top-right' as const, repeat: false };

test('the desktop motif is kept with its corners, and a malformed one is dropped while the colours stay', () => {
  const kept = readMobileAppearance({ ...praxisLight, motif: { opacity: 0.27, layers: [cornerLayer, { ...cornerLayer, anchor: 'bottom-left' }] } });
  assert.deepEqual(kept?.motif?.layers.map(layer => layer.anchor), ['top-right', 'bottom-left']);
  const bad = readMobileAppearance({ ...praxisLight, motif: { opacity: 0.27, layers: [{ ...cornerLayer, svg: 'javascript:alert(1)' }] } });
  assert.equal(bad?.motif, undefined);
  assert.equal(bad?.colors.accent, '#c6431f');
});

test('a repeating layer is wrapped in a pattern covering the whole surface', () => {
  const tile = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="38" height="66"><path d="M0 0"/></svg>', width: 38, height: 66, anchor: 'center' as const, repeat: true };
  const xml = tiledMotifSvg(tile, 430, 900);
  assert.match(xml, /<pattern id="mt" width="38" height="66" patternUnits="userSpaceOnUse"><path d="M0 0"\/><\/pattern>/);
  assert.match(xml, /<rect width="430" height="900" fill="url\(#mt\)"\/>/);
});

const latticeCorner = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="760" viewBox="0 0 760 760"><defs>' +
    '<mask id="sm"><rect width="760" height="760" fill="url(#sf)"/></mask>' +
    '<pattern id="sp" width="76" height="131.64" patternUnits="userSpaceOnUse"><path d="M0 0"/></pattern></defs>' +
    '<rect width="760" height="760" fill="url(#sp)" mask="url(#sm)"/></svg>',
  width: 760, height: 760, anchor: 'top-right' as const, repeat: false,
};

test('a corner motif keeps its share of the screen: the spread shrinks with the screen, the cells do not', () => {
  const motif = { opacity: 0.27, layers: [latticeCorner], viewport: { width: 1664, height: 936 } };
  const scale = motifSpreadScale(motif, 430, 630);
  assert.ok(Math.abs(scale - 1060 / 2600) < 1e-9);
  const fitted = fitCornerMotifSvg(latticeCorner, scale);
  assert.equal(fitted.size, Math.round(760 * scale));
  assert.equal(fitted.svg.includes('760'), false, 'box, mask and filled area all shrink');
  assert.match(fitted.svg, /<pattern id="sp" width="76" height="131.64"/, 'the cell keeps its size');
  assert.equal(motifSpreadScale({ ...motif, viewport: undefined }, 430, 630), 1, 'an older desktop keeps the spread as sent');
  assert.equal(fitCornerMotifSvg(latticeCorner, 1).svg, latticeCorner.svg);
});
