import { resolvePromptCheckProvider, resolveRecommendationProvider } from '../ai/providerSecrets';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_APP_SETTINGS, mergeAppSettings, sanitizeAppSettings } from './appSettings';

test('custom theme chat backgrounds accept only hex colors and remain optional', () => {
  const theme = { id: 'custom-chat', name: 'Chat', mode: 'dark', description: '' };
  for (const value of ['#123456', '#ABCDEF', 'red', 'url(https://example.com)', '']) {
    const settings = sanitizeAppSettings({ appearance: { customThemes: [{ ...theme, preview: { chatBackground: value } }] } });
    assert.equal(settings.appearance.customThemes[0]?.preview.chatBackground,
      /^#[0-9a-f]{6}$/i.test(value) ? value : undefined);
  }
  const settings = sanitizeAppSettings({ appearance: { customThemes: [{ ...theme, preview: { canvas: '#123456' } }] } });
  assert.equal(settings.appearance.customThemes[0]?.preview.chatBackground, undefined);
});

test('custom theme chat images accept bounded embedded raster images only', () => {
  const theme = { id: 'custom-image', name: 'Image', mode: 'dark', description: '' };
  for (const [value, accepted] of [
    ['data:image/png;base64,YQ==', true], ['data:image/jpeg;base64,YQ==', true], ['data:image/webp;base64,YQ==', true],
    ['https://example.com/image.png', false], ['data:image/svg+xml;base64,YQ==', false], ['data:image/png;base64,YQ==")', false],
    [`data:image/png;base64,${'a'.repeat(2_800_000)}`, false]
  ] as const) {
    const settings = sanitizeAppSettings({ appearance: { customThemes: [{ ...theme, preview: { chatBackgroundImage: value } }] } });
    assert.equal(settings.appearance.customThemes[0]?.preview.chatBackgroundImage,
      accepted ? value : undefined);
  }
});

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
  assert.deepEqual(merged.preview, DEFAULT_APP_SETTINGS.preview);
});

test('provider hand-over defaults to 95% and is clamped to a whole percent between 50 and 100', () => {
  assert.equal(sanitizeAppSettings({}).ai.providerHandoverPercent, 95);
  assert.equal(sanitizeAppSettings({ ai: {} }).ai.providerHandoverPercent, 95);
  const at = (value: unknown) => sanitizeAppSettings({ ai: { providerHandoverPercent: value } }).ai.providerHandoverPercent;
  assert.equal(at(80), 80);
  assert.equal(at(10), 50);
  assert.equal(at(150), 100);
  assert.equal(at(87.6), 88);
  assert.equal(at('90'), 95);
  assert.equal(at(Number.NaN), 95);
  const merged = sanitizeAppSettings(mergeAppSettings(DEFAULT_APP_SETTINGS, { ai: { providerHandoverPercent: 85 } }));
  assert.equal(merged.ai.providerHandoverPercent, 85);
  assert.equal(merged.ai.activeProvider, DEFAULT_APP_SETTINGS.ai.activeProvider);
});

test('mobile access is off by default and mode is validated to the known set', () => {
  assert.equal(sanitizeAppSettings({}).mobileAccess.mode, 'off');
  assert.equal(sanitizeAppSettings({ mobileAccess: { mode: 'local-only' } }).mobileAccess.mode, 'local-only');
  assert.equal(sanitizeAppSettings({ mobileAccess: { mode: 'relay' } }).mobileAccess.mode, 'off');
  const trimmed = sanitizeAppSettings({ mobileAccess: { allowedInterfaces: ['en0', ' en0 ', ''] } }).mobileAccess.allowedInterfaces;
  assert.deepEqual([...trimmed], ['en0']);
  const rejected = sanitizeAppSettings({ mobileAccess: { allowedSubnets: ['10.0.0.', 42] } }).mobileAccess.allowedSubnets;
  assert.deepEqual([...rejected], []);
  // An entry the policy cannot match is dropped, not stored; a legacy octet prefix migrates.
  const subnets = sanitizeAppSettings({ mobileAccess: { allowedSubnets: ['192.168.1', '192.168.1.', '192.168.1.0/24', '10.0.0.0/33', 'fd00::/8', 'lan'] } }).mobileAccess.allowedSubnets;
  assert.deepEqual([...subnets], ['192.168.1.0/24', 'fd00::/8']);
  assert.equal(sanitizeAppSettings({}).mobileAccess.listenPort, 43100);
  assert.equal(sanitizeAppSettings({ mobileAccess: { listenPort: 80 } }).mobileAccess.listenPort, 1024);
  assert.equal(sanitizeAppSettings({ mobileAccess: { listenPort: 43101 } }).mobileAccess.listenPort, 43101);
});

