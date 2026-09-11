#!/usr/bin/env node
/**
 * Create a GitHub Release with the built installer
 * Usage: node scripts/create-release.mjs [--tag v0.3.0] [--draft] [--prerelease]
 *
 * Requires GITHUB_TOKEN environment variable
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const execAsync = promisify(exec);

async function getLatestTag() {
  try {
    const { stdout } = await execAsync('git describe --tags --abbrev=0 2>/dev/null || git rev-parse --short HEAD');
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

async function getCommitMessage() {
  try {
    const { stdout } = await execAsync('git log -1 --pretty=%B');
    return stdout.trim();
  } catch {
    return '';
  }
}

async function createRelease() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ GITHUB_TOKEN environment variable not set');
    console.error('   Run: export GITHUB_TOKEN=your_github_token');
    process.exit(1);
  }

  const tag = process.argv[2] || `v${JSON.parse(readFileSync(resolve('apps/praxis-desktop/main/package.json')).toString()).version}`;
  const isDraft = process.argv.includes('--draft');
  const isPrerelease = process.argv.includes('--prerelease');

  console.log(`📦 Creating release ${tag}...`);
  console.log(`   Draft: ${isDraft}`);
  console.log(`   Prerelease: ${isPrerelease}`);

  const commitMessage = await getCommitMessage();
  const body = `## What's Changed\n\n${commitMessage || 'See commit history for changes.'}`;

  const releaseData = {
    tag_name: tag,
    name: `Release ${tag}`,
    body,
    draft: isDraft,
    prerelease: isPrerelease,
  };

  try {
    const response = await fetch('https://api.github.com/repos/davidacres/praxis/releases', {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify(releaseData),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ GitHub API error:', error.message);
      process.exit(1);
    }

    const release = await response.json();
    console.log(`✅ Release created: ${release.html_url}`);

    // List available installers
    try {
      const { stdout } = await execAsync('ls -lh apps/praxis-desktop/main/dist/*.dmg apps/praxis-desktop/main/dist/*-setup.exe 2>/dev/null || true');
      if (stdout) {
        console.log('\n📁 Available installers to upload:');
        console.log(stdout);
        console.log('\n💡 Upload installers with:');
        console.log(`   gh release upload ${tag} apps/praxis-desktop/main/dist/Praxis-*.dmg`);
        console.log(`   gh release upload ${tag} apps/praxis-desktop/main/dist/*-setup.exe`);
      }
    } catch {
      // Ignore ls errors
    }
  } catch (error) {
    console.error('❌ Failed to create release:', error.message);
    process.exit(1);
  }
}

createRelease();
