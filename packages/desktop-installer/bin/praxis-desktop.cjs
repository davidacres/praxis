#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { mkdir, rename, stat, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE = 'v0.3.3-selfsigned.1';
const WINDOWS_ASSET = 'Praxis-0.3.3-setup.exe';
const WINDOWS_SHA256 = '71723ea173baa70cf250aa5aded5311e70b61222cc226ce4db596426421e8442';
const WINDOWS_CERTIFICATE = 'praxis-windows-test.cer';
const WINDOWS_CERTIFICATE_SHA256 = '478cedc3c1e6e89fc6ed9ef47f683549ebf3c9be218a25a38d4ae6ca20b39090';
const RELEASE_API = `https://api.github.com/repos/davidacres/praxis/releases/tags/${RELEASE}`;

function usage() {
  console.log(`Praxis Desktop installer launcher

Usage:
  praxis-desktop install [--silent]
  praxis-desktop download [--output <directory>]
  praxis-desktop certificate [--output <directory>]

This test release is self-signed. Windows may display an unknown-publisher
warning unless the separately downloaded test certificate is explicitly
trusted by an administrator.

The private GitHub release requires GH_TOKEN, GITHUB_TOKEN, or an authenticated
GitHub CLI session.`);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

async function download(url, destination, expectedSha256, token) {
  await mkdir(resolve(destination, '..'), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': '@davidacres/praxis-desktop',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body);
  source.on('data', chunk => hash.update(chunk));
  try {
    await pipeline(source, createWriteStream(temporary, { mode: 0o700 }));
    const digest = hash.digest('hex');
    if (expectedSha256 && digest !== expectedSha256) {
      throw new Error(`Checksum mismatch: expected ${expectedSha256}, received ${digest}.`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const result = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function releaseAssetUrl(asset, token) {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': '@davidacres/praxis-desktop',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const authenticationHint = token ? '' : ' Set GH_TOKEN/GITHUB_TOKEN or run gh auth login.';
    throw new Error(`Cannot read GitHub release: HTTP ${response.status}.${authenticationHint}`);
  }
  const release = await response.json();
  const match = release.assets?.find(candidate => candidate.name === asset);
  if (!match?.url) throw new Error(`Release asset is missing: ${asset}`);
  return match.url;
}

async function downloadAsset(asset, expectedSha256, args) {
  const requestedOutput = optionValue(args, '--output');
  const outputDirectory = requestedOutput
    ? resolve(requestedOutput)
    : join(tmpdir(), 'praxis-desktop', RELEASE);
  const destination = join(outputDirectory, basename(asset));
  try {
    const existing = await stat(destination);
    if (existing.isFile() && expectedSha256) {
      const { readFile } = require('node:fs/promises');
      const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
      if (digest === expectedSha256) return destination;
    }
  } catch {
    // Download missing or stale artifacts below.
  }
  console.log(`Downloading ${asset}...`);
  const token = githubToken();
  return download(await releaseAssetUrl(asset, token), destination, expectedSha256, token);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }

  if (command === 'certificate') {
    const certificate = await downloadAsset(WINDOWS_CERTIFICATE, WINDOWS_CERTIFICATE_SHA256, args);
    console.log(`Test certificate downloaded to ${certificate}`);
    console.log('Only install it into Windows trust stores on a controlled test machine.');
    return;
  }

  if (command !== 'install' && command !== 'download') {
    throw new Error(`Unknown command: ${command}`);
  }

  const installer = await downloadAsset(WINDOWS_ASSET, WINDOWS_SHA256, args);
  console.log(`Verified SHA-256 ${WINDOWS_SHA256}`);
  if (command === 'download') {
    console.log(`Installer downloaded to ${installer}`);
    return;
  }

  if (process.platform !== 'win32') {
    throw new Error(`Installation requires Windows. The verified installer is at ${installer}`);
  }
  const installerArgs = args.includes('--silent') ? ['/S'] : [];
  const result = spawnSync(installer, installerArgs, { stdio: 'inherit', windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Praxis installer exited with code ${result.status}.`);
}

main().catch(error => {
  console.error(`praxis-desktop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
