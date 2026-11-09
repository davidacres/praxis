#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const mainRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mainRoot, '../../..');

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout ?? '';
}

/** Stages a native candidate only; does not enable packaged delegation or publish anything. */
function stageRustHost(profile = 'release') {
  if (!['release', 'debug'].includes(profile)) throw new Error('Profile must be release or debug.');
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['arm64', 'x64', 'ia32'].includes(process.arch)) {
    throw new Error(`Unsupported native Rust host target: ${process.platform}/${process.arch}`);
  }
  run(process.env.PRAXIS_CARGO || 'cargo', ['build', '-p', 'praxis-host', '--bin', 'praxis-host', '--locked',
    ...(profile === 'release' ? ['--release'] : []), '--jobs', '2'], repoRoot, { stdio: 'inherit' });
  const name = process.platform === 'win32' ? 'praxis-host.exe' : 'praxis-host';
  const source = path.join(repoRoot, 'target', profile, name);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-host-package-proof-'));
  let status;
  try {
    const response = JSON.parse(run(source, ['--rpc', JSON.stringify({ id: 'package-proof', channel: 'host:status', args: [] }),
      `--user-data-dir=${state}`, `--settings-path=${path.join(state, 'settings.json')}`], repoRoot));
    if (!response.ok || response.result?.protocolVersion !== 1 || !response.result?.crateVersion) {
      throw new Error('Built Rust host did not return a compatible status.');
    }
    status = response.result;
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
  const folder = path.join(mainRoot, 'dist', 'rust-host-staging');
  fs.mkdirSync(folder, { recursive: true });
  const destination = path.join(folder, name);
  fs.copyFileSync(source, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  const manifest = {
    schemaVersion: 1, platform: process.platform, arch: process.arch, profile, binary: name,
    ...status,
    sourceCommit: run('git', ['rev-parse', 'HEAD'], repoRoot).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], repoRoot).trim().length > 0,
    unsignedSha256: crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'),
    delegationEnabled: false,
  };
  fs.writeFileSync(path.join(folder, 'host.praxis.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Staged native ${profile} host ${status.crateVersion} for ${process.platform}/${process.arch}; packaged delegation stays disabled.`);
  return manifest;
}

if (require.main === module) {
  try { stageRustHost(process.argv.includes('--debug') ? 'debug' : 'release'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { stageRustHost };
