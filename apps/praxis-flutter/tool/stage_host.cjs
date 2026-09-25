#!/usr/bin/env node
/*
 * A development desktop for the mobile apps: the desktop's real LAN listener
 * (Noise IK, status frames, pairing) and real mobile host services, over a
 * deterministic project with every surface the phone can show — markdown
 * replies, every gadget kind, runs awaiting approval / failed / running,
 * a pending permission, changes with diffs, providers and models.
 *
 * Both the Expo and the Flutter app can pair with it, so the same data can be
 * compared screen by screen. Nothing here reaches a model or a repository.
 *
 *   npm run build:core && npm --prefix apps/praxis-desktop/main run compile   (once)
 *   node apps/praxis-flutter/tool/stage_host.cjs [--port 43110] [--control 43191]
 *
 * It prints a pairing invitation (the compact QR text). The control port takes
 *   GET /theme/light | /theme/dark | /theme/none   switch the desktop theme live
 *   GET /reply            stream a new agent reply into the first chat
 *   GET /permission       raise a new permission request
 *   GET /fail-next        make the next message to a session fail (to test Retry)
 *   GET /invitation       the invitation text again
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../../..');
const core = require(path.join(repo, 'packages/core'));
const protocol = require(path.join(repo, 'packages/mobile-protocol'));
const { MobileLanServer } = require(path.join(repo, 'apps/praxis-desktop/main/out/main/mobileLanServer.js'));
const { createMobileHostReads, createMobileHostExecutionHandlers } = require(path.join(repo, 'apps/praxis-desktop/main/out/main/mobileHostServices.js'));

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const PORT = Number(arg('port', '43110'));
const CONTROL_PORT = Number(arg('control', '43191'));
const HOST_ID = 'stage-host';
const HOST_NAME = 'Praxis stage desktop';
const PROJECT_ID = 'praxis';
const PROJECT_NAME = 'Praxis';
const INVITATION_TOKEN = 'stage-invitation-01';
const STATE_DIR = path.join(__dirname, '.stage-host');
fs.mkdirSync(STATE_DIR, { recursive: true });

const toHex = bytes => Buffer.from(bytes).toString('hex');
const fromHex = hex => new Uint8Array(Buffer.from(hex, 'hex'));

// The host key and paired phones survive restarts, as on a real desktop.
const keyFile = path.join(STATE_DIR, 'host-key.hex');
const hostKey = fs.existsSync(keyFile)
  ? protocol.generateKeyPair(fromHex(fs.readFileSync(keyFile, 'utf8').trim()))
  : protocol.generateKeyPair();
fs.writeFileSync(keyFile, toHex(hostKey.privateKey));
const pairedFile = path.join(STATE_DIR, 'paired.json');
const paired = new Map(fs.existsSync(pairedFile) ? JSON.parse(fs.readFileSync(pairedFile, 'utf8')) : []);
const savePaired = () => fs.writeFileSync(pairedFile, JSON.stringify([...paired.entries()], null, 2));

const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------- appearance

const HEX_TILE_W = 34.64;
const HEX_TILE_H = 60;
function hexLatticeSvg(stroke, spread = 520) {
  const r = 20;
  const hex = (cx, cy) => {
    const points = [];
    for (let i = 0; i < 6; i += 1) {
      const angle = (Math.PI / 180) * (60 * i - 90);
      points.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
    }
    return `M${points.join('L')}Z`;
  };
  const d = [hex(17.32, 20), hex(0, 50), hex(34.64, 50)].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spread}" height="${spread}" viewBox="0 0 ${spread} ${spread}">` +
    '<defs>' +
    '<linearGradient id="sf" x1="1" y1="0" x2="0.2" y2="0.8">' +
    '<stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.75" stop-color="#fff" stop-opacity="0"/>' +
    '</linearGradient>' +
    `<mask id="sm"><rect width="${spread}" height="${spread}" fill="url(#sf)"/></mask>` +
    `<pattern id="sp" width="${HEX_TILE_W}" height="${HEX_TILE_H}" patternUnits="userSpaceOnUse">` +
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"/>` +
    '</pattern>' +
    '</defs>' +
    `<rect width="${spread}" height="${spread}" fill="url(#sp)" mask="url(#sm)"/>` +
    '</svg>';
}

const THEMES = {
  light: {
    themeId: 'praxis-light',
    themeName: 'Praxis Light',
    mode: 'light',
    colors: {
      bg: '#f5f2eb', bgElevated: '#fffdf8', bgSunken: '#ebe7de', bgInput: '#fffaf2',
      border: '#d5c8b8', borderStrong: '#ad9a85', text: '#2c2620', textSecondary: '#74695e',
      textTertiary: '#958878', accent: '#c6431f', accentContrast: '#fffdf8',
      success: '#3fb950', warning: '#d29922', danger: '#b94a48',
    },
    motif: { opacity: 0.55, layers: [{ svg: hexLatticeSvg('#c6431f'), width: 520, height: 520, anchor: 'top-right', repeat: false }], viewport: { width: 1440, height: 900 } },
  },
  dark: {
    themeId: 'praxis-dark',
    themeName: 'Praxis Dark',
    mode: 'dark',
    colors: {
      bg: '#100e0b', bgElevated: '#2c2620', bgSunken: '#0b0907', bgInput: '#211c17',
      border: '#443a30', borderStrong: '#6c5b4a', text: '#f0e7d8', textSecondary: '#cdbfae',
      textTertiary: '#958878', accent: '#c6431f', accentContrast: '#fffdf8',
      success: '#3fb950', warning: '#d29922', danger: '#e2766d',
    },
    motif: { opacity: 0.4, layers: [{ svg: hexLatticeSvg('#ef6a3f'), width: 520, height: 520, anchor: 'top-right', repeat: false }], viewport: { width: 1440, height: 900 } },
  },
};
let appearance = THEMES[arg('theme', 'light')] ?? THEMES.light;

// ---------------------------------------------------------------- event log

const ledger = new core.InMemoryMobileCommandLedger();
function emit(event, target = {}) {
  const sequence = ledger.latestSequence() + 1;
  ledger.appendEvent({
    protocolVersion: core.MOBILE_PROTOCOL_VERSION,
    eventId: `stage-${sequence}`,
    sequence,
    emittedAt: new Date().toISOString(),
    target: { hostId: HOST_ID, ...target },
    event,
  });
  return sequence;
}

// ---------------------------------------------------------------- catalog

const catalog = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  providers: [
    { provider: 'anthropic', label: 'Anthropic', kind: 'api', available: true, defaultModel: 'claude-sonnet-4-6' },
    { provider: 'codex-cli', label: 'Codex CLI (local)', kind: 'cli-agent', available: true },
    { provider: 'claude-code', label: 'Claude Code (local)', kind: 'cli-agent', available: true, defaultModel: 'sonnet' },
    { provider: 'openai', label: 'OpenAI', kind: 'api', available: false, unavailableReason: 'not-configured', unavailableMessage: 'OpenAI has no API key on the desktop. Add one in Settings → AI Provider.' },
  ],
  sessionModes: [
    { mode: 'chat', available: true, toolAccess: 'full' },
    { mode: 'analysis', available: true, toolAccess: 'read-only' },
    { mode: 'review', available: true, toolAccess: 'read-only' },
  ],
};
const modelCatalogs = {
  anthropic: { provider: 'anthropic', status: 'ok', defaultModel: 'claude-sonnet-4-6', models: [
    { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 200000 },
    { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextLength: 200000 },
    { modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextLength: 200000 },
  ] },
  'codex-cli': { provider: 'codex-cli', status: 'ok', models: [{ modelId: 'gpt-5.5', name: 'GPT-5.5' }, { modelId: 'gpt-5.5-mini', name: 'GPT-5.5 mini' }] },
  'claude-code': { provider: 'claude-code', status: 'ok', defaultModel: 'sonnet', models: [{ modelId: 'sonnet', name: 'Sonnet' }, { modelId: 'opus', name: 'Opus' }, { modelId: 'haiku', name: 'Haiku' }] },
};
const labelOf = provider => catalog.providers.find(option => option.provider === provider)?.label ?? provider;

// ---------------------------------------------------------------- sessions

const sessions = new Map();
let messageCounter = 0;
const message = (role, text, at, extra = {}) => ({ id: `m${(messageCounter += 1)}`, role, text, at, status: 'complete', ...extra });

function session(input) {
  const record = {
    projectId: PROJECT_ID,
    archived: false,
    mode: 'chat',
    messages: [],
    pendingPermissions: [],
    canContinue: true,
    canCancel: false,
    ...input,
  };
  sessions.set(record.sessionId, record);
  return record;
}

const MARKDOWN_REPLY = [
  '## Pairing flow, tidied',
  '',
  'I split the **invitation parsing** from the *connection* code so each can be tested on its own.',
  '',
  '### What changed',
  '',
  '1. `parseMobileInvitation` accepts the compact QR text, JSON, or a bare key.',
  '2. Expired invitations are refused **before** a socket opens.',
  '3. The connect screen says *why* a connection failed.',
  '',
  '- [x] QR scanning',
  '- [x] Pasted invitations',
  '- [ ] Discovery hints',
  '  - multicast listener',
  '  - fingerprint check',
  '',
  '```ts',
  'export function parseMobileInvitation(raw: string): MobileInvitationParse {',
  '  const value = raw.trim();',
  "  if (HEX_KEY.test(value)) return { kind: 'key', details: { hostPublicKeyHex: value } };",
  '}',
  '```',
  '',
  '| File | Change | Tests |',
  '| --- | :---: | ---: |',
  '| `mobilePairingInvitation.ts` | parse | 14 |',
  '| `ConnectScreen.tsx` | UI | 3 |',
  '',
  '> The desktop still decides whether a phone is trusted; the phone only pins its key.',
  '',
  'See the [pairing notes](https://github.com/davidacres/praxis) for the protocol. ~~The old flow~~ is gone.',
  '',
  '---',
  '',
  'Run `npm run test:mobile` to check.',
].join('\n');

session({
  sessionId: 'sess-pairing',
  sessionKey: 'PRX-128',
  title: 'Refactor the mobile pairing flow',
  lifecycle: 'completed',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  startedAt: iso(-3 * HOUR),
  completedAt: iso(-2 * HOUR),
  tokenUsage: { inputTokens: 31800, outputTokens: 2480, totalTokens: 34280 },
  contextTokens: 41200,
  contextLimit: 200000,
  cost: { currency: 'USD', amount: 0.1284 },
  messages: [
    message('user', 'Can you tidy up how the phone presents its pairing invitation? Keep the QR path working.', iso(-3 * HOUR)),
    message('assistant', MARKDOWN_REPLY, iso(-3 * HOUR + 4 * MIN), {
      model: 'claude-sonnet-4-6',
      tokenUsage: { inputTokens: 18400, outputTokens: 1240, totalTokens: 19640 },
      cost: { currency: 'USD', amount: 0.0712 },
    }),
    message('system', 'Model changed to Claude Sonnet 4.6', iso(-2.5 * HOUR)),
    message('user', 'Great — what is left?', iso(-2.2 * HOUR)),
    message('assistant', 'Only the **discovery hints** remain. I would add them behind the existing `listenForMobileHosts` hook so the manual path stays the fallback.', iso(-2 * HOUR), {
      model: 'claude-sonnet-4-6',
      tokenUsage: { inputTokens: 13400, outputTokens: 1240, totalTokens: 14640 },
      cost: { currency: 'USD', amount: 0.0572 },
    }),
  ],
});

const scope = sessionId => ({ hostId: HOST_ID, projectId: PROJECT_ID, sessionId });
const gadget = (sessionId, gadgetId, kind, payload, actions, fallbackText) => ({
  version: 1, gadgetId, kind, scope: scope(sessionId), issuedAt: iso(-40 * MIN), fallbackText, payload, actions,
});
const view = (envelope, state = 'active', result) => ({ gadget: envelope, state, ...(result ? { result } : {}) });

const RELEASE = 'sess-release';
session({
  sessionId: RELEASE,
  sessionKey: 'PRX-131',
  title: 'Prepare the 0.9 release',
  lifecycle: 'awaiting-input',
  provider: 'codex-cli',
  model: 'gpt-5.5',
  startedAt: iso(-50 * MIN),
  tokenUsage: { inputTokens: 9200, outputTokens: 880, totalTokens: 10080 },
  messages: [
    message('user', 'Get the 0.9 release ready. Ask me anything you need.', iso(-50 * MIN)),
    message('assistant', 'I need a few decisions before I cut the release.', iso(-45 * MIN), {
      gadgets: [
        view(gadget(RELEASE, 'g-channel', 'choice', {
          question: 'Which channel should 0.9 ship to?',
          detail: 'Beta reaches **about 40** testers; stable goes to everyone.',
          options: [
            { value: 'beta', label: 'Beta', description: 'TestFlight and the beta feed' },
            { value: 'stable', label: 'Stable', description: 'Everyone, after review' },
            { value: 'internal', label: 'Internal only', disabledReason: 'No internal build is configured' },
          ],
          defaultValue: 'beta',
        }, [{ actionId: 'pick', label: 'Use this channel', effect: 'informational' }], 'Choose a channel: beta or stable.')),
        view(gadget(RELEASE, 'g-tag', 'confirmation', {
          question: 'Tag v0.9.0 on main?',
          detail: 'This pushes a tag that CI publishes from.',
          consequences: ['Creates the tag `v0.9.0`', 'Starts the release pipeline'],
        }, [
          { actionId: 'not-yet', label: 'Not yet', effect: 'informational' },
          { actionId: 'tag', label: 'Tag the release', effect: 'mutating', description: 'Pushes the v0.9.0 tag' },
        ], 'Confirm tagging v0.9.0.')),
        view(gadget(RELEASE, 'g-notes', 'form', {
          title: 'Release details',
          description: 'Used in the changelog and the store listing.',
          fields: [
            { name: 'headline', label: 'Headline', type: 'text', required: true, placeholder: 'One line for the changelog', maxLength: 80 },
            { name: 'notes', label: 'Notes', type: 'textarea', placeholder: 'What changed for people' },
            { name: 'build', label: 'Build number', type: 'number', min: 1, max: 999, defaultValue: 42 },
            { name: 'track', label: 'Track', type: 'select', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], defaultValue: 'fast' },
            { name: 'notify', label: 'Notify testers', type: 'boolean', defaultValue: true },
          ],
        }, [{ actionId: 'save', label: 'Save details', effect: 'mutating' }], 'Fill in the release details.')),
      ],
    }),
    message('assistant', 'Here is where the release stands.', iso(-40 * MIN), {
      gadgets: [
        view(gadget(RELEASE, 'g-table', 'table', {
          title: 'Open blockers',
          columns: [{ key: 'id', label: 'Issue', mono: true }, { key: 'title', label: 'Title' }, { key: 'days', label: 'Days', align: 'end' }],
          rows: [
            { id: 'PRX-120', title: 'Pairing times out on slow Wi-Fi', days: 3 },
            { id: 'PRX-124', title: 'Diff view clips long lines', days: 1 },
            { id: 'PRX-127', title: 'Usage panel shows stale cost', days: null },
          ],
          caption: 'Three issues are still open against 0.9.',
        }, [], 'Three blockers are open.')),
        view(gadget(RELEASE, 'g-chart', 'chart', {
          title: 'Crash-free sessions',
          chartKind: 'bar',
          series: [{ label: 'Crash-free %', points: [{ x: '0.6', y: 97.1 }, { x: '0.7', y: 98.4 }, { x: '0.8', y: 99.2 }, { x: '0.9 beta', y: 99.6 }] }],
          summary: 'Stability has improved every release.',
        }, [], 'Crash-free sessions are rising.')),
        view(gadget(RELEASE, 'g-progress', 'progress', {
          title: 'Release checklist',
          percent: 60,
          status: 'running',
          detail: '3 of 5 steps done.',
          steps: [
            { label: 'Changelog drafted', state: 'done' },
            { label: 'Version bumped', state: 'done' },
            { label: 'Store screenshots', state: 'done' },
            { label: 'Beta build uploaded', state: 'running' },
            { label: 'Announcement', state: 'pending' },
          ],
        }, [], 'The checklist is 60% done.')),
        view(gadget(RELEASE, 'g-diff', 'diff', {
          title: 'Version bump',
          summary: '2 files change.',
          files: [
            { path: 'apps/praxis-mobile/app.json', additions: 2, deletions: 2, status: 'modified', preview: '-  "version": "0.8.4",\n+  "version": "0.9.0",\n-  "buildNumber": "41"\n+  "buildNumber": "42"' },
            { path: 'CHANGELOG.md', additions: 14, deletions: 0, status: 'modified', preview: '+## 0.9.0\n+\n+- Pair by QR code\n+- Answer questions from the phone' },
          ],
        }, [{ actionId: 'apply', label: 'Apply bump', effect: 'mutating' }, { actionId: 'skip', label: 'Leave it', effect: 'informational' }], 'Bump the version to 0.9.0.')),
        view(gadget(RELEASE, 'g-artifacts', 'artifact', {
          title: 'Build outputs',
          artifacts: [
            { name: 'Praxis.ipa', path: 'build/ios/Praxis.ipa', sizeBytes: 48_300_000, description: 'Release build for TestFlight' },
            { name: 'release-notes.md', path: 'build/release-notes.md', sizeBytes: 2_140 },
          ],
        }, [], 'Two build outputs are ready.')),
      ],
    }),
    message('assistant', 'Two more things need you.', iso(-35 * MIN), {
      gadgets: [
        view(gadget(RELEASE, 'g-handoff', 'handoff', {
          title: 'Hand over to Claude Code for the store listing?',
          fromProvider: 'Codex CLI (local)',
          toProvider: 'Claude Code (local)',
          contextSummary: 'The version is bumped and the changelog is drafted. The **store listing copy** is still to write.',
          includedItems: [{ label: 'Changelog draft' }, { label: 'Screenshots' }],
          excludedItems: [{ label: 'Signing keys', reason: 'never leave the desktop' }],
          warning: 'The new provider starts a fresh turn with this summary.',
        }, [{ actionId: 'handover', label: 'Hand over', effect: 'mutating' }], 'Hand the listing over to Claude Code.'), 'completed', { status: 'completed', message: 'Handed over on the desktop.' }),
        view(gadget(RELEASE, 'g-conflict', 'conflict', {
          title: 'Merge conflict in app.json',
          description: 'Both branches changed the build number.',
          conflicts: [{ id: 'build', label: 'buildNumber', path: 'apps/praxis-mobile/app.json', ours: '"buildNumber": "42"', theirs: '"buildNumber": "43"' }],
        }, [{ actionId: 'resolve', label: 'Resolve', effect: 'mutating' }], 'Choose which build number to keep.')),
        view(gadget(RELEASE, 'g-approval', 'approval', {
          title: 'Publish to the beta channel',
          summary: 'Uploads **build 42** to TestFlight and notifies testers.',
          gate: 'release',
          requestedBy: 'Codex CLI (local)',
          effect: 'Testers receive build 42 within the hour.',
          evidence: [{ label: 'Tests', value: '412 passed' }, { label: 'Lint', value: 'clean' }, { label: 'Size', value: '48.3 MB' }],
        }, [{ actionId: 'reject', label: 'Hold', effect: 'informational' }, { actionId: 'approve', label: 'Publish', effect: 'approval' }], 'Approve publishing build 42 to beta.')),
      ],
    }),
  ],
});

session({
  sessionId: 'sess-ci',
  sessionKey: 'PRX-133',
  title: 'Speed up CI caching',
  lifecycle: 'active',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  startedAt: iso(-12 * MIN),
  canCancel: true,
  canContinue: false,
  tokenUsage: { inputTokens: 5100, outputTokens: 420, totalTokens: 5520 },
  pendingPermissions: [{ requestId: 'perm-npm-ci', summary: 'Run `npm ci` in apps/praxis-desktop', detail: 'The agent wants to install dependencies to measure the cold-cache build time.', createdAt: iso(-3 * MIN) }],
  messages: [
    message('user', 'CI takes nine minutes. Find where the cache misses and fix it.', iso(-12 * MIN)),
    message('assistant', 'The `node_modules` cache key includes the lockfile **and** the runner image, so every image update misses. I will measure a cold install first', iso(-4 * MIN), { status: 'streaming' }),
  ],
});

session({
  sessionId: 'sess-bundle',
  sessionKey: 'PRX-119',
  title: 'Audit the renderer bundle size',
  lifecycle: 'completed',
  mode: 'analysis',
  provider: 'claude-code',
  model: 'sonnet',
  startedAt: iso(-26 * HOUR),
  completedAt: iso(-25 * HOUR),
  tokenUsage: { inputTokens: 64000, outputTokens: 3100, totalTokens: 67100 },
  messages: [
    message('user', 'Why is the renderer bundle 4 MB?', iso(-26 * HOUR)),
    message('assistant', 'Most of it is **three** things:\n\n- `markdown-it` plugins (0.9 MB)\n- the theme packs (1.1 MB)\n- source maps shipped by mistake (1.4 MB)\n\nDropping the source maps alone halves the download.', iso(-25 * HOUR)),
  ],
});

// ---------------------------------------------------------------- runs

const RUN_RELEASE = 'r1d8c3a0-5b7e-4f21-9a64-0c3e2f1b7d55';
const RUN_NIGHTLY = 'b7e2a911-3c44-4d0e-8f12-6a5b4c3d2e10';
const RUN_DOCS = 'c3f5d7e9-1a2b-4c3d-9e8f-7a6b5c4d3e21';
const RUN_LIVE = 'd41a6c2e-8b9f-4a70-b3c1-2e5d7f9a0b36';
const stageKey = (runId, node) => `WF-${runId.slice(0, 8).toUpperCase()}-${node}`;

session({
  sessionId: 'sess-r1-plan',
  sessionKey: stageKey(RUN_RELEASE, 'plan'),
  runId: RUN_RELEASE,
  title: 'Plan · FX-BE-091',
  lifecycle: 'completed',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  startedAt: iso(-5 * HOUR),
  completedAt: iso(-4.8 * HOUR),
  tokenUsage: { inputTokens: 12000, outputTokens: 900, totalTokens: 12900 },
  cost: { currency: 'USD', amount: 0.049 },
  messages: [
    message('user', 'Plan FX-BE-091: approve workflow gates from the phone.', iso(-5 * HOUR)),
    message('assistant', '### Plan\n\n1. Add `workflowGates.reject` to the host surface.\n2. Show the approval context on the phone.\n3. Require Face ID before approving.', iso(-4.8 * HOUR)),
  ],
});
session({
  sessionId: 'sess-r1-impl',
  sessionKey: stageKey(RUN_RELEASE, 'implement'),
  runId: RUN_RELEASE,
  title: 'Implement · FX-BE-091',
  lifecycle: 'completed',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  startedAt: iso(-4.7 * HOUR),
  completedAt: iso(-3.9 * HOUR),
  messages: [
    message('user', 'Implement the plan.', iso(-4.7 * HOUR)),
    message('assistant', 'Implemented the three steps. The second attempt fixed a failing snapshot test.', iso(-3.9 * HOUR)),
  ],
});
session({
  sessionId: 'sess-live-impl',
  sessionKey: stageKey(RUN_LIVE, 'implement'),
  runId: RUN_LIVE,
  title: 'Implement · FX-BE-093',
  lifecycle: 'active',
  provider: 'codex-cli',
  model: 'gpt-5.5',
  startedAt: iso(-6 * MIN),
  canCancel: true,
  canContinue: false,
  messages: [
    message('user', 'Implement FX-BE-093: offline banner on the phone.', iso(-6 * MIN)),
    message('assistant', 'Adding the banner to `ui.tsx` and wiring it to the sync state', iso(-1 * MIN), { status: 'streaming' }),
  ],
});

const runs = new Map();
function run(input) {
  runs.set(input.runId, { projectId: PROJECT_ID, paused: false, canApprove: false, sequence: 0, ...input });
}
run({
  runId: RUN_RELEASE,
  workflowName: 'Governed delivery · FX-BE-091',
  status: 'awaiting-approval',
  explanation: 'Every check passed; the release gate is waiting for a person to approve.',
  startedAt: iso(-5 * HOUR),
  issueKey: 'FX-BE-091',
  aiProvider: 'anthropic',
  aiModel: 'claude-sonnet-4-6',
  currentNodeId: 'approve',
  canApprove: true,
  stages: [
    { nodeId: 'plan', name: 'Plan', type: 'agent-task', lane: 'done', attempts: 1, sessionId: 'sess-r1-plan', sessionKey: stageKey(RUN_RELEASE, 'plan'), provider: 'anthropic' },
    { nodeId: 'implement', name: 'Implement', type: 'agent-task', lane: 'done', attempts: 2, sessionId: 'sess-r1-impl', sessionKey: stageKey(RUN_RELEASE, 'implement'), provider: 'anthropic' },
    { nodeId: 'tests', name: 'Unit tests', type: 'check', lane: 'done', attempts: 1, command: 'npm run test:core', exitCode: 0, metrics: { passed: 412, failed: 0, duration: '38s' } },
    { nodeId: 'review', name: 'Code review', type: 'agent-task', lane: 'done', attempts: 1, provider: 'codex-cli', findingsSummary: { minor: 3, major: 1 } },
    { nodeId: 'join', name: 'Join', type: 'join', lane: 'done', attempts: 1 },
    { nodeId: 'approve', name: 'Release approval', type: 'approval', lane: 'awaiting', attempts: 1, gate: 'release', prompt: 'Approve shipping FX-BE-091 to the beta channel? Review found one major finding, since fixed.' },
    { nodeId: 'deploy', name: 'Deploy to beta', type: 'deployment', lane: 'idle', attempts: 0 },
  ],
});
run({
  runId: RUN_NIGHTLY,
  workflowName: 'Nightly checks',
  status: 'failed',
  explanation: 'Lint failed in the renderer; retry once the fix lands.',
  startedAt: iso(-9 * HOUR),
  endedAt: iso(-8.9 * HOUR),
  currentNodeId: 'lint',
  stages: [
    { nodeId: 'install', name: 'Install', type: 'check', lane: 'done', attempts: 1, command: 'npm ci', exitCode: 0 },
    { nodeId: 'lint', name: 'Lint', type: 'check', lane: 'failed', attempts: 1, command: 'npm run lint', exitCode: 1, lastError: 'eslint: 3 problems (2 errors, 1 warning) in src/settings/themes.ts' },
    { nodeId: 'typecheck', name: 'Type check', type: 'check', lane: 'skipped', attempts: 0 },
  ],
});
run({
  runId: RUN_DOCS,
  workflowName: 'Docs refresh',
  status: 'succeeded',
  explanation: 'The docs were rebuilt and published.',
  startedAt: iso(-30 * HOUR),
  endedAt: iso(-29.5 * HOUR),
  currentNodeId: 'publish',
  stages: [
    { nodeId: 'build', name: 'Build docs', type: 'check', lane: 'done', attempts: 1, command: 'npm run docs', exitCode: 0 },
    { nodeId: 'publish', name: 'Publish', type: 'deployment', lane: 'done', attempts: 1 },
  ],
});
run({
  runId: RUN_LIVE,
  workflowName: 'Governed delivery · FX-BE-093',
  status: 'running',
  explanation: 'The implement step is running on Codex CLI.',
  startedAt: iso(-8 * MIN),
  issueKey: 'FX-BE-093',
  aiProvider: 'codex-cli',
  aiModel: 'gpt-5.5',
  currentNodeId: 'implement',
  stages: [
    { nodeId: 'plan', name: 'Plan', type: 'agent-task', lane: 'done', attempts: 1, provider: 'codex-cli' },
    { nodeId: 'implement', name: 'Implement', type: 'agent-task', lane: 'running', attempts: 1, sessionId: 'sess-live-impl', sessionKey: stageKey(RUN_LIVE, 'implement'), provider: 'codex-cli' },
    { nodeId: 'tests', name: 'Unit tests', type: 'check', lane: 'idle', attempts: 0 },
    { nodeId: 'approve', name: 'Release approval', type: 'approval', lane: 'idle', attempts: 0, gate: 'release' },
  ],
});

// ---------------------------------------------------------------- projections

function snapshotOf(record, sequence = ledger.latestSequence()) {
  const { ...copy } = record;
  return { ...copy, messages: record.messages.map(entry => ({ ...entry })), pendingPermissions: [...record.pendingPermissions], sequence };
}
function summaryOf(record) {
  const { messages: _m, pendingPermissions: _p, canContinue: _c, canCancel: _x, tokenUsage: _t, contextTokens: _ct, contextLimit: _cl, cost: _cost, ...summary } = record;
  return summary;
}
function runSnapshot(record, sequence = ledger.latestSequence()) {
  return { ...record, stages: record.stages.map(stage => ({ ...stage })), sequence };
}
function publishSession(record) {
  const sequence = ledger.latestSequence() + 1;
  emit({ type: 'session.snapshot', snapshot: snapshotOf(record, sequence) }, { projectId: PROJECT_ID, sessionId: record.sessionId });
}
function publishRun(record) {
  const sequence = ledger.latestSequence() + 1;
  record.sequence = sequence;
  emit({ type: 'run.snapshot', run: runSnapshot(record, sequence) }, { projectId: PROJECT_ID, runId: record.runId });
}
const OUTCOME = { done: 'succeeded', failed: 'failed', running: 'running', awaiting: 'awaiting-approval', skipped: 'skipped', paused: 'paused', idle: 'pending', ready: 'pending' };
function runSummary(record) {
  return {
    runId: record.runId,
    projectId: record.projectId,
    workflowName: record.workflowName,
    status: record.status,
    explanation: record.explanation,
    stages: record.stages.map(stage => ({
      nodeId: stage.nodeId,
      name: stage.name,
      outcome: OUTCOME[stage.lane] ?? stage.lane,
      lane: stage.lane,
      artifacts: stage.nodeId === 'implement' && stage.lane === 'done'
        ? [{ contractId: 'patch', kind: 'patch', path: 'changes/fx-be-091.patch' }, { contractId: 'notes', kind: 'markdown', path: 'docs/fx-be-091.md' }]
        : stage.nodeId === 'tests' && stage.lane === 'done' ? [{ contractId: 'junit', kind: 'test-report', path: 'reports/junit.xml' }] : [],
    })),
  };
}
function attentionItems() {
  const items = [];
  for (const record of sessions.values()) {
    for (const permission of record.pendingPermissions) {
      items.push({ id: `permission:${permission.requestId}`, kind: 'permission', hostId: HOST_ID, projectId: PROJECT_ID, sessionId: record.sessionId, requestId: permission.requestId, summary: permission.summary, detail: permission.detail, createdAt: permission.createdAt, resolved: false });
    }
  }
  for (const record of runs.values()) {
    if (record.status === 'awaiting-approval') items.push({ id: `approval:${record.runId}`, kind: 'approval', hostId: HOST_ID, projectId: PROJECT_ID, runId: record.runId, summary: record.workflowName, createdAt: record.startedAt, resolved: false });
    for (const stage of record.stages) {
      if (stage.lane === 'failed') items.push({ id: `failure:${record.runId}:${stage.nodeId}`, kind: 'failure', hostId: HOST_ID, projectId: PROJECT_ID, runId: record.runId, summary: `${record.workflowName} — ${stage.name}`, createdAt: record.startedAt, resolved: false });
    }
  }
  return items;
}

// ---------------------------------------------------------------- changes

const CHANGES = {
  'sess-pairing': {
    sessionId: 'sess-pairing',
    repository: true,
    branch: 'feat/pairing-flow',
    files: [
      { path: 'apps/praxis-mobile/renderer/mobilePairingInvitation.ts', status: 'modified', additions: 42, deletions: 18, reportedBySession: true },
      { path: 'apps/praxis-mobile/renderer/mobilePairingInvitation.test.ts', status: 'added', additions: 96, deletions: 0, reportedBySession: true },
      { path: 'apps/praxis-mobile/screens/ConnectScreen.tsx', status: 'modified', additions: 12, deletions: 7, reportedBySession: true },
      { path: 'apps/praxis-mobile/renderer/legacyPairing.ts', status: 'deleted', additions: 0, deletions: 64, reportedBySession: true },
      { path: 'package-lock.json', status: 'modified', additions: 3, deletions: 3, reportedBySession: false },
    ],
  },
};
function fileDiff(sessionId, file) {
  const listed = CHANGES[sessionId]?.files.find(entry => entry.path === file);
  if (!listed) throw new Error(`${file} is not among this session’s changes.`);
  if (listed.status === 'deleted') {
    return { path: file, binary: false, additions: 0, deletions: 3, truncated: true, hunks: [{ header: '@@ -1,64 +0,0 @@', lines: [
      { kind: 'delete', text: '/** The old pairing path. */', oldLine: 1 },
      { kind: 'delete', text: 'export function legacyPair(code: string): void {', oldLine: 2 },
      { kind: 'delete', text: '  throw new Error("use an invitation");', oldLine: 3 },
    ] }] };
  }
  return {
    path: file, binary: false, additions: 4, deletions: 2, truncated: false,
    hunks: [{
      header: '@@ -57,9 +57,11 @@ export function parseMobileInvitation(raw: string, now: Date = new Date())',
      lines: [
        { kind: 'context', text: '  const value = raw.trim();', oldLine: 57, newLine: 57 },
        { kind: 'delete', text: '  const expired = (at: string) => Date.parse(at) <= now.getTime();', oldLine: 58 },
        { kind: 'add', text: '  const expired = (expiresAt: string | undefined): boolean =>', newLine: 58 },
        { kind: 'add', text: '    (parseInstant(expiresAt) ?? Infinity) <= now.getTime();', newLine: 59 },
        { kind: 'context', text: "  if (HEX_KEY.test(value)) return { kind: 'key', details: { hostPublicKeyHex: value.toLowerCase() } };", oldLine: 59, newLine: 60 },
        { kind: 'delete', text: "  if (value.startsWith('P1|')) {", oldLine: 60 },
        { kind: 'add', text: '  if (/^P\\d+\\|/.test(value)) {', newLine: 61 },
        { kind: 'add', text: "    const [, hostId, key, endpoint, tokenId, expiresAt] = value.split('|');", newLine: 62 },
        { kind: 'context', text: '    const details: MobileInvitationDetails = {', oldLine: 61, newLine: 63 },
      ],
    }],
  };
}

