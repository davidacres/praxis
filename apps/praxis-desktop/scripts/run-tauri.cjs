#!/usr/bin/env node
// npm invokes this from the renderer workspace; the Tauri project root is its parent.
const path = require('node:path');
const desktop = path.resolve(__dirname, '..');
process.env.TAURI_APP_PATH = path.join(desktop, 'src-tauri');
process.env.TAURI_FRONTEND_PATH = path.join(desktop, 'renderer');
process.chdir(path.join(desktop, 'renderer'));
require('@tauri-apps/cli').run(process.argv.slice(2)).catch(error => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
