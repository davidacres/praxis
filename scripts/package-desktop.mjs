#!/usr/bin/env node
// Package the Praxis desktop app (Tauri) into a release installer for the host platform.
//
//   node scripts/package-desktop.mjs [--target mac|win|linux] [--skip-build] [--help]
//
// Stages the code-intelligence service, runs `tauri build` with tauri.release.conf.json
// (bundling is off in tauri.conf.json so day-to-day builds stay fast), then copies the
// installers to dist/release/ under stable names for publish-desktop-release.mjs and CI.
//
// Signing is opt-in through Tauri's standard environment variables; nothing is written to
// disk. macOS: APPLE_SIGNING_IDENTITY (cert already in the keychain) or APPLE_CERTIFICATE +
// APPLE_CERTIFICATE_PASSWORD (base64 .p12), plus APPLE_ID, APPLE_PASSWORD (app-specific) and
// APPLE_TEAM_ID to notarize. Without them the installer is unsigned.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'apps', 'praxis-desktop', 'src-tauri');
const outDir = path.join(root, 'dist', 'release');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`Usage: node scripts/package-desktop.mjs [--target mac|win|linux] [--skip-build]

  --target       platform to package; must be the host platform (default: host)
  --skip-build   reuse an existing target/release build
`);
  process.exit(0);
}

const hostTarget = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const flag = args.indexOf('--target');
const target = flag >= 0 ? args[flag + 1] : hostTarget;
const platforms = {
  mac: { bundles: 'dmg', dirs: ['dmg'], match: /\.dmg$/ },
  win: { bundles: 'nsis', dirs: ['nsis'], match: /-setup\.exe$/ },
  linux: { bundles: 'appimage,deb', dirs: ['appimage', 'deb'], match: /\.(AppImage|deb)$/ },
};
if (!platforms[target]) fail(`Unsupported target "${target}" (use mac, win or linux).`);
if (target !== hostTarget) fail(`Tauri cannot cross-package: target ${target} on a ${hostTarget} host.`);

const version = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8')).version;
const { bundles, dirs, match } = platforms[target];

if (target === 'mac') {
  const signed = process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_CERTIFICATE;
  const notarize = process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID;
  log(signed ? (notarize ? 'Signing and notarizing' : 'Signing (no notarization)') : 'UNSIGNED build (no APPLE_SIGNING_IDENTITY / APPLE_CERTIFICATE)');
}

if (!args.includes('--skip-build')) {
  run('node', [path.join(root, 'scripts', 'bundle-code-intelligence.mjs')], root);
  const renderer = path.join(root, 'apps', 'praxis-desktop', 'renderer');
  run(
    'node',
    ['../scripts/run-tauri.cjs', 'build', '--bundles', bundles,
      '--config', path.join(tauriDir, 'tauri.conf.json'),
      '--config', path.join(tauriDir, 'tauri.release.conf.json')],
    renderer,
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const bundleRoot = path.join(root, 'target', 'release', 'bundle');
const produced = [];
for (const dir of dirs) {
  const full = path.join(bundleRoot, dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full)) {
    if (match.test(name) && name.includes(version)) {
      copyFileSync(path.join(full, name), path.join(outDir, name));
      produced.push(name);
    }
  }
}
if (!produced.length) fail(`No ${version} installer found under ${bundleRoot}.`);
log(`Ready in dist/release: ${produced.join(', ')}`);

function run(cmd, cmdArgs, cwd) {
  log(`${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} exited with ${r.status ?? r.signal}.`);
}
function log(m) { process.stdout.write(`==> ${m}\n`); }
function fail(m) { process.stderr.write(`package-desktop: ${m}\n`); process.exit(1); }
