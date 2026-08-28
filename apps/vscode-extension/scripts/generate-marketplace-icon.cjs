'use strict';

/*
 * Regenerate media/marketplace-icon.png (128x128) — the VS Code marketplace
 * icon — by downscaling the canonical Praxis brand mark that the desktop app
 * ships. Keeping one source of truth means the extension and the app never
 * drift apart visually.
 *
 * Source:  apps/praxis-desktop/renderer/src/assets/praxis-icon-v3.png (1024x1024)
 * Needs:   `sips` (bundled on macOS) or ImageMagick (`magick` / `convert`).
 *          On a box with neither, resize praxis-icon-v3.png to 128x128 by hand.
 *
 * The scalable companion, media/icon.svg, is edited directly — the store
 * sidecar in scripts/build.ps1 prefers it and embeds it as a data URL.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZE = 128;
const mediaDir = path.join(__dirname, '..', 'media');
const OUT = path.join(mediaDir, 'marketplace-icon.png');
const SRC = path.join(
  __dirname,
  '..',
  '..',
  'praxis-desktop',
  'renderer',
  'src',
  'assets',
  'praxis-icon-v3.png'
);

if (!fs.existsSync(SRC)) {
  console.error(`Brand source not found: ${SRC}`);
  process.exit(1);
}

function have(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some(dir => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

if (have('sips')) {
  execFileSync('sips', ['-z', String(SIZE), String(SIZE), '--setProperty', 'format', 'png', SRC, '--out', OUT], {
    stdio: 'ignore'
  });
} else if (have('magick')) {
  execFileSync('magick', [SRC, '-resize', `${SIZE}x${SIZE}`, OUT], { stdio: 'ignore' });
} else if (have('convert')) {
  execFileSync('convert', [SRC, '-resize', `${SIZE}x${SIZE}`, OUT], { stdio: 'ignore' });
} else {
  console.error('Need `sips` (macOS) or ImageMagick. Resize praxis-icon-v3.png to 128x128 manually.');
  process.exit(1);
}

console.log(`Wrote ${OUT} (${SIZE}x${SIZE}, from ${path.relative(process.cwd(), SRC)})`);
