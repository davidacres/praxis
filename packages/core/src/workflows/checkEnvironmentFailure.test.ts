import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckEnvironmentFailure } from './checkEnvironmentFailure';

/** Verbatim from the failed FX-BF-036 run: npm audit against GitHub Packages. */
const GITHUB_PACKAGES_AUDIT = `npm warn audit 404 Not Found - POST https://npm.pkg.github.com/-/npm/v1/security/advisories/bulk
404 page not found

npm error audit endpoint returned an error
npm error A complete log of this run can be found in: /Users/someone/.npm/_logs/2026-09-20T19_26_56_569Z-debug-0.log`;

test('npm audit against a registry with no audit endpoint is an environment failure, and says which registry', () => {
  const result = classifyCheckEnvironmentFailure({
    command: 'npm', args: ['audit', '--audit-level=high'], exitCode: 1, output: GITHUB_PACKAGES_AUDIT
  });
  assert.equal(result?.kind, 'registry-audit-unsupported');
  assert.match(result?.reason ?? '', /npm\.pkg\.github\.com/);
  assert.match(result?.hint ?? '', /--registry=https:\/\/registry\.npmjs\.org/);
});

test('a real audit result — vulnerabilities found — is a genuine failure, not an environment problem', () => {
  const output = `# npm audit report\n\nlodash  <4.17.21\nSeverity: high\nPrototype Pollution\n\n1 high severity vulnerability\n\nTo address all issues, run:\n  npm audit fix`;
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['audit', '--audit-level=high'], exitCode: 1, output }), undefined);
});

test('a missing command is an environment failure however it shows up', () => {
  assert.equal(classifyCheckEnvironmentFailure({ command: 'trivy', exitCode: null, output: '', spawnError: 'spawn trivy ENOENT' })?.kind, 'command-not-found');
  assert.equal(classifyCheckEnvironmentFailure({ command: 'trivy', exitCode: 127, output: 'sh: trivy: command not found' })?.kind, 'command-not-found');
});

test('registry network, auth and TLS failures on registry commands are environment failures', () => {
  const network = classifyCheckEnvironmentFailure({ command: 'npm', args: ['ci'], exitCode: 1, output: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' });
  assert.equal(network?.kind, 'network');
  const auth = classifyCheckEnvironmentFailure({ command: 'pnpm', args: ['install'], exitCode: 1, output: 'ERR_PNPM_FETCH_401 GET https://npm.pkg.github.com/x: Unauthorized - 401 Unauthorized' });
  assert.equal(auth?.kind, 'registry-auth');
  const tls = classifyCheckEnvironmentFailure({ command: 'npm', args: ['install'], exitCode: 1, output: 'npm error code SELF_SIGNED_CERT_IN_CHAIN\nnpm error self signed certificate in certificate chain' });
  assert.equal(tls?.kind, 'tls');
});

test('commands that run the project\'s own code are never second-guessed', () => {
  // A test that legitimately fails with a network-looking message is still a test failure.
  const output = 'FAIL  api.test.ts\n  Error: connect ECONNREFUSED 127.0.0.1:5432\n  ETIMEDOUT';
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['test'], exitCode: 1, output }), undefined);
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['run', 'build'], exitCode: 1, output }), undefined);
  assert.equal(classifyCheckEnvironmentFailure({ command: 'node', args: ['scripts/check.js'], exitCode: 1, output }), undefined);
  assert.equal(classifyCheckEnvironmentFailure({ command: 'dotnet', args: ['test'], exitCode: 1, output }), undefined);
});

test('a plain non-zero exit with unrelated output is a genuine failure', () => {
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['audit'], exitCode: 1, output: 'found 3 vulnerabilities' }), undefined);
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm.cmd', args: ['install'], exitCode: 1, output: 'npm error peer dep conflict' }), undefined);
});

/** Verbatim from the failed scheduled Full SDLC run against this repository. */
const NPM_MISSING_LINT = `npm error Missing script: "lint"
npm error
npm error Did you mean this?
npm error   npm link # Symlink a package folder
npm error
npm error To see a list of scripts, run:
npm error   npm run
npm error A complete log of this run can be found in: /Users/someone/.npm/_logs/2026-10-24T23_02_04_519Z-debug-0.log`;

test('a stage naming a script the project does not have is not configured, and says which script', () => {
  const result = classifyCheckEnvironmentFailure({ command: 'npm', args: ['run', 'lint'], exitCode: 1, output: NPM_MISSING_LINT });
  assert.equal(result?.kind, 'not-configured');
  assert.match(result?.reason ?? '', /no "lint" script/);
  assert.match(result?.hint ?? '', /package\.json/);
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['test'], exitCode: 1, output: 'npm error Missing script: "test"' })?.kind, 'not-configured');
  assert.equal(classifyCheckEnvironmentFailure({ command: 'pnpm', args: ['lint'], exitCode: 1, output: 'ERR_PNPM_NO_SCRIPT  Missing script: lint' })?.kind, 'not-configured');
  assert.equal(classifyCheckEnvironmentFailure({ command: 'yarn', args: ['run', 'lint'], exitCode: 1, output: 'error Command "lint" not found.' })?.kind, 'not-configured');
});

test('a project script that runs and then calls a missing one is still a genuine failure', () => {
  // `check` exists and ran; only something inside it was missing.
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npm', args: ['run', 'check'], exitCode: 1, output: NPM_MISSING_LINT }), undefined);
});

test('tsc with no tsconfig prints its help instead of type-checking, which is not configured', () => {
  const output = 'Version 7.0.2\ntsc: The TypeScript Compiler - Version 7.0.2\n\nCOMMON COMMANDS\n\n  tsc\n  Compiles the current project (tsconfig.json in the working directory.)';
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npx', args: ['tsc', '--noEmit'], exitCode: 1, output })?.kind, 'not-configured');
  // Real type errors are the check's verdict.
  assert.equal(classifyCheckEnvironmentFailure({ command: 'npx', args: ['tsc', '--noEmit'], exitCode: 2, output: "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'." }), undefined);
});