// ---------------------------------------------------------------- streaming

let failNext = false;
const timers = new Map();
function streamReply(record, text, onDone) {
  clearInterval(timers.get(record.sessionId));
  const reply = message('assistant', '', new Date().toISOString(), { status: 'streaming', model: record.model });
  record.messages.push(reply);
  record.lifecycle = 'active';
  record.canCancel = true;
  record.canContinue = false;
  publishSession(record);
  const words = text.split(/(\s+)/);
  let index = 0;
  const timer = setInterval(() => {
    index = Math.min(words.length, index + 6);
    reply.text = words.slice(0, index).join('');
    if (index >= words.length) {
      clearInterval(timer);
      timers.delete(record.sessionId);
      reply.status = 'complete';
      reply.tokenUsage = { inputTokens: 2400 + text.length, outputTokens: Math.round(text.length / 4), totalTokens: 2400 + text.length + Math.round(text.length / 4) };
      record.tokenUsage = {
        inputTokens: (record.tokenUsage?.inputTokens ?? 0) + reply.tokenUsage.inputTokens,
        outputTokens: (record.tokenUsage?.outputTokens ?? 0) + reply.tokenUsage.outputTokens,
        totalTokens: (record.tokenUsage?.totalTokens ?? 0) + reply.tokenUsage.totalTokens,
      };
      if (record.provider === 'anthropic') {
        reply.cost = { currency: 'USD', amount: 0.0131 };
        record.cost = { currency: 'USD', amount: Number(((record.cost?.amount ?? 0) + 0.0131).toFixed(4)) };
      }
      record.lifecycle = 'completed';
      record.completedAt = new Date().toISOString();
      record.canCancel = false;
      record.canContinue = true;
      onDone?.();
    }
    publishSession(record);
  }, 250);
  timers.set(record.sessionId, timer);
}
const cannedReply = prompt => `You asked: *${prompt.slice(0, 60)}*.\n\nHere is what I did on the stage desktop:\n\n1. Read the relevant files.\n2. Made the change behind a flag.\n3. Ran \`npm test\` — **all green**.\n\nNothing was sent to a real model; this is the stage host.`;

