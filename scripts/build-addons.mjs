#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Builds and packages Praxis marketplace add-ons for the 4 Full SDLC workflow templates:
 * - full-sdlc (Generic)
 * - full-sdlc-node (Node.js / TypeScript)
 * - full-sdlc-dotnet (.NET / C#)
 * - full-sdlc-python (Python)
 *
 * Generates:
 *   addons/workflows/<id>/package.json
 *   addons/workflows/<id>/addon/template.json
 *   dist/addons/<packageName>-<version>.tgz (ready for `npm publish` / GitHub Packages)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Dynamic import of compiled core functions
const { fullSdlcTemplate } = await import('../packages/core/out/workflows/workflowTemplates.js');

const WORKFLOW_ADDONS = [
  {
    id: 'full-sdlc',
    variant: 'generic',
    name: 'Full SDLC (Generic / Polyglot)',
    summary: '12-stage governed pipeline: plan, implement, lint, typecheck, test, SAST, secrets, SCA, review, gates, approve, deploy.',
    description: 'Full SDLC quality and security gate pipeline for generic, polyglot, or custom toolchain projects.'
  },
  {
    id: 'full-sdlc-node',
    variant: 'node',
    name: 'Full SDLC (Node.js & TypeScript)',
    summary: '12-stage pipeline with ESLint, tsc, Vitest/Jest, Semgrep SAST, Gitleaks, npm audit, structured review, and gate thresholds.',
    description: 'Production-grade SDLC workflow tailored for Node.js and TypeScript repositories.'
  },
  {
    id: 'full-sdlc-dotnet',
    variant: 'dotnet',
    name: 'Full SDLC (.NET & C#)',
    summary: '12-stage pipeline with dotnet format, dotnet test, Semgrep C# SAST, Gitleaks, osv-scanner, and C# review agent.',
    description: 'Enterprise SDLC workflow tailored for .NET and C# solutions using dotnet CLI and SOLID/DRY review.'
  },
  {
    id: 'full-sdlc-python',
    variant: 'python',
    name: 'Full SDLC (Python)',
    summary: '12-stage pipeline with Ruff linter, Pytest, Bandit SAST, Gitleaks, and pip-audit vulnerability checks.',
    description: 'Comprehensive SDLC workflow tailored for Python applications and services.'
  }
];

async function createTarball(sourceDir, targetTgzPath) {
  const tar = await import('tar');
  await tar.c(
    {
      file: targetTgzPath,
      cwd: sourceDir,
      gzip: true,
      prefix: 'package'
    },
    ['package.json', 'addon']
  );
}

export async function buildWorkflowAddons(options = {}) {
  const owner = options.owner || 'davidacres';
  const version = options.version || '1.0.0';
  const outputTgz = options.outputTgz !== false;

  const results = [];

  const addonsBase = path.join(ROOT_DIR, 'addons', 'workflows');
  const distBase = path.join(ROOT_DIR, 'dist', 'addons');
  await fs.mkdir(addonsBase, { recursive: true });
  if (outputTgz) await fs.mkdir(distBase, { recursive: true });

  for (const item of WORKFLOW_ADDONS) {
    const addonDir = path.join(addonsBase, item.id);
    const innerAddonDir = path.join(addonDir, 'addon');
    await fs.mkdir(innerAddonDir, { recursive: true });

    const packageName = `@${owner}/praxis-addon-${item.id}`;
    const definition = fullSdlcTemplate(item.variant);

    // 1. package.json with `praxis` manifest block
    const packageJson = {
      name: packageName,
      version,
      description: item.description,
      author: owner,
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'https://github.com/davidacres/praxis.git',
        directory: `addons/workflows/${item.id}`
      },
      praxis: {
        schemaVersion: 1,
        kind: 'workflow-template',
        id: item.id,
        name: item.name,
        summary: item.summary,
        author: owner,
        contentVersion: version,
        minAppVersion: '0.3.0'
      }
    };

    await fs.writeFile(
      path.join(addonDir, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf8'
    );

    // 2. addon/template.json with WorkflowDefinition
    await fs.writeFile(
      path.join(innerAddonDir, 'template.json'),
      JSON.stringify(definition, null, 2) + '\n',
      'utf8'
    );

    let tgzPath;
    let sha512;
    if (outputTgz) {
      const sanitizedName = `praxis-addon-${item.id}-${version}.tgz`;
      tgzPath = path.join(distBase, sanitizedName);
      await createTarball(addonDir, tgzPath);
      const bytes = await fs.readFile(tgzPath);
      sha512 = createHash('sha512').update(bytes).digest('base64');
    }

    results.push({
      id: item.id,
      packageName,
      addonDir,
      tgzPath,
      sha512: sha512 ? `sha512-${sha512}` : undefined
    });

    console.log(`✓ Built add-on ${packageName} at ${addonDir}`);
    if (tgzPath) {
      console.log(`  Tarball: ${tgzPath} (${sha512 ? `sha512-${sha512.slice(0, 16)}...` : ''})`);
    }
  }

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWorkflowAddons().catch(err => {
    console.error('Failed to build workflow add-ons:', err);
    process.exit(1);
  });
}
