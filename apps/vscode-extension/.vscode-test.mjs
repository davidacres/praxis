import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/**/*.test.js',
    workspaceFolder: '.',
    version: 'stable',
    launchArgs: ['--disable-extensions'],
    mocha: {
      timeout: 30000,
      ui: 'tdd'
    }
  }
]);
