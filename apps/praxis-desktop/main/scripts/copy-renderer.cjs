#!/usr/bin/env node
/*
 * Copy apps/praxis-desktop/renderer/dist into apps/praxis-desktop/main/renderer so the
 * packaged app can load the built frontend via a relative `renderer/index.html`
 * path. electron-builder packs everything inside an asar, and `..` traversal
 * above the asar root is not supported, so we materialise the renderer next
 * to the main process output before packaging.
 *
 * Usage: invoked automatically as `npm run copy-renderer`, and is also called
 * from scripts/build-app.ps1 when building from PowerShell.
 */
const { execSync } = require('node:child_process');
const { cpSync, rmSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// Source: the renderer workspace's Vite build. Destination: a staging directory
// inside the main-process package. Both are called "renderer" but only the
// second is the one electron-builder packs, so they are named apart here.
const rendererDir = join(__dirname, '..', '..', 'renderer');
const rendererBuild = join(rendererDir, 'dist');
const stagingDir = join(__dirname, '..', 'renderer');

if (!existsSync(rendererBuild)) {
  console.log(`Renderer build not found at ${rendererBuild}, building renderer...`);
  try {
    execSync('npm run build', { cwd: rendererDir, stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `Failed to build renderer at ${rendererDir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });
cpSync(rendererBuild, stagingDir, { recursive: true });

console.log(`copied ${rendererBuild} -> ${stagingDir}`);
