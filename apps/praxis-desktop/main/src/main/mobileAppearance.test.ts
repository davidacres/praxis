import assert from 'node:assert/strict';
import test from 'node:test';
import { getDesktopAppearance, onDidChangeDesktopAppearance, setDesktopAppearance } from './mobileAppearance';

const colors = { bg: '#100e0b', bgElevated: '#2c2620', bgSunken: '#0b0907', bgInput: '#211c17', border: '#443a30', borderStrong: '#6c5b4a', text: '#f0e7d8', textSecondary: '#cdbfae', textTertiary: '#958878', accent: '#c6431f', accentContrast: '#fffdf8', success: '#3fb950', warning: '#d29922', danger: '#e2766d' };

test('keeps the published theme and tells listeners only when it changes', () => {
  const seen: string[] = [];
  const stop = onDidChangeDesktopAppearance(appearance => seen.push(appearance.themeId));
  setDesktopAppearance({ themeId: 'praxis-dark', themeName: 'Praxis Dark', mode: 'dark', colors });
  setDesktopAppearance({ themeId: 'praxis-dark', themeName: 'Praxis Dark', mode: 'dark', colors });
  setDesktopAppearance({ themeId: 'broken', mode: 'dark', colors: { ...colors, accent: 'var(--accent)' } });
  assert.deepEqual(seen, ['praxis-dark'], 'a repeat and a malformed theme are both ignored');
  assert.equal(getDesktopAppearance()?.themeId, 'praxis-dark');
  stop();
});
