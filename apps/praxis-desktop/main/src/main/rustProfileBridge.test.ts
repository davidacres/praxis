import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateRunProfile, validateDeploymentProfile, preflightDeploymentCapabilities,
  writeRunProfile, readRunProfile, readDeploymentProfile, writeDeploymentProfile,
  listDeploymentProfiles, proposeNodeRunService, proposeDotnetRunService,
  type RunProfile, type DeploymentProfile,
} from '@praxis/core';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';
import { decodeRustProfile } from './rustProfileReads';

const at = '2026-11-09T00:00:00.000Z';
const run: RunProfile = { schemaVersion: 1, id: 'run', name: 'Run', services: [{ id: 'web', name: 'Web', executable: 'npm' }], createdAt: at, updatedAt: at };
const deployment: DeploymentProfile = { schemaVersion: 1, id: 'prod', version: 1, name: 'Prod', projectId: 'p', environment: 'production', executor: { kind: 'direct-process' }, target: { kind: 'directory', path: 'dist' }, rollback: { kind: 'none' }, createdAt: at, updatedAt: at };
function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-profile-parity-'));
  const bridge = new RustHostBridge({ transport: new StdioRustHostTransport({ userDataDir: dir, settingsPath: path.join(dir, 'settings.json') }) });
  t.after(async () => { await bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, bridge };
}

test('Run profile validation agrees on invalid fields, ports, probes, secrets and dependency graphs', async t => {
  const { bridge } = setup(t);
  const fixtures: unknown[] = [run, { ...run, id: '', name: ' ' }, { ...run, services: [] }];
  const services: unknown[] = [
    { ...run.services[0], executable: '' }, { ...run.services[0], cwd: '/absolute' },
    ...[-1, 0, 1.5, 65536, null, 65535].map(port => ({ ...run.services[0], port })),
    ...[{ kind: 'future' }, { kind: 'http', path: '' }, { kind: 'tcp', port: -2 }, { kind: 'log-line', match: '' }, null].map(readinessProbe => ({ ...run.services[0], readinessProbe })),
    { ...run.services[0], env: { MY_PAT: 'literal', API_KEY: '${secret:SAFE}', PASSWORD: 'literal' } },
    { ...run.services[0], dependsOn: ['missing'] },
  ];
  for (const service of services) fixtures.push({ ...run, services: [service] });
  fixtures.push({ ...run, services: [run.services[0], run.services[0]] });
  fixtures.push({ ...run, services: [
    { ...run.services[0], id: 'root', dependsOn: ['a'] },
    { ...run.services[0], id: 'a', dependsOn: ['b'] },
    { ...run.services[0], id: 'b', dependsOn: ['a'] },
  ] });
  for (const [index, profile] of fixtures.entries()) await t.test(`case ${index}`, async () => {
    assert.deepEqual(await bridge.invoke('projects:validateRunProfile', profile), validateRunProfile(profile as RunProfile));
  });
});

test('deployment profile validation and capability preflight agree with TypeScript', async t => {
  const { bridge } = setup(t);
  const fixtures: unknown[] = [deployment, {}, { ...deployment, id: '', version: 0 },
    { ...deployment, target: { kind: 'directory', path: '/absolute' } },
    { ...deployment, credentials: { TOKEN: 'literal', SAFE: '${secret:SAFE}' } },
    { ...deployment, executor: { kind: 'future' } },
    { ...deployment, rollback: { kind: 'keep-previous-artifact', retainCount: -1 } },
  ];
  for (const [index, profile] of fixtures.entries()) await t.test(`case ${index}`, async () => {
    assert.deepEqual(await bridge.invoke('deployments:validateProfile', profile), validateDeploymentProfile(profile as DeploymentProfile));
  });
  for (const profile of [deployment, { ...deployment, executor: { kind: 'gitlab-ci', pipelineFile: '.gitlab-ci.yml' } }, { ...deployment, target: { kind: 'docker', image: 'app:latest' } }]) {
    assert.deepEqual(await bridge.invoke('deployments:preflightCapabilities', profile), preflightDeploymentCapabilities(profile as DeploymentProfile));
  }
});

