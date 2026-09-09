import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeDotnetRunService, proposeNodeRunService } from './runProfileDiscovery';

// ── Node frontend ───────────────────────────────────────────────────────

test('a Vite-style frontend package.json proposes npm run dev', () => {
  const pkg = JSON.stringify({
    name: 'web',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: { react: '^18.0.0' }
  });
  const proposed = proposeNodeRunService(pkg);
  assert.deepEqual(proposed, { executable: 'npm', args: ['run', 'dev'], source: 'package.json' });
});

test('a package.json with only a start script proposes npm run start', () => {
  const pkg = JSON.stringify({ name: 'api', scripts: { start: 'node server.js' } });
  const proposed = proposeNodeRunService(pkg);
  assert.deepEqual(proposed, { executable: 'npm', args: ['run', 'start'], source: 'package.json' });
});

test('dev is preferred over start when both exist', () => {
  const pkg = JSON.stringify({ scripts: { dev: 'next dev', start: 'next start' } });
  const proposed = proposeNodeRunService(pkg);
  assert.deepEqual(proposed?.args, ['run', 'dev']);
});

test('a package.json with no dev/start/serve script proposes nothing', () => {
  const pkg = JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } });
  assert.equal(proposeNodeRunService(pkg), undefined);
});

test('a malformed package.json proposes nothing rather than throwing', () => {
  assert.equal(proposeNodeRunService('{ not json'), undefined);
});

test('discovery never executes anything -- it only ever calls JSON.parse on the manifest text', () => {
  // A script whose *value* looks dangerous is still just parsed as a string,
  // never invoked -- this test's real point is that calling the function at
  // all does not run a subprocess (no child_process import exists in this
  // module to do so).
  const pkg = JSON.stringify({ scripts: { dev: 'rm -rf / && vite' } });
  const proposed = proposeNodeRunService(pkg);
  assert.deepEqual(proposed, { executable: 'npm', args: ['run', 'dev'], source: 'package.json' });
});

// ── ASP.NET API ─────────────────────────────────────────────────────────

test('an ASP.NET launchSettings.json proposes dotnet run with the bind port', () => {
  const launchSettings = JSON.stringify({
    profiles: {
      IIS_Express: { commandName: 'IISExpress', applicationUrl: 'http://localhost:52000' },
      Api: {
        commandName: 'Project',
        applicationUrl: 'https://localhost:5001;http://localhost:5000',
        launchBrowser: false
      }
    }
  });
  const proposed = proposeDotnetRunService(launchSettings);
  assert.equal(proposed?.executable, 'dotnet');
  assert.deepEqual(proposed?.args, ['run']);
  assert.equal(proposed?.port, 5001); // first URL in the bind list
  assert.equal(proposed?.browserOrigin, undefined); // launchBrowser is false
});

test('a bind address and a sub-path browser origin (e.g. swagger) are reported distinctly', () => {
  const launchSettings = JSON.stringify({
    profiles: {
      Api: {
        commandName: 'Project',
        applicationUrl: 'https://localhost:7001;http://localhost:5001',
        launchBrowser: true,
        launchUrl: 'swagger'
      }
    }
  });
  const proposed = proposeDotnetRunService(launchSettings);
  assert.equal(proposed?.port, 7001);
  assert.equal(proposed?.browserOrigin, 'https://localhost:7001/swagger');
  assert.notEqual(proposed?.browserOrigin, String(proposed?.port)); // distinct concepts, not the same value
});

test('launchBrowser true with no launchUrl opens the bind address itself as the browser origin', () => {
  const launchSettings = JSON.stringify({
    profiles: { Web: { commandName: 'Project', applicationUrl: 'https://localhost:7100', launchBrowser: true } }
  });
  const proposed = proposeDotnetRunService(launchSettings);
  assert.equal(proposed?.browserOrigin, 'https://localhost:7100');
});

test('the Project profile is preferred over an IIS Express profile listed first', () => {
  const launchSettings = JSON.stringify({
    profiles: {
      IIS_Express: { commandName: 'IISExpress', applicationUrl: 'http://localhost:52000' },
      MyApi: { commandName: 'Project', applicationUrl: 'https://localhost:7200' }
    }
  });
  const proposed = proposeDotnetRunService(launchSettings);
  assert.equal(proposed?.port, 7200);
});

test('a launchSettings.json with no profiles proposes nothing', () => {
  assert.equal(proposeDotnetRunService(JSON.stringify({ profiles: {} })), undefined);
});

test('a malformed launchSettings.json proposes nothing rather than throwing', () => {
  assert.equal(proposeDotnetRunService('not json'), undefined);
});

// ── Multiple services ────────────────────────────────────────────────────

test('a frontend and an API manifest each propose their own independent service', () => {
  const frontend = proposeNodeRunService(JSON.stringify({ scripts: { dev: 'vite' } }));
  const api = proposeDotnetRunService(
    JSON.stringify({ profiles: { Api: { commandName: 'Project', applicationUrl: 'https://localhost:7001' } } })
  );
  assert.equal(frontend?.source, 'package.json');
  assert.equal(api?.source, 'launchSettings.json');
  assert.notEqual(frontend?.executable, api?.executable);
});
