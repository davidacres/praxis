#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const binary = process.env.PRAXIS_TAURI_BIN || path.join(repoRoot, 'target/debug', process.platform === 'win32' ? 'praxis-desktop.exe' : 'praxis-desktop');
const cargoBinDir = path.join(os.homedir(), '.cargo', 'bin');
const childEnv = {
  ...process.env,
  PATH: `${cargoBinDir}${path.delimiter}${process.env.PATH || ''}`,
};

async function runTauriE2e() {
  console.log('Running Tauri headless contract, storage and unit checks (no webview E2E)...\n');
  assert.ok(fs.existsSync(binary), `Binary not found at ${binary}. Build with 'cargo build -p praxis-desktop' first.`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-tauri-e2e-'));
  const settingsPath = path.join(profile, 'settings.json');

  try {
    // 1. Audit Contract Verification Gate
    console.log('[1/4] Auditing contract registration...');
    const auditRes = spawnSync(binary, [
      '--audit-contract',
      `--user-data-dir=${profile}`,
      `--settings-path=${settingsPath}`
    ], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...childEnv, PRAXIS_E2E: '1' }
    });

    assert.equal(auditRes.status, 0, `Audit failed: ${auditRes.stderr}`);
    const report = JSON.parse(auditRes.stdout);
    assert.equal(report.shell, 'tauri');
    assert.equal(report.transport, 'in-process');
    assert.equal(report.methodCount, 407);
    assert.equal(report.registeredCount, 407);
    assert.equal(report.missingCount, 0);
    assert.equal(report.verifiedCount, 0);
    assert.equal(report.parityVerified, false);
    console.log(`      ✓ 407/407 channels registered; behavioral parity remains unverified`);

    // 2. Headless App Lifecycle and File Creation Check
    console.log('[2/4] Verifying profile bootstrapping and persistent file creation...');
    fs.writeFileSync(settingsPath, JSON.stringify({
      appearance: { themeId: 'praxis-dark', themeMode: 'dark' }
    }, null, 2));

    const checkAuditAgain = spawnSync(binary, [
      '--audit-contract',
      `--user-data-dir=${profile}`,
      `--settings-path=${settingsPath}`
    ], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...childEnv, PRAXIS_E2E: '1' }
    });
    assert.equal(checkAuditAgain.status, 0);
    const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(savedSettings.appearance.themeId, 'praxis-dark');
    console.log(`      ✓ Contract audit left the existing settings file unchanged`);

    // 3. Automated Rust Application Suites
    console.log('[3/4] Running native Tauri integration test suite...');
    const testRes = spawnSync('cargo', ['test', '-p', 'praxis-desktop', '--', '--nocapture'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(testRes.status, 0, `Cargo test failed:\n${testRes.stderr}\n${testRes.stdout}`);
    const match = testRes.stdout.match(/(\d+) passed; 0 failed/);
    assert.ok(match, 'Expected cargo test to report 0 failures');
    console.log(`      ✓ ${match[1]}/${match[1]} native application integration tests passed`);

    // 4. Renderer Bridge & Transport Test Suite
    console.log('[4/4] Running frontend Tauri transport and bridge contract suite...');
    const rendererTest = spawnSync('npm', ['test', '--workspace=@praxis/desktop-renderer'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(rendererTest.status, 0, `Renderer tests failed:\n${rendererTest.stderr}\n${rendererTest.stdout}`);
    console.log(`      ✓ Renderer bridge and unit tests passed`);

    console.log('\nHeadless checks passed. Real webview journeys and behavioral parity require separate evidence.');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

runTauriE2e().catch(err => {
  console.error('\nTauri E2E verification failed:', err);
  process.exit(1);
});
