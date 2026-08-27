import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_APP_SETTINGS, mergeAppSettings, sanitizeAppSettings } from './appSettings';

test('sanitize fills surface defaults for a brand-new profile', () => {
  const settings = sanitizeAppSettings({});
  assert.equal(settings.appearance.surfacePackId, 'parchment');
  assert.deepEqual(settings.appearance.surface, {
    intensity: 1,
    translucency: true,
    texture: true,
    windowVibrancy: false
  });
  assert.deepEqual(settings.appearance.customSurfacePacks, []);
  assert.ok(settings.appearance.installedSurfacePackIds.includes('flat'));
});

test('migration: an untouched pre-feature appearance moves to the default pack', () => {
  const d = DEFAULT_APP_SETTINGS.appearance;
  const settings = sanitizeAppSettings({
    appearance: {
      themeId: d.themeId,
      themeMode: d.themeMode,
      showBrandArtwork: d.showBrandArtwork,
      customThemes: [],
      priorityColors: { ...d.priorityColors }
    }
  });
  assert.equal(settings.appearance.surfacePackId, 'parchment');
});

test('migration: a customised pre-feature appearance stays on flat', () => {
  const settings = sanitizeAppSettings({
    appearance: { themeId: 'github-dark', themeMode: 'dark' }
  });
  assert.equal(settings.appearance.surfacePackId, 'flat');
});

test('migration: a customised priority colour also pins to flat', () => {
  const settings = sanitizeAppSettings({
    appearance: { priorityColors: { Critical: '#000000' } }
  });
  assert.equal(settings.appearance.surfacePackId, 'flat');
});

test('an explicit surfacePackId is always respected, no migration', () => {
  assert.equal(
    sanitizeAppSettings({ appearance: { surfacePackId: 'graphite', themeId: 'github-dark' } }).appearance.surfacePackId,
    'graphite'
  );
});

test('surface dials are clamped and coerced', () => {
  const settings = sanitizeAppSettings({
    appearance: { surface: { intensity: 5, texture: 'yes', translucency: false } }
  });
  assert.equal(settings.appearance.surface.intensity, 1);
  assert.equal(settings.appearance.surface.texture, true); // non-boolean → default
  assert.equal(settings.appearance.surface.translucency, false);
});

test('custom surface packs keep only whitelisted --surface-* token keys', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      customSurfacePacks: [
        {
          id: 'custom-glass',
          name: 'Glass',
          description: 'test',
          tokens: {
            '--surface-panel-blur': '18px',
            '--surface-texture-opacity': '0.2',
            'color': 'red',
            '--evil': 'url(http://x)'
          }
        }
      ]
    }
  });
  assert.deepEqual(settings.appearance.customSurfacePacks[0]!.tokens, {
    '--surface-panel-blur': '18px',
    '--surface-texture-opacity': '0.2'
  });
});

test('merge applies a partial surface patch without dropping siblings', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { surface: { intensity: 0.4 } }
  });
  assert.equal(merged.appearance.surface.intensity, 0.4);
  assert.equal(merged.appearance.surface.texture, true);
  assert.equal(merged.appearance.surface.translucency, true);
  assert.equal(merged.appearance.surfacePackId, 'parchment');
});

test('merge swaps the active surface pack id', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { surfacePackId: 'blueprint' }
  });
  assert.equal(merged.appearance.surfacePackId, 'blueprint');
  // untouched theme fields survive
  assert.equal(merged.appearance.themeId, DEFAULT_APP_SETTINGS.appearance.themeId);
});
