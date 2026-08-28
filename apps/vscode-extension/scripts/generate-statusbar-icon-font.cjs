'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'media', 'ticket.svg');
const outDir = path.join(root, 'media');

if (!fs.existsSync(svg)) {
  console.error(`Missing source SVG: ${svg}`);
  process.exit(1);
}

execFileSync(
  'npx',
  [
    '--yes',
    '--registry',
    'https://registry.npmjs.org',
    'webfont',
    svg,
    '-d',
    outDir,
    '-f',
    'woff',
    '--font-name',
    'praxis-icons'
  ],
  { cwd: root, stdio: 'inherit', shell: true }
);

console.log(`Wrote ${path.join(outDir, 'praxis-icons.woff')}`);
