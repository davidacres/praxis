import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoBinDir = path.join(os.homedir(), '.cargo', 'bin');
const cli = process.env.PRAXIS_CARGO || 'cargo';
const mode = process.argv[2] || 'check';

const env = {
  ...process.env,
  PATH: `${cargoBinDir}${path.delimiter}${process.env.PATH || ''}`,
};

function runCargo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: root, stdio: 'inherit', shell: false, env });
    child.on('error', (error) => {
      reject(
        new Error(
          `Cannot run ${cli}: install the Rust toolchain via rustup or set PRAXIS_CARGO. ${error.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cargo ${args[0]} exited with ${code}`));
      }
    });
  });
}

try {
  if (mode === 'check') {
    await runCargo(['check', '--workspace']);
    await runCargo(['clippy', '--workspace', '--all-targets', '--all-features', '--', '-D', 'warnings']);
    await runCargo(['run', '-p', 'praxis-contracts', '--bin', 'export-types', '--', '--check']);
  } else if (mode === 'export-types') {
    await runCargo(['run', '-p', 'praxis-contracts', '--bin', 'export-types']);
  } else if (mode === 'test') {
    await runCargo(['test', '--workspace']);
  } else if (mode === 'build') {
    await runCargo(['build', '--workspace']);
  } else {
    throw new Error(`Unsupported cargo-workspace mode: ${mode}`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
