#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Publishes a Praxis marketplace add-on to GitHub Packages (or npm registry).
 *
 * Usage:
 *   node scripts/publish-addon.mjs addons/workflows/full-sdlc-node
 *   node scripts/publish-addon.mjs --all
 *   node scripts/publish-addon.mjs --dry-run addons/workflows/full-sdlc
 *
 * Requirements:
 *   - PRAXIS_MARKETPLACE_TOKEN or GITHUB_TOKEN environment variable with `write:packages` scope.
 *   - Valid `praxis` manifest block in package.json.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const { validateAddonManifest } = await import('../packages/core/out/marketplace/addonManifest.js');

async function execCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...options });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export async function publishAddon(addonDir, options = {}) {
  const absDir = path.resolve(addonDir);
  const pkgJsonPath = path.join(absDir, 'package.json');

  let rawPkg;
  try {
    rawPkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read package.json at ${pkgJsonPath}: ${err.message}`);
  }

  // 1. Validate manifest
  const validation = validateAddonManifest(rawPkg.praxis);
  if (validation.errors.length > 0) {
    throw new Error(`Invalid add-on manifest in ${pkgJsonPath}:\n - ${validation.errors.join('\n - ')}`);
  }

  console.log(`\n📦 Add-on: ${rawPkg.name}@${rawPkg.version}`);
  console.log(`   Kind: ${validation.manifest.kind}`);
  console.log(`   Id: ${validation.manifest.id}`);
  console.log(`   Name: ${validation.manifest.name}`);
  console.log(`   Summary: ${validation.manifest.summary || '(none)'}`);

  if (validation.warnings.length > 0) {
    console.warn(`⚠️ Warnings:`);
    validation.warnings.forEach(w => console.warn(`   - ${w}`));
  }

  if (options.dryRun) {
    console.log(`🔍 [DRY RUN] Add-on is valid and ready to publish.`);
    return { ok: true, dryRun: true, name: rawPkg.name, version: rawPkg.version };
  }

  const token = options.token || process.env.PRAXIS_MARKETPLACE_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing token. Set GITHUB_TOKEN or PRAXIS_MARKETPLACE_TOKEN with write:packages permission.');
  }

  const registry = options.registry || 'https://npm.pkg.github.com';
  console.log(`🚀 Publishing to registry ${registry}...`);

  // Create temporary .npmrc in addon dir with auth
  const npmrcPath = path.join(absDir, '.npmrc');
  const host = registry.replace(/^https?:/, '');
  const npmrcContent = `${host}/:_authToken=${token}\n@davidacres:registry=${registry}\n`;

  await fs.writeFile(npmrcPath, npmrcContent, 'utf8');

  try {
    await execCommand('npm', ['publish', '--registry', registry, '--access', 'public'], {
      cwd: absDir
    });
    console.log(`✅ Successfully published ${rawPkg.name}@${rawPkg.version}!`);
    return { ok: true, name: rawPkg.name, version: rawPkg.version };
  } finally {
    await fs.rm(npmrcPath, { force: true }).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const publishAll = args.includes('--all');
  const targetDirs = args.filter(a => !a.startsWith('--'));

  if (publishAll) {
    for (const group of ['workflows', 'skills']) {
      const groupDir = path.join(ROOT_DIR, 'addons', group);
      const entries = await fs.readdir(groupDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await publishAddon(path.join(groupDir, entry.name), { dryRun });
        }
      }
    }
  } else if (targetDirs.length > 0) {
    for (const dir of targetDirs) {
      await publishAddon(dir, { dryRun });
    }
  } else {
    console.log('Usage: node scripts/publish-addon.mjs [--dry-run] [--all | <path-to-addon-dir>]');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Publish error:', err.message);
    process.exit(1);
  });
}
