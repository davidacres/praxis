import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/*
 * VS Code claims its single-instance lock by listening on a Unix domain socket
 * at `<user-data-dir>/<version>-main.sock`. macOS caps a socket path at 104
 * bytes (sun_path), and @vscode/test-electron defaults user-data-dir to
 * `<repo>/apps/vscode-extension/.vscode-test/user-data` — 111 characters for
 * this checkout, so startup dies with `listen EINVAL` before any test runs.
 *
 * Keeping the profile in the home directory keeps the socket path short
 * (~46 chars) and independent of how deeply the repo is cloned. test-electron
 * only injects its own --user-data-dir when one is not already supplied, so
 * this overrides rather than duplicates it.
 */
const userDataDir = path.join(os.homedir(), '.vscode-test-praxis');

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/**/*.test.js',
    workspaceFolder: '.',
    version: 'stable',
    launchArgs: ['--disable-extensions', `--user-data-dir=${userDataDir}`],
    mocha: {
      timeout: 30000,
      ui: 'tdd'
    }
  }
]);