test('merge updates mobile access without touching other sections', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { mobileAccess: { mode: 'internet' } });
  assert.equal(merged.mobileAccess.mode, 'internet');
  assert.equal(merged.mobileAccess.hostName, DEFAULT_APP_SETTINGS.mobileAccess.hostName);
  assert.equal(merged.git.executablePath, DEFAULT_APP_SETTINGS.git.executablePath);
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
    appearance: { surfacePackId: 'graphite' }
  });
  assert.equal(merged.appearance.surfacePackId, 'graphite');
  // untouched theme fields survive
  assert.equal(merged.appearance.themeId, DEFAULT_APP_SETTINGS.appearance.themeId);
});

test('legacy Blueprint and Binary surface selections become Parchment with their motif', () => {
  const blueprint = sanitizeAppSettings({ appearance: { surfacePackId: 'blueprint' } });
  assert.equal(blueprint.appearance.surfacePackId, 'parchment');
  assert.equal(blueprint.appearance.surface.motif?.id, 'grid');

  const binary = sanitizeAppSettings({ appearance: { surfacePackId: 'binary' } });
  assert.equal(binary.appearance.surfacePackId, 'parchment');
  assert.equal(binary.appearance.surface.motif?.id, 'binary');
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

test('editing an appearance field while a custom Look is active mirrors into that Look', () => {
  const custom = {
    ...DEFAULT_APP_SETTINGS.appearance.looks[0]!,
    id: 'look-mine',
    name: 'My Look'
  };
  const base = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    appearance: { looks: [...DEFAULT_APP_SETTINGS.appearance.looks, custom], activeLookId: 'look-mine' }
  });
  const merged = mergeAppSettings(base, { appearance: { surfacePackId: 'graphite' } });
  assert.equal(merged.appearance.surfacePackId, 'graphite');
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-mine')!.surfacePackId, 'graphite');
  // base is never mutated
  assert.equal(
    base.appearance.looks.find(look => look.id === 'look-mine')!.surfacePackId,
    'parchment'
  );
});

