import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_APP_SETTINGS, mergeAppSettings, sanitizeAppSettings } from './appSettings';

test('startup defaults to reopening the last workspace and preserves an explicit opt-out', () => {
  assert.equal(sanitizeAppSettings({}).startup.reopenLastWorkspace, true);
  assert.equal(
    sanitizeAppSettings({ startup: { reopenLastWorkspace: false } }).startup.reopenLastWorkspace,
    false
  );
  assert.equal(
    sanitizeAppSettings({ startup: { reopenLastWorkspace: 'yes' } }).startup.reopenLastWorkspace,
    true
  );
});

test('merge updates the startup preference without changing other settings', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    startup: { reopenLastWorkspace: false }
  });
  assert.equal(merged.startup.reopenLastWorkspace, false);
  assert.equal(merged.preview.enableNewProject, DEFAULT_APP_SETTINGS.preview.enableNewProject);
});

test('sanitize fills surface defaults for a brand-new profile', () => {
  const settings = sanitizeAppSettings({});
  assert.equal(settings.appearance.surfacePackId, 'parchment');
  assert.deepEqual(settings.appearance.surface, {
    intensity: 1,
    translucency: true,
    texture: true,
    windowVibrancy: false,
    animateMotifs: true,
    plainChatSurface: false
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

test('the phase-2 glass packs are in the default installed list', () => {
  const ids = DEFAULT_APP_SETTINGS.appearance.installedSurfacePackIds;
  assert.ok(ids.includes('aurora-glass'));
  assert.ok(ids.includes('noir'));
});

test('a custom surface pack keeps its basePackId and merges into the profile', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      customSurfacePacks: [
        { id: 'custom-vellum', name: 'Vellum', description: '', basePackId: 'parchment', tokens: { '--surface-panel-blur': '12px' } }
      ]
    }
  });
  assert.equal(settings.appearance.customSurfacePacks[0]!.basePackId, 'parchment');

  const merged = mergeAppSettings(settings, { appearance: { surfacePackId: 'custom-vellum' } });
  assert.equal(merged.appearance.surfacePackId, 'custom-vellum');
  assert.equal(merged.appearance.customSurfacePacks[0]!.tokens['--surface-panel-blur'], '12px');
});

test('a custom pack keeps a valid watermark pattern and clamps its numbers', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      customSurfacePacks: [
        {
          id: 'custom-hex',
          name: 'Hex',
          description: '',
          tokens: {},
          pattern: { id: 'hexagon', scale: 9999, opacity: 5, ink: 'text', weight: 0, blend: 'overlay' }
        }
      ]
    }
  });
  const pattern = settings.appearance.customSurfacePacks[0]!.pattern!;
  assert.equal(pattern.id, 'hexagon');
  assert.equal(pattern.scale, 400);   // clamped down from 9999
  assert.equal(pattern.opacity, 1);   // clamped down from 5
  assert.equal(pattern.weight, 0.005); // clamped up from 0
  assert.equal(pattern.ink, 'text');
  assert.equal(pattern.blend, 'overlay');
});

test('a motif override is validated and clamped like a pack pattern', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      surface: {
        motif: {
          id: 'hexagon', scale: 62, opacity: 0.3, ink: 'custom', inkColor: '#4ec9b0',
          placement: 'corner', anchor: 'top-left', spread: 99999, fade: 2, fill: 0.5
        }
      }
    }
  });
  const motif = settings.appearance.surface.motif!;
  assert.equal(motif.ink, 'custom');
  assert.equal(motif.inkColor, '#4ec9b0');
  assert.equal(motif.placement, 'corner');
  assert.equal(motif.anchor, 'top-left');
  assert.equal(motif.spread, 2400); // clamped
  assert.equal(motif.fade, 1);      // clamped
  assert.equal(motif.fill, 0.5);
});