// ---------------------------------------------------------------- host services

function findGadgetView(sessionId, gadgetId) {
  for (const entry of sessions.get(sessionId)?.messages ?? []) {
    const found = entry.gadgets?.find(candidate => candidate.gadget.gadgetId === gadgetId);
    if (found) return found;
  }
  return undefined;
}

const deps = {
  hostId: HOST_ID,
  hostName: () => HOST_NAME,
  hostOnline: () => true,
  hostEpoch: `stage-${Date.now().toString(36)}`,
  latestSequence: () => ledger.latestSequence(),
  appearance: () => appearance,
  providerCatalog: async () => catalog,
  modelCatalog: async provider => modelCatalogs[provider] ?? { provider, status: 'unavailable', message: 'The model list could not be read.', models: [] },
  describeDevice: async deviceId => {
    const entry = [...paired.values()].find(candidate => candidate.deviceId === deviceId);
    return {
      label: entry?.label ?? 'Phone',
      projects: [{ projectId: PROJECT_ID, name: PROJECT_NAME }],
      ...(entry?.pairedAt ? { pairedAt: entry.pairedAt } : {}),
      lastSeenAt: new Date().toISOString(),
      hostName: HOST_NAME,
      hostKeyFingerprint: toHex(crypto.createHash('sha256').update(hostKey.publicKey).digest()).slice(0, 16),
      accessMode: 'local-only',
    };
  },
  listProjects: async () => [{ projectId: PROJECT_ID, name: PROJECT_NAME, workflow: 'governed-delivery' }],
  getProject: async projectId => (projectId === PROJECT_ID ? { projectId, name: PROJECT_NAME, workflow: 'governed-delivery' } : undefined),
  listWork: async () => [],
  listSessions: async () => [...sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summaryOf),
  getSession: async sessionId => (sessions.has(sessionId) ? snapshotOf(sessions.get(sessionId)) : undefined),
  listWorkflows: async () => [
    { workflowId: 'governed-delivery', name: 'Governed delivery', trigger: 'manual' },
    { workflowId: 'nightly', name: 'Nightly checks', trigger: 'manual' },
    { workflowId: 'ticket-review', name: 'Ticket review', trigger: 'ticket' },
  ],
  listRuns: async () => [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(record => runSnapshot(record, Math.max(record.sequence, 0))),
  getRun: async runId => (runs.has(runId) ? runSummary(runs.get(runId)) : undefined),
  listRunChanges: async () => ({}),
  sessionChanges: async sessionId => CHANGES[sessionId] ?? { sessionId, repository: true, branch: 'main', files: [] },
  sessionFileDiff: async (sessionId, file) => fileDiff(sessionId, file),
  findGadget: (sessionId, gadgetId) => findGadgetView(sessionId, gadgetId)?.gadget,
  submitGadget: async (sessionId, payload) => {
    const found = findGadgetView(sessionId, payload.gadgetId);
    if (!found) throw new Error('That question is no longer on the desktop.');
    const action = found.gadget.actions.find(candidate => candidate.actionId === payload.actionId);
    found.state = 'completed';
    found.result = { status: 'completed', message: `Answered on the phone: ${action?.label ?? payload.actionId}.` };
    publishSession(sessions.get(sessionId));
    return { version: 1, gadgetId: payload.gadgetId, actionId: payload.actionId, correlationId: payload.idempotencyKey, idempotencyKey: payload.idempotencyKey, status: 'completed', at: new Date().toISOString() };
  },
  listAttention: async () => attentionItems(),

  createSession: async input => {
    const count = sessions.size + 1;
    const record = session({
      sessionId: `sess-new-${count}`,
      sessionKey: `PRX-${200 + count}`,
      title: input.title,
      lifecycle: 'active',
      mode: input.mode,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      startedAt: new Date().toISOString(),
      messages: [message('user', input.message, new Date().toISOString())],
    });
    publishSession(record);
    setTimeout(() => streamReply(record, cannedReply(input.message)), 600);
    return snapshotOf(record);
  },
  continueSession: async (sessionId, text) => {
    if (failNext) {
      failNext = false;
      throw new Error('The desktop could not start this turn (stage host /fail-next).');
    }
    const record = sessions.get(sessionId);
    record.messages.push(message('user', text, new Date().toISOString()));
    record.lifecycle = 'active';
    record.canCancel = true;
    record.canContinue = false;
    publishSession(record);
    setTimeout(() => streamReply(record, cannedReply(text)), 600);
    return snapshotOf(record);
  },
  configureSession: async (sessionId, change) => {
    const record = sessions.get(sessionId);
    if (change.mode) record.mode = change.mode;
    if (change.model) {
      record.model = change.model;
      record.messages.push(message('system', `Model changed to ${change.model}`, new Date().toISOString()));
    }
    if (change.handover) {
      record.provider = change.handover.provider;
      record.model = change.handover.model ?? modelCatalogs[change.handover.provider]?.defaultModel;
      record.messages.push(message('system', `Handed over to ${labelOf(change.handover.provider)}`, new Date().toISOString()));
      publishSession(record);
      setTimeout(() => streamReply(record, `Picked up the handover brief. I will continue from the last step on ${labelOf(record.provider)}.`), 600);
      return snapshotOf(record);
    }
    publishSession(record);
    return snapshotOf(record);
  },
  cancelSession: async sessionId => {
    const record = sessions.get(sessionId);
    clearInterval(timers.get(sessionId));
    timers.delete(sessionId);
    for (const entry of record.messages) if (entry.status === 'streaming') entry.status = 'stopped';
    record.lifecycle = 'stopped';
    record.canCancel = false;
    record.canContinue = true;
    publishSession(record);
    return snapshotOf(record);
  },
  respondToPermission: async (requestId, decision) => {
    for (const record of sessions.values()) {
      const index = record.pendingPermissions.findIndex(permission => permission.requestId === requestId);
      if (index < 0) continue;
      record.pendingPermissions.splice(index, 1);
      record.messages.push(message('system', decision === 'allow' ? 'Permission allowed from the phone' : 'Permission denied from the phone', new Date().toISOString()));
      publishSession(record);
      return { requestId, decision };
    }
    throw new Error('That permission request is no longer pending.');
  },
  startRun: async ({ workflowId, task }) => {
    const runId = crypto.randomUUID();
    run({
      runId,
      workflowName: `${workflowId === 'nightly' ? 'Nightly checks' : 'Governed delivery'}${task ? ` · ${task.slice(0, 40)}` : ''}`,
      status: 'running',
      explanation: 'Started from the phone.',
      startedAt: new Date().toISOString(),
      currentNodeId: 'plan',
      stages: [
        { nodeId: 'plan', name: 'Plan', type: 'agent-task', lane: 'running', attempts: 1, provider: 'anthropic' },
        { nodeId: 'tests', name: 'Unit tests', type: 'check', lane: 'idle', attempts: 0 },
      ],
    });
    publishRun(runs.get(runId));
    return { runId };
  },
  cancelRun: async runId => {
    const record = runs.get(runId);
    record.status = 'cancelled';
    record.canApprove = false;
    publishRun(record);
    return {};
  },
  retryStage: async (runId, nodeId) => {
    const record = runs.get(runId);
    const stage = record.stages.find(candidate => candidate.nodeId === nodeId);
    stage.lane = 'running';
    stage.attempts += 1;
    delete stage.lastError;
    record.status = 'running';
    record.explanation = `Retrying ${stage.name} from the phone.`;
    publishRun(record);
    setTimeout(() => {
      stage.lane = 'done';
      stage.exitCode = 0;
      for (const later of record.stages) if (later.lane === 'skipped') later.lane = 'done';
      record.status = 'succeeded';
      record.explanation = `${stage.name} passed on retry.`;
      record.endedAt = new Date().toISOString();
      publishRun(record);
    }, 2500);
    return {};
  },
  approveRun: async runId => {
    const record = runs.get(runId);
    const gate = record.stages.find(stage => stage.lane === 'awaiting');
    if (gate) gate.lane = 'done';
    const next = record.stages.find(stage => stage.lane === 'idle');
    record.canApprove = false;
    record.status = 'running';
    record.explanation = 'Approved from the phone; deploying.';
    if (next) {
      next.lane = 'running';
      next.attempts = 1;
      record.currentNodeId = next.nodeId;
    }
    publishRun(record);
    setTimeout(() => {
      if (next) next.lane = 'done';
      record.status = 'succeeded';
      record.explanation = 'Approved from the phone and deployed.';
      record.endedAt = new Date().toISOString();
      publishRun(record);
    }, 2500);
    return {};
  },
  rejectRun: async (runId, _actor, reason) => {
    const record = runs.get(runId);
    const gate = record.stages.find(stage => stage.lane === 'awaiting');
    if (gate) {
      gate.lane = 'failed';
      gate.lastError = `Rejected: ${reason}`;
    }
    record.canApprove = false;
    record.status = 'failed';
    record.explanation = `Rejected from the phone: ${reason}`;
    record.endedAt = new Date().toISOString();
    publishRun(record);
    return {};
  },
};

const commands = Object.fromEntries(Object.entries(createMobileHostExecutionHandlers(deps)).map(([operation, handler]) => [operation, async command => {
  try {
    const result = await handler(command);
    console.log(`[stage] ${operation} ok`);
    return result;
  } catch (error) {
    console.log(`[stage] ${operation} refused: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}]));
const app = {
  reads: createMobileHostReads(deps, Object.keys(commands)),
  commands,
  ledger,
  payloadDigest: command => JSON.stringify(command.payload ?? null),
};

// ---------------------------------------------------------------- listener + pairing

const deviceIdFor = publicKeyHex => `device:${crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 24)}`;
const peerFor = entry => ({ deviceId: entry.deviceId, capabilities: ['view', 'execute', 'approve'], projectIds: [PROJECT_ID] });

const server = new MobileLanServer({
  app,
  hostStaticKey: hostKey,
  authorizePeer: publicKeyHex => {
    const entry = paired.get(publicKeyHex.toLowerCase());
    return entry ? peerFor(entry) : undefined;
  },
  onUnpairedPeer: (publicKeyHex, tokenId) => {
    if (!tokenId) return protocol.mobileConnectionStatus('pairing-required');
    if (tokenId !== INVITATION_TOKEN) return protocol.mobileConnectionStatus('invitation-invalid');
    const key = publicKeyHex.toLowerCase();
    const label = `Phone ${key.slice(0, 6)}`;
    console.log(`[stage] ${label} presented the invitation; confirming in 2s.`);
    setTimeout(() => {
      const entry = { deviceId: deviceIdFor(key), label, pairedAt: new Date().toISOString() };
      paired.set(key, entry);
      savePaired();
      server.promotePending(key, peerFor(entry));
      console.log(`[stage] ${label} confirmed.`);
    }, 2000);
    return protocol.mobileConnectionStatus('pairing-pending', `Confirm ${label} in Settings → Mobile access on ${HOST_NAME}.`);
  },
  onLog: line => console.log(line),
});

function invitation() {
  const expires = new Date(Date.now() + 24 * HOUR).toISOString();
  return `P1|${HOST_ID}|${toHex(hostKey.publicKey)}|127.0.0.1:${PORT}|${INVITATION_TOKEN}|${expires}`;
}

// Live motion so streaming and run updates can be watched without a phone action.
setInterval(() => {
  const record = sessions.get('sess-live-impl');
  if (!record || record.lifecycle !== 'active') return;
  const last = record.messages[record.messages.length - 1];
  if (last.status !== 'streaming') return;
  last.text = last.text.length > 420 ? 'Adding the banner to `ui.tsx` and wiring it to the sync state' : `${last.text}, then checking it against the reconnect path`;
  publishSession(record);
}, 4000);

http.createServer((request, response) => {
  const url = request.url ?? '/';
  let body = 'ok';
  if (url.startsWith('/theme/')) {
    const name = url.slice('/theme/'.length);
    appearance = name === 'none' ? undefined : THEMES[name] ?? appearance;
    if (appearance) emit({ type: 'host.appearance', appearance });
    body = `theme ${name}`;
  } else if (url === '/reply') {
    streamReply(sessions.get('sess-pairing'), cannedReply('a follow-up from the stage control port'));
  } else if (url === '/permission') {
    const record = sessions.get('sess-ci');
    record.pendingPermissions.push({ requestId: `perm-${Date.now().toString(36)}`, summary: 'Write to .github/workflows/ci.yml', detail: 'The agent wants to change the cache key.', createdAt: new Date().toISOString() });
    publishSession(record);
  } else if (url === '/fail-next') {
    failNext = true;
  } else if (url === '/invitation') {
    body = invitation();
  } else {
    response.writeHead(404);
    body = 'unknown';
  }
  response.end(`${body}\n`);
}).listen(CONTROL_PORT, '127.0.0.1');

server.start(PORT, { mode: 'local-only', allowedInterfaces: [], allowedSubnets: [] }).then(() => {
  const lan = Object.values(os.networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal)?.address;
  console.log(`[stage] ${HOST_NAME} listening on ${PORT}${lan ? ` (LAN ${lan})` : ''}; control on http://127.0.0.1:${CONTROL_PORT}`);
  console.log(`[stage] paired phones: ${paired.size}`);
  console.log(`[stage] invitation: ${invitation()}`);
  fs.writeFileSync(path.join(STATE_DIR, 'invitation.txt'), invitation());
});