test('editing an appearance field while a built-in Look is active detaches without changing it', () => {
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { appearance: { surfacePackId: 'graphite' } });
  assert.equal(merged.appearance.activeLookId, '');
  assert.equal(merged.appearance.looks.find(look => look.id === 'look-parchment')!.surfacePackId, 'parchment');
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

test('a provider is enabled unless it was explicitly turned off, and the choice round-trips', () => {
  // Nothing stored: no `enabled` key, so an existing setup behaves exactly as before.
  const untouched = sanitizeAppSettings({ ai: { providers: { anthropic: { baseUrl: 'https://example.test' } } } });
  assert.equal(untouched.ai.providers.anthropic?.enabled, undefined);

  const off = sanitizeAppSettings({ ai: { providers: { anthropic: { enabled: false } } } });
  assert.equal(off.ai.providers.anthropic?.enabled, false);

  // Non-boolean junk is ignored rather than read as "off".
  const junk = sanitizeAppSettings({ ai: { providers: { anthropic: { enabled: 'no', baseUrl: 'https://x.test' } } } });
  assert.equal(junk.ai.providers.anthropic?.enabled, undefined);

  // Turning it off keeps the rest of its config; turning it back on is a plain merge.
  const merged = mergeAppSettings(untouched, { ai: { providers: { anthropic: { baseUrl: 'https://example.test', enabled: false } } } });
  assert.equal(merged.ai.providers.anthropic?.enabled, false);
  assert.equal(merged.ai.providers.anthropic?.baseUrl, 'https://example.test');
  const back = mergeAppSettings(merged, { ai: { providers: { anthropic: { ...merged.ai.providers.anthropic, enabled: true } } } });
  assert.equal(back.ai.providers.anthropic?.enabled, true);
});

test('instruction source and working style are sanitized and merged', () => {
  const defaults = sanitizeAppSettings({});
  assert.deepEqual(defaults.ai.workingStyle, { enabled: true, text: '' });
  assert.equal(defaults.ai.nativeSources.instructionSource, 'all');

  const raw = sanitizeAppSettings({
    ai: { workingStyle: { enabled: false, text: 'Mine.' }, nativeSources: { instructionSource: 'claude' }, agentRuntimes: { 'praxis-implementer': 'codex-cli' } }
  });
  assert.deepEqual(raw.ai.workingStyle, { enabled: false, text: 'Mine.' });
  assert.equal(raw.ai.nativeSources.instructionSource, 'claude');
  assert.equal('agentRuntimes' in raw.ai, false, 'the retired "Runs on" choices are dropped');
  assert.equal(sanitizeAppSettings({ ai: { nativeSources: { instructionSource: 'nope' } } }).ai.nativeSources.instructionSource, 'all');

  const merged = mergeAppSettings(raw, { ai: { workingStyle: { enabled: true } } });
  assert.deepEqual(merged.ai.workingStyle, { enabled: true, text: 'Mine.' });
});

test('settings without custom endpoints round-trip with no customProviders key', () => {
  const stored = {
    ai: { activeProvider: 'anthropic', providers: { anthropic: { defaultModel: 'claude-sonnet-4-6' }, openai: { enabled: false } } }
  };
  const once = sanitizeAppSettings(stored);
  assert.equal('customProviders' in once.ai, false);
  assert.deepEqual(sanitizeAppSettings(JSON.parse(JSON.stringify(once))).ai, once.ai);
});

test('custom endpoints are validated, and a stale custom id falls back to the default provider', () => {
  const settings = sanitizeAppSettings({
    ai: {
      activeProvider: 'custom:gone',
      recommendationProvider: 'custom:ollama',
      providers: { 'custom:ollama': { defaultModel: 'llama3.1', added: true }, 'custom:gone': { enabled: false } },
      customProviders: [
        { id: 'custom:ollama', label: 'Ollama', protocol: 'openai-chat', baseUrl: 'http://localhost:11434/', apiPath: 'v1/', auth: { kind: 'none' } },
        { id: 'custom:ollama', label: 'Duplicate', protocol: 'openai-chat', baseUrl: 'http://x', apiPath: '', auth: { kind: 'none' } },
        { id: 'custom:BAD ID', label: 'Bad', protocol: 'openai-chat', baseUrl: 'http://x', apiPath: '', auth: { kind: 'none' } },
        { id: 'custom:ftp', label: 'Ftp', protocol: 'openai-chat', baseUrl: 'ftp://x', apiPath: '', auth: { kind: 'none' } },
        { id: 'custom:hdr', label: 'Hdr', protocol: 'openai-chat', baseUrl: 'https://x', apiPath: '', auth: { kind: 'bearer' },
          headers: { 'HTTP-Referer': 'https://praxis', 'X-Auth-Token': 'leak', Authorization: 'Bearer leak' } }
      ]
    }
  });
  assert.equal(settings.ai.activeProvider, 'vercel-gateway');
  assert.equal(settings.ai.recommendationProvider, 'custom:ollama');
  assert.deepEqual(settings.ai.customProviders?.map(p => p.id), ['custom:ollama', 'custom:hdr']);
  assert.equal(settings.ai.customProviders?.[0].baseUrl, 'http://localhost:11434');
  assert.equal(settings.ai.customProviders?.[0].apiPath, '/v1');
  assert.deepEqual(settings.ai.customProviders?.[1].headers, { 'HTTP-Referer': 'https://praxis' });
  assert.deepEqual(settings.ai.providers['custom:ollama'], { defaultModel: 'llama3.1', added: true });
  assert.equal(settings.ai.providers['custom:gone'], undefined);
});

test('removing a custom endpoint drops the settings that pointed at it', () => {
  const endpoint = { id: 'custom:lab' as const, label: 'Lab', protocol: 'openai-chat' as const, baseUrl: 'http://10.0.0.2:8000', apiPath: '/v1', auth: { kind: 'none' as const } };
  const withEndpoint = mergeAppSettings(DEFAULT_APP_SETTINGS, {
    ai: { customProviders: [endpoint], activeProvider: 'custom:lab', providers: { 'custom:lab': { defaultModel: 'm' } }, modelTiers: { 'custom:lab': { fast: 'm' } } }
  });
  assert.equal(withEndpoint.ai.activeProvider, 'custom:lab');
  assert.equal(withEndpoint.ai.providers['custom:lab']?.defaultModel, 'm');
  const removed = mergeAppSettings(withEndpoint, { ai: { customProviders: [] } });
  assert.equal('customProviders' in removed.ai, false);
  assert.equal(removed.ai.activeProvider, 'vercel-gateway');
  assert.equal(removed.ai.providers['custom:lab'], undefined);
  assert.equal(removed.ai.modelTiers?.['custom:lab'], undefined);
});

test('preview enableEasyMode defaults to false and can be merged', () => {
  assert.equal(DEFAULT_APP_SETTINGS.preview.enableEasyMode, false);
  assert.equal(sanitizeAppSettings({}).preview.enableEasyMode, false);
  assert.equal(sanitizeAppSettings({ preview: { enableEasyMode: true } }).preview.enableEasyMode, true);
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { preview: { enableEasyMode: true } });
  assert.equal(merged.preview.enableEasyMode, true);
  assert.ok(DEFAULT_APP_SETTINGS.appearance.installedThemeIds.includes('simple'));
});