test('a motif ink colour that is not a literal hex is refused', () => {
  // The colour is baked straight into an SVG `stroke`, so anything that is not
  // a plain hex must never survive validation.
  const settings = sanitizeAppSettings({
    appearance: {
      surface: { motif: { id: 'hexagon', scale: 62, opacity: 0.3, ink: 'custom', inkColor: 'url(#x)' } }
    }
  });
  assert.equal(settings.appearance.surface.motif!.inkColor, undefined);
});

test('an unknown motif anchor falls back rather than reaching CSS', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      surface: { motif: { id: 'grid', scale: 40, opacity: 0.2, anchor: 'middle-of-nowhere' } }
    }
  });
  assert.equal(settings.appearance.surface.motif!.anchor, undefined);
});

test('a motif corner list is filtered to the real corners, de-duplicated, and capped at four', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      surface: {
        motif: {
          id: 'hexagon', scale: 62, opacity: 0.3, placement: 'corner',
          anchors: ['top-right', 'bottom-left', 'top-right', 'nowhere', 'top-left', 'bottom-right', 'top-left']
        }
      }
    }
  });
  assert.deepEqual(
    settings.appearance.surface.motif!.anchors,
    ['top-right', 'bottom-left', 'top-left', 'bottom-right']
  );
});

test('an unknown motif animation falls back rather than reaching CSS', () => {
  // The style names a keyframe block and is written to a `data-motif-anim`
  // attribute, so — like the blend keywords — only a known literal survives.
  const settings = sanitizeAppSettings({
    appearance: {
      surface: { motif: { id: 'mandelbrot', scale: 62, opacity: 0.3, animation: 'rm -rf' } }
    }
  });
  assert.equal(settings.appearance.surface.motif!.animation, undefined);
});

test('a motif animation style, speed and repeat round-trip and clamp', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      surface: {
        motif: {
          id: 'mandelbrot', scale: 62, opacity: 0.3,
          animation: 'draw', animationSpeed: 99, animationRepeat: true
        }
      }
    }
  });
  const motif = settings.appearance.surface.motif!;
  assert.equal(motif.animation, 'draw');
  assert.equal(motif.animationSpeed, 4); // clamped down from 99
  assert.equal(motif.animationRepeat, true);
});

test('motif animation is gated by a master switch that defaults on', () => {
  assert.equal(DEFAULT_APP_SETTINGS.appearance.surface.animateMotifs, true);
  const off = sanitizeAppSettings({ appearance: { surface: { animateMotifs: false } } });
  assert.equal(off.appearance.surface.animateMotifs, false);
  // A non-boolean must not read as "on" by accident.
  const junk = sanitizeAppSettings({ appearance: { surface: { animateMotifs: 'yes' } } });
  assert.equal(junk.appearance.surface.animateMotifs, true);
});

test('an all-invalid motif corner list is dropped so the singular anchor still applies', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      surface: { motif: { id: 'grid', scale: 40, opacity: 0.2, anchor: 'bottom-left', anchors: ['nope', 42] } }
    }
  });
  assert.equal(settings.appearance.surface.motif!.anchors, undefined);
  assert.equal(settings.appearance.surface.motif!.anchor, 'bottom-left');
});

test('a custom pack drops an unsafe pattern id or blend rather than passing it to CSS', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      customSurfacePacks: [
        { id: 'custom-a', name: 'A', description: '', tokens: {}, pattern: { id: 'url(javascript:1)', scale: 40, opacity: 0.1 } },
        { id: 'custom-b', name: 'B', description: '', tokens: {}, pattern: { id: 'grid', scale: 40, opacity: 0.1, blend: 'expression(evil)' } }
      ]
    }
  });
  // An id that is not a plain slug is refused outright…
  assert.equal(settings.appearance.customSurfacePacks[0]!.pattern, undefined);
  // …and a blend outside the CSS keyword set is dropped, keeping the rest.
  assert.equal(settings.appearance.customSurfacePacks[1]!.pattern!.id, 'grid');
  assert.equal(settings.appearance.customSurfacePacks[1]!.pattern!.blend, undefined);
});

/* ── Looks (switchable appearance presets) ──────────────────────────────── */

