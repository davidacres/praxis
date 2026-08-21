#!/usr/bin/env node
/*
 * Copy packages/frontend/dist into packages/electron-app/renderer so the
 * packaged app can load the built frontend via a relative `renderer/index.html`
 * path. electron-builder packs everything inside an asar, and `..` traversal
 * above the asar root is not supported, so we materialise the renderer next
 * to the main process output before packaging.
 *
 * Usage: invoked automatically as `npm run copy-renderer`, and is also called
 * from scripts/build-app.ps1 when building from PowerShell.
 */
const { cpSync, rmSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist');
const rendererDir = join(__dirname, '..', 'renderer');

if (!existsSync(frontendDist)) {
  throw new Error(
    `Frontend dist not found at ${frontendDist}. ` +
      "Run 'npm run build' in packages/frontend first."
  );
}

if (existsSync(rendererDir)) {
  rmSync(rendererDir, { recursive: true, force: true });
}
mkdirSync(rendererDir, { recursive: true });
cpSync(frontendDist, rendererDir, { recursive: true });

console.log(`copied ${frontendDist} -> ${rendererDir}`);
