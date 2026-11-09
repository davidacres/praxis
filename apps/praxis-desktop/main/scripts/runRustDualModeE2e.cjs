#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mainRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mainRoot, '../../..');
const outputRoot = path.join(mainRoot, 'output', 'rust-dual-mode');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const specs = process.argv.slice(2);
const selected = specs.length ? specs : [
  'gitGraph.spec.ts', 'gitOnboarding.spec.ts', 'settingsReset.spec.ts',
  'folder.spec.ts', 'folderMulti.spec.ts', 'editIssue.spec.ts', 'newIssue.spec.ts',
  'mobileAccess.spec.ts', 'mobileTransport.spec.ts'
];

function run(command, args, cwd, env, logPath) {
  return new Promise((resolve, reject) => {
    const log = logPath ? fs.createWriteStream(logPath) : undefined;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', chunk => { process.stdout.write(chunk); log?.write(chunk); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); log?.write(chunk); });
    child.on('error', error => { log?.end(); reject(error); });
    child.on('close', code => { log?.end(); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
  });
}

(async () => {
  // E2E loads the copied build. Never rely on a stale renderer or host binary.
  await run(npm, ['run', 'build:rust'], repoRoot, process.env);
  for (const script of ['build:core', 'build:mobile-protocol', 'build:mobile-relay']) {
    await run(npm, ['run', script], repoRoot, process.env);
  }
  await run(npm, ['run', 'build:renderer'], repoRoot, process.env);
  await run(npm, ['run', 'desktop:copy-renderer'], repoRoot, process.env);
  await run(npm, ['run', 'compile'], mainRoot, process.env);
  const failures = [];
  for (const [mode, channels] of [['typescript', 'none'], ['rust', 'default']]) {
    const dir = path.join(outputRoot, mode);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, PRAXIS_RUST_CHANNELS: channels,
      PRAXIS_MOBILE_TRANSPORT: mode, PRAXIS_EXPECT_MOBILE_TRANSPORT: mode,
      PRAXIS_EXPECT_RUST_MODE: mode, PRAXIS_E2E_WORKERS: '1',
      PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(dir, 'results.json') };
    // Do not inherit a developer's binary override: this run just built the local host.
    delete env.PRAXIS_RUST_HOST_BIN;
    delete env.PRAXIS_EXPECT_RUST_CHANNELS;
    console.log(`\nRunning ${mode} E2E (${channels})\n`);
    try {
      await run(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...selected,
        '--project=functional', '--workers=1', '--reporter=list,json', `--output=${path.join(dir, 'test-results')}`],
      mainRoot, env, path.join(dir, 'run.log'));
    } catch (error) { failures.push(`${mode}: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join('\n'));
})().catch(error => { console.error(error); process.exitCode = 1; });
