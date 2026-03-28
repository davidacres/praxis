const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const pkg = require('../package.json');

function commandFor(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(command, args) {
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: join(__dirname, '..')
  });
}

function main() {
  const projectRoot = join(__dirname, '..');
  const vsixName = `${pkg.name}-${pkg.version}.vsix`;
  const vsixPath = join(projectRoot, vsixName);

  run(commandFor('npx'), ['@vscode/vsce', 'package']);

  if (!existsSync(vsixPath)) {
    throw new Error(`Expected VSIX was not created: ${vsixPath}`);
  }

  try {
    run(commandFor('code'), ['--install-extension', vsixPath]);
  } catch (error) {
    throw new Error(
      `Failed to install ${vsixName}. Ensure the VS Code CLI is on PATH and try again.\n${error.message}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
