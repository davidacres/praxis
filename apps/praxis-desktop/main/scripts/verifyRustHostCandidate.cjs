#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

(async () => {
  if (process.platform !== 'darwin') throw new Error('This candidate verification currently covers native macOS only.');
  const root = path.resolve(__dirname, '..');
  const appPath = path.join(root, 'dist', `mac-${process.arch}`, 'Praxis.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  const binary = path.join(resources, 'rust-host', 'praxis-host');
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'rust-host', 'host.praxis.json'), 'utf8'));
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'pipe' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-packaged-proof-'));
  let electron;
  try {
    const response = JSON.parse(execFileSync(binary, ['--rpc', JSON.stringify({ id: 'packaged-proof', channel: 'host:status', args: [] }),
      `--user-data-dir=${dir}`, `--settings-path=${path.join(dir, 'host-settings.json')}`], { encoding: 'utf8' }));
    if (!response.ok || response.result.crateVersion !== manifest.crateVersion || response.result.protocolVersion !== 1) throw new Error('Bundled host status does not match its manifest.');
    electron = await _electron.launch({
      executablePath: path.join(appPath, 'Contents', 'MacOS', 'Praxis'),
      // Playwright adds its ready-handshake loader only when it chooses the
      // executable. A packaged executable needs the same test instrumentation.
      args: ['-r', path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js'),
        `--user-data-dir=${dir}`],
      timeout: 60_000,
      env: { ...process.env, PRAXIS_E2E: '1', PRAXIS_SETTINGS_PATH: path.join(dir, 'settings.json'),
        PRAXIS_AI_WORKING_DIR: dir, PRAXIS_NATIVE_SOURCES_HOME: dir, PRAXIS_COORDINATION_ROOT: path.join(dir, 'coordination'),
        PRAXIS_RUST_CHANNELS: 'all', PRAXIS_MOBILE_TRANSPORT: 'rust', PRAXIS_RUST_HOST_BIN: path.join(dir, 'invalid-override') },
    });
    const window = await electron.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof globalThis.praxis?.settings?.get === 'function');
    const proof = await electron.evaluate(async ({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/out/main/index.js');
      const bridge = require('./rustHostInstance.js').getRustHostBridge();
      return { packaged: app.isPackaged, status: await bridge.invoke('host:status'), channels: bridge.migratedChannels() };
    });
    if (!proof.packaged || proof.status.delegation?.mode !== 'typescript' || proof.channels.length !== 0) throw new Error('Packaged policy did not remain on TypeScript.');
    const evidence = { ...proof, bundledHost: response.result, platform: process.platform, arch: process.arch,
      appSignatureVerified: true, hostSignatureVerified: true, signing: 'ad-hoc candidate, not Developer ID/notarized',
      sourceCommit: manifest.sourceCommit, sourceDirty: manifest.sourceDirty };
    const output = path.resolve(root, '../.praxis/session-artifacts/rust-packaging-proof.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log('Packaged candidate loaded its renderer; bundled Rust host runs; both local signatures verify; packaged delegation remains TypeScript.');
  } finally {
    await electron?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
