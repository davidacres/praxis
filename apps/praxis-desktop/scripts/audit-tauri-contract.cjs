#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '../..');
const binary = process.env.PRAXIS_TAURI_BIN || path.join(root, 'target/debug', process.platform === 'win32' ? 'praxis-desktop.exe' : 'praxis-desktop');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-tauri-audit-'));
try {
  const result = spawnSync(binary, ['--audit-contract', '--user-data-dir', profile, '--settings-path', path.join(profile, 'settings.json')], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PRAXIS_E2E: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  const report = JSON.parse(result.stdout);
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(desktop, 'docs/tauri-contract-audit.json'), JSON.stringify(report, null, 2) + '\n');
  const parityText = report.parityVerified
    ? 'Behavioral parity verified across all channels.'
    : `Behavioral parity verified for ${report.verifiedCount || 0}/${report.methodCount} channels.`;
  console.log(`Desktop contract: ${report.registeredCount}/${report.methodCount} channels registered; ${report.missingCount} missing. ${parityText}`);
  if (process.argv.includes('--require-complete') && report.missingCount !== 0) process.exitCode = 1;
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