test('preview enableDeployments defaults to false and can be merged', () => {
  assert.equal(DEFAULT_APP_SETTINGS.preview.enableDeployments, false);
  assert.equal(sanitizeAppSettings({}).preview.enableDeployments, false);
  assert.equal(sanitizeAppSettings({ preview: { enableDeployments: true } }).preview.enableDeployments, true);
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { preview: { enableDeployments: true } });
  assert.equal(merged.preview.enableDeployments, true);
});

test('appearance zoomFactor defaults to 1 and is sanitized and merged within 0.7 - 1.5 limits', () => {
  assert.equal(DEFAULT_APP_SETTINGS.appearance.zoomFactor, 1);
  assert.equal(sanitizeAppSettings({}).appearance.zoomFactor, 1);
  assert.equal(sanitizeAppSettings({ appearance: { zoomFactor: 1.2 } }).appearance.zoomFactor, 1.2);
  // Clamped bounds
  assert.equal(sanitizeAppSettings({ appearance: { zoomFactor: 0.2 } }).appearance.zoomFactor, 0.7);
  assert.equal(sanitizeAppSettings({ appearance: { zoomFactor: 3.0 } }).appearance.zoomFactor, 1.5);
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { appearance: { zoomFactor: 1.3 } });
  assert.equal(merged.appearance.zoomFactor, 1.3);
});



test('removed built-in providers stay removed across settings reads and unrelated patches', () => {
  const removed = sanitizeAppSettings({ ai: { providers: { openai: { added: false, enabled: false } } } });
  assert.equal(removed.ai.providers.openai?.added, false);
  const patched = mergeAppSettings(removed, { ai: { defaultModel: 'another-model' } });
  assert.equal(patched.ai.providers.openai?.added, false);
  const added = mergeAppSettings(patched, { ai: { providers: { openai: { ...patched.ai.providers.openai, added: true, enabled: true } } } });
  assert.equal(added.ai.providers.openai?.added, true);
  assert.equal(added.ai.providers.openai?.enabled, true);
});

test('code intelligence settings default to enabled with empty project overrides and merge cleanly', () => {
  assert.equal(DEFAULT_APP_SETTINGS.ai.codeIntelligence?.enabled, true);
  assert.deepEqual(DEFAULT_APP_SETTINGS.ai.codeIntelligence?.projectOverrides, {});

  const sanitizedEmpty = sanitizeAppSettings({});
  assert.equal(sanitizedEmpty.ai.codeIntelligence?.enabled, true);
  assert.deepEqual(sanitizedEmpty.ai.codeIntelligence?.projectOverrides, {});

  const sanitizedExplicit = sanitizeAppSettings({
    ai: {
      codeIntelligence: {
        enabled: false,
        projectOverrides: {
          '/repo/a': true,
          '/repo/b': false
        }
      }
    }
  });
  assert.equal(sanitizedExplicit.ai.codeIntelligence?.enabled, false);
  assert.deepEqual(sanitizedExplicit.ai.codeIntelligence?.projectOverrides, {
    '/repo/a': true,
    '/repo/b': false
  });

  const merged = mergeAppSettings(sanitizedExplicit, {
    ai: {
      codeIntelligence: {
        projectOverrides: {
          '/repo/c': true
        },
        searchMode: 'lexical',
        projectSearchModes: {
          '/repo/a': 'vector'
        }
      }
    }
  });
  assert.equal(merged.ai.codeIntelligence?.enabled, false);
  assert.equal(merged.ai.codeIntelligence?.searchMode, 'lexical');
  assert.deepEqual(merged.ai.codeIntelligence?.projectSearchModes, {
    '/repo/a': 'vector'
  });
  assert.deepEqual(merged.ai.codeIntelligence?.projectOverrides, {
    '/repo/a': true,
    '/repo/b': false,
    '/repo/c': true
  });
});


test('a provider keeps the model ids it was curated against, and drops a malformed list', () => {
  const kept = sanitizeAppSettings({ ai: { providers: { openai: { enabledModelIds: ['a'], knownModelIds: ['a', 'b'] } } } });
  assert.deepEqual(kept.ai.providers.openai?.knownModelIds, ['a', 'b']);
  const dropped = sanitizeAppSettings({ ai: { providers: { openai: { enabledModelIds: ['a'], knownModelIds: ['a', 3] } } } });
  assert.equal(dropped.ai.providers.openai?.knownModelIds, undefined);
});