test('profile writes preserve extension fields, refuse invalid data, and read malformed JSON consistently', async t => {
  const { dir, bridge } = setup(t);
  const ts = path.join(dir, 'ts'); const rust = path.join(dir, 'rust');
  fs.mkdirSync(ts); fs.mkdirSync(rust);
  const extendedRun = { ...run, futureField: true, services: [{ ...run.services[0], futureServiceField: true }] };
  const extendedDeployment = { ...deployment, futureField: { retained: true } };
  await writeRunProfile(ts, extendedRun);
  await bridge.invoke('projects:saveRunProfile', rust, extendedRun);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rust, 'run.praxis.json'), 'utf8')), extendedRun);
  assert.deepEqual(decodeRustProfile(await bridge.invoke('projects:getRunProfile', rust), 'run'), await readRunProfile(ts));
  await writeDeploymentProfile(ts, extendedDeployment);
  assert.deepEqual(await bridge.invoke('deployments:saveProfile', rust, extendedDeployment), extendedDeployment);
  assert.deepEqual(decodeRustProfile(await bridge.invoke('deployments:getProfile', rust, 'prod'), 'deployment'), await readDeploymentProfile(ts, 'prod'));
  assert.deepEqual(await bridge.invoke('deployments:listProfiles', rust), await listDeploymentProfiles(ts));
  for (const [channel, profile, file] of [
    ['projects:saveRunProfile', { ...run, services: [] }, path.join(rust, 'run.praxis.json')],
    ['deployments:saveProfile', { ...deployment, version: 0 }, path.join(rust, '.praxis/deployments/prod.deployment.praxis.json')],
  ] as const) {
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(bridge.invoke(channel, rust, profile), /invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  for (const raw of ['{ malformed', 'null', '{}', JSON.stringify({ ...run, schemaVersion: 2 })]) {
    fs.writeFileSync(path.join(ts, 'run.praxis.json'), raw); fs.writeFileSync(path.join(rust, 'run.praxis.json'), raw);
    assert.deepEqual(decodeRustProfile(await bridge.invoke('projects:getRunProfile', rust), 'run'), await readRunProfile(ts));
  }
  for (const raw of ['{ malformed', '{}', JSON.stringify(extendedDeployment)]) {
    const relative = '.praxis/deployments/prod.deployment.praxis.json';
    fs.writeFileSync(path.join(ts, relative), raw); fs.writeFileSync(path.join(rust, relative), raw);
    assert.deepEqual(decodeRustProfile(await bridge.invoke('deployments:getProfile', rust, 'prod'), 'deployment'), await readDeploymentProfile(ts, 'prod'));
    assert.deepEqual(await bridge.invoke('deployments:listProfiles', rust), await listDeploymentProfiles(ts));
  }
  assert.deepEqual(await bridge.invoke('projects:getRunProfile', path.join(dir, 'missing')), { issues: [] });
  assert.deepEqual(await bridge.invoke('projects:discoverRunServices', ''), []);
  assert.deepEqual(await bridge.invoke('deployments:getProfile', rust, 'missing'), { issues: [] });
});

test('Run service discovery reads the same shallow manifests without executing or writing', async t => {
  const { dir, bridge } = setup(t);
  const rootManifest = JSON.stringify({ scripts: { start: 'should-not-run', dev: 'should-not-run' } });
  const launch = JSON.stringify({ profiles: { zFirst: { commandName: 'Project', applicationUrl: 'http://localhost:5222', launchBrowser: true, launchUrl: 'swagger' }, aSecond: { commandName: 'Project', applicationUrl: 'http://localhost:5333' } } });
  fs.writeFileSync(path.join(dir, 'package.json'), rootManifest);
  fs.mkdirSync(path.join(dir, 'api/Properties'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/Properties/launchSettings.json'), launch);
  fs.mkdirSync(path.join(dir, 'node_modules/ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/ignored/package.json'), rootManifest);
  const expected = [{ ...proposeNodeRunService(rootManifest), relativeDir: '.' }, { ...proposeDotnetRunService(launch), relativeDir: 'api' }];
  assert.deepEqual(await bridge.invoke('projects:discoverRunServices', dir), expected);
  assert.equal(fs.existsSync(path.join(dir, 'run.praxis.json')), false);
});
