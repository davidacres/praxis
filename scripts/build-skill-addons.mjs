#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Prepares the skill add-ons under addons/skills/ for publishing:
 *   - copies bundled tool sources into each skill's payload (one source of truth
 *     in the repo — e.g. the mobile device driver lives in
 *     apps/praxis-mobile/tools/device-driver and ships inside the
 *     mobile-device-testing skill as scripts/device-driver),
 *   - validates the package's `praxis` manifest,
 *   - checks Praxis's own skill discovery accepts the payload's SKILL.md.
 *
 * Usage:
 *   node scripts/build-skill-addons.mjs          # sync + validate
 *   node scripts/build-skill-addons.mjs --check  # fail if a bundled copy is out of date
 *
 * Then publish with: node scripts/publish-addon.mjs addons/skills/<id>
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const { validateAddonManifest } = await import('../packages/core/out/marketplace/addonManifest.js');
const { discoverSkills } = await import('../packages/core/out/ai/agentRuntime/skillRegistry.js');

/** Tool folders copied into skill payloads: source (repo) → target (inside addon/). */
const BUNDLES = {
  'mobile-device-testing': [
    {
      source: 'apps/praxis-mobile/tools/device-driver',
      target: 'scripts/device-driver',
      // Generated or machine-local; never shipped.
      exclude: ['.run', 'PraxisDriver.xcodeproj', '.gitignore']
    }
  ]
};

async function listFiles(dir, exclude, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, exclude, base)));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

async function syncBundle(skillDir, bundle, check) {
  const source = path.join(ROOT_DIR, bundle.source);
  const target = path.join(skillDir, 'addon', bundle.target);
  const sourceFiles = await listFiles(source, bundle.exclude);
  const drift = [];
  const targetFiles = await listFiles(target, []).catch(() => []);
  for (const stale of targetFiles.filter(file => !sourceFiles.includes(file))) drift.push(`extra ${stale}`);
  for (const file of sourceFiles) {
    const wanted = await fs.readFile(path.join(source, file));
    const current = await fs.readFile(path.join(target, file)).catch(() => undefined);
    if (!current || !current.equals(wanted)) drift.push(`${current ? 'changed' : 'missing'} ${file}`);
  }
  if (check) return drift;
  await fs.rm(target, { recursive: true, force: true });
  for (const file of sourceFiles) {
    await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(target, file));
  }
  return drift;
}

async function main() {
  const check = process.argv.includes('--check');
  const skillsRoot = path.join(ROOT_DIR, 'addons', 'skills');
  const entries = (await fs.readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
  let failed = false;

  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry.name);
    const pkg = JSON.parse(await fs.readFile(path.join(skillDir, 'package.json'), 'utf8'));
    const validation = validateAddonManifest(pkg.praxis);
    if (validation.errors.length) {
      console.error(`✗ ${pkg.name}: ${validation.errors.join('; ')}`);
      failed = true;
      continue;
    }
    if (validation.manifest.kind !== 'skill') {
      console.error(`✗ ${pkg.name}: kind is ${validation.manifest.kind}, expected skill`);
      failed = true;
      continue;
    }

    for (const bundle of BUNDLES[validation.manifest.id] ?? []) {
      const drift = await syncBundle(skillDir, bundle, check);
      if (check && drift.length) {
        console.error(`✗ ${pkg.name}: ${bundle.target} is out of date (${drift.join(', ')}). Run node scripts/build-skill-addons.mjs`);
        failed = true;
      } else if (!check && drift.length) {
        console.log(`  synced ${bundle.target} from ${bundle.source} (${drift.length} change${drift.length === 1 ? '' : 's'})`);
      }
    }

    // The payload directory is what Praxis mirrors into <userData>/skills/<id>/.
    const staging = await fs.mkdtemp(path.join(ROOT_DIR, 'dist', '.skill-check-'));
    try {
      await fs.cp(path.join(skillDir, 'addon'), path.join(staging, validation.manifest.id), { recursive: true });
      const [discovered] = await discoverSkills([staging]);
      if (!discovered || discovered.error) {
        console.error(`✗ ${pkg.name}: SKILL.md rejected by skill discovery${discovered?.error ? ` (${discovered.error})` : ''}`);
        failed = true;
        continue;
      }
      if (discovered.metadata.name !== validation.manifest.id) {
        console.warn(`⚠ ${pkg.name}: SKILL.md name "${discovered.metadata.name}" differs from manifest id "${validation.manifest.id}"`);
      }
      console.log(`✓ ${pkg.name}@${pkg.version} — skill "${discovered.metadata.name}", ${discovered.metadata.triggers.length} triggers`);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  if (failed) process.exit(1);
}

await fs.mkdir(path.join(ROOT_DIR, 'dist'), { recursive: true });
await main();
