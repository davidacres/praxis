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

function cliExists(name) {
  try {
    execFileSync(commandFor(name), ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const projectRoot = join(__dirname, '..');
  const vsixName = `${pkg.name}-${pkg.version}.vsix`;
  const vsixPath = join(projectRoot, vsixName);
  const extensionId = `${pkg.publisher}.${pkg.name}`;

  // Accept target from CLI arg: --target code|insiders|both (default: both)
  const targetArg = process.argv.find(a => a.startsWith('--target='));
  const target = targetArg ? targetArg.split('=')[1] : 'both';

  run(commandFor('npx'), ['@vscode/vsce', 'package', '--allow-missing-repository']);

  if (!existsSync(vsixPath)) {
    throw new Error(`Expected VSIX was not created: ${vsixPath}`);
  }

  const targets = [];
  if (target === 'code' || target === 'both') {
    targets.push({ name: 'VS Code', cli: 'code' });
  }
  if (target === 'insiders' || target === 'both') {
    targets.push({ name: 'VS Code Insiders', cli: 'code-insiders' });
  }

  let installed = 0;
  for (const { name, cli } of targets) {
    if (!cliExists(cli)) {
      console.log(`⏭  ${name} CLI (${cli}) not found on PATH — skipping.`);
      continue;
    }
    console.log(`📦 Installing ${vsixName} into ${name}…`);
    try {
      try {
        run(commandFor(cli), ['--uninstall-extension', extensionId]);
      } catch {
        // Ignore uninstall failures when the extension is not currently installed.
      }
      run(commandFor(cli), ['--install-extension', vsixPath, '--force']);
      installed++;
    } catch (error) {
      console.error(`❌ Failed to install into ${name}: ${error.message}`);
    }
  }

  if (installed === 0) {
    throw new Error(
      'No VS Code installation found. Ensure "code" and/or "code-insiders" is on PATH.'
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