test('retired preview flags are discarded while the EasyMode preference is preserved', () => {
  const settings = sanitizeAppSettings({ preview: {
    enableCreateIdea: false, enableNewProject: false, boardsSidebarMode: 'work',
    enableEasyMode: true, enableDeployments: true, enableScheduledRuns: true
  } });
  assert.deepEqual(settings.preview, { enableEasyMode: true, enableDeployments: true });
});


test('global accent accepts only hex colors, persists through theme changes, and clears to theme defaults', () => {
  const base = sanitizeAppSettings({ appearance: { activeLookId: 'look-blueprint' } });
  assert.equal(base.appearance.activeLookId, 'look-blueprint');
  assert.equal(base.appearance.accentColor, '');
  assert.equal(sanitizeAppSettings({ appearance: { accentColor: '#12ABcd' } }).appearance.accentColor, '#12abcd');
  for (const accentColor of ['red', '#abc', '#12345678', '#123456\n', 'url(https://example.com)', '#123456; color:red', 42, null]) {
    assert.equal(sanitizeAppSettings({ appearance: { accentColor } }).appearance.accentColor, '');
  }
  const accented = mergeAppSettings(base, { appearance: { accentColor: '#ffcc00' } });
  assert.equal(accented.appearance.activeLookId, base.appearance.activeLookId);
  assert.deepEqual(accented.appearance.looks, base.appearance.looks);
  const switched = mergeAppSettings(accented, { appearance: { themeId: 'praxis-dark', themeMode: 'dark' } });
  assert.equal(switched.appearance.accentColor, '#ffcc00');
  assert.equal(mergeAppSettings(switched, { appearance: { accentColor: '' } }).appearance.accentColor, '');
});

test('prompt analysis routing is sanitized, independent and clearable', () => {
  const settings = sanitizeAppSettings({ ai: { recommendationProvider: 'openai', promptAnalysisProvider: 'anthropic', promptAnalysisModel: '  clarity-model  ' } });
  assert.equal(settings.ai.promptAnalysisProvider, 'anthropic');
  assert.equal(settings.ai.promptAnalysisModel, 'clarity-model');
  const cleared = mergeAppSettings(settings, { ai: { promptAnalysisProvider: undefined, promptAnalysisModel: undefined } });
  assert.equal(cleared.ai.promptAnalysisProvider, undefined);
  assert.equal(cleared.ai.promptAnalysisModel, undefined);
  assert.equal(cleared.ai.recommendationProvider, 'openai');
});

test('prompt checks use their own provider and model without changing recommendations', async () => {
  const secrets = { get: async () => 'test-key', store: async () => {}, delete: async () => {} };
  const settings = sanitizeAppSettings({ ai: { recommendationProvider: 'openai', promptAnalysisProvider: 'anthropic', promptAnalysisModel: 'clarity-model' } });
  assert.equal((await resolvePromptCheckProvider(secrets, settings.ai))?.provider, 'anthropic');
  assert.equal((await resolvePromptCheckProvider(secrets, settings.ai))?.model, 'clarity-model');
  assert.equal((await resolveRecommendationProvider(secrets, settings.ai)).provider, 'openai');
  settings.ai.providers.anthropic = { ...settings.ai.providers.anthropic, enabled: false };
  assert.equal(await resolvePromptCheckProvider(secrets, settings.ai), undefined);
  settings.ai.promptAnalysisProvider = undefined;
  settings.ai.promptAnalysisModel = undefined;
  assert.equal((await resolvePromptCheckProvider(secrets, settings.ai))?.provider, 'openai');
});


test('activity words are bounded, normalized, persisted and default safely', () => {
  const words = (value: unknown) => sanitizeAppSettings({ ai: { activityWords: value } }).ai.activityWords;
  for (const value of [undefined, null, 'Thinking', [], [false, '', '   ']]) {
    assert.deepEqual(words(value), ['Thinking', 'Working', 'Pondering']);
  }
  assert.deepEqual(words([' Musing ', 'Musing', 'Hello\nthere', 42]), ['Musing', 'Hello there']);
  assert.equal(words(['a'.repeat(100)])![0].length, 32);
  assert.equal(words(Array.from({ length: 30 }, (_, i) => `Word ${i}`))!.length, 20);
  const merged = mergeAppSettings(DEFAULT_APP_SETTINGS, { ai: { activityWords: ['Musing'] } });
  assert.deepEqual(merged.ai.activityWords, ['Musing']);
  assert.equal(merged.ai.agentName, DEFAULT_APP_SETTINGS.ai.agentName);
});