test('a fresh profile ships the four built-in Looks with Parchment active', () => {
  const settings = sanitizeAppSettings({});
  assert.deepEqual(
    settings.appearance.looks.map(look => look.id),
    ['look-parchment', 'look-blueprint', 'look-aurora', 'look-flat']
  );
  assert.equal(settings.appearance.activeLookId, 'look-parchment');
  // look-parchment must equal today's shipped appearance so nothing shifts.
  const parchment = settings.appearance.looks[0]!;
  assert.equal(parchment.surfacePackId, 'parchment');
  assert.equal(parchment.themeId, 'praxis-dark');
});

test('an existing profile with no stored Looks gets the built-ins but stays detached', () => {
  const settings = sanitizeAppSettings({ appearance: { themeId: 'github-dark', surfacePackId: 'flat' } });
  assert.equal(settings.appearance.looks.length, 4);
  assert.equal(settings.appearance.activeLookId, '');
});

test('an activeLookId that names no Look is blanked', () => {
  const settings = sanitizeAppSettings({ appearance: { activeLookId: 'look-ghost' } });
  assert.equal(settings.appearance.activeLookId, '');
});

test('readLooks drops a malformed entry and clamps a nested surface dial', () => {
  const settings = sanitizeAppSettings({
    appearance: {
      looks: [
        { id: 'bad id', name: 'Nope', themeId: 'praxis-dark', surfacePackId: 'flat' },
        { id: 'look-mine', name: '  My Look  ', themeId: 'praxis-dark', themeMode: 'light',
          surfacePackId: 'graphite', surface: { intensity: 9, texture: 'yes', translucency: false },
          priorityColors: {}, showBrandArtwork: false }
      ]
    }
  });
  assert.equal(settings.appearance.looks.length, 1);
  const look = settings.appearance.looks[0]!;
  assert.equal(look.id, 'look-mine');
  assert.equal(look.name, 'My Look');
  assert.equal(look.themeMode, 'light');
  assert.equal(look.surface.intensity, 1);       // clamped from 9
  assert.equal(look.surface.texture, true);      // non-boolean → default
  assert.equal(look.surface.translucency, false);
  assert.equal(look.showBrandArtwork, false);
});

test('editing an appearance field while a Look is active mirrors into that Look', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { surfacePackId: 'graphite' }
  });
  assert.equal(merged.appearance.surfacePackId, 'graphite');
  const parchment = merged.appearance.looks.find(look => look.id === 'look-parchment')!;
  assert.equal(parchment.surfacePackId, 'graphite');
  // base is never mutated
  assert.equal(
    DEFAULT_APP_SETTINGS.appearance.looks.find(look => look.id === 'look-parchment')!.surfacePackId,
    'parchment'
  );
});

test('switching Look (activeLookId in the patch) does not clobber the target Look', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { surfacePackId: 'graphite', activeLookId: 'look-flat' }
  });
  assert.equal(merged.appearance.activeLookId, 'look-flat');
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-parchment')!.surfacePackId, 'parchment');
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-flat')!.surfacePackId, 'flat');
});

test('a wholesale looks rewrite is not second-guessed by the mirror', () => {
  const rename = DEFAULT_APP_SETTINGS.appearance.looks.map(look =>
    look.id === 'look-parchment' ? { ...look, name: 'Renamed' } : look);
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { looks: rename, surfacePackId: 'graphite' }
  });
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-parchment')!.name, 'Renamed');
  // the mirror stayed out of it — no surfacePackId snapshot onto the entry
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-parchment')!.surfacePackId, 'parchment');
});

test('a detached profile ignores appearance edits for mirroring', () => {
  const base = sanitizeAppSettings({ appearance: { themeId: 'github-dark' } }); // activeLookId === ''
  const merged = mergeAppSettings(base, { appearance: { surfacePackId: 'graphite' } });
  assert.equal(merged.appearance.activeLookId, '');
  assert.deepEqual(
    merged.appearance.looks.map(look => look.surfacePackId),
    base.appearance.looks.map(look => look.surfacePackId)
  );
});
