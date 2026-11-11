import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';

const channels = ['projects:getRunProfile', 'projects:saveRunProfile', 'projects:validateRunProfile', 'projects:discoverRunServices',
  'deployments:listProfiles', 'deployments:getProfile', 'deployments:saveProfile', 'deployments:validateProfile', 'deployments:preflightCapabilities'];

for (const mode of ['typescript', 'rust'] as const) test(`${mode} profile IPC validates and persists through the real desktop`, async () => {
  const app = await launchTestApp(undefined, undefined, {
    PRAXIS_RUST_CHANNELS: mode === 'rust' ? channels.join(',') : 'none',
    PRAXIS_EXPECT_RUST_MODE: undefined,
  }, { openNewSession: false });
  const folder = path.join(app.userDataDir, 'project'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ scripts: { dev: 'not executed by discovery' } }));
  try {
    const proof = await app.electronApp.evaluate(async ({ app }) => {
      const require = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/out/main/index.js');
      const bridge = require('./rustHostInstance.js').getRustHostBridge();
      return { channels: bridge.migratedChannels(), status: await bridge.invoke('host:status') };
    });
    expect(proof.channels).toEqual(mode === 'rust' ? [...channels].sort() : []);
    if (mode === 'rust') expect(proof.status.crateVersion).toBeTruthy();
    const result = await app.window.evaluate(async folderPath => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create({ name: 'Profile project', key: 'PROF', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'read-only' }, workspace.id);
      const at = '2026-11-09T00:00:00.000Z';
      const run = { schemaVersion: 1, id: 'run', name: 'Run', services: [{ id: 'web', name: 'Web', executable: 'npm', args: ['run', 'dev'] }], createdAt: at, updatedAt: at };
      const deploy = { schemaVersion: 1, version: 1, id: 'deploy', projectId: project.id, name: 'Deploy', environment: 'production', executor: { kind: 'direct-process' as const }, target: { kind: 'directory' as const, path: 'dist' }, rollback: { kind: 'none' as const }, createdAt: at, updatedAt: at };
      const runValidation = await window.praxis.projects.validateRunProfile(run);
      await window.praxis.projects.saveRunProfile(project.id, run);
      const runRead = await window.praxis.projects.getRunProfile(project.id);
      const discovered = await window.praxis.projects.discoverRunServices(project.id);
      const deployValidation = await window.praxis.deployments.validateProfile(deploy);
      const capabilities = await window.praxis.deployments.preflightCapabilities(deploy);
      await window.praxis.deployments.saveProfile(project.id, deploy);
      const deployRead = await window.praxis.deployments.getProfile(project.id, deploy.id);
      const listed = await window.praxis.deployments.listProfiles(project.id);
      const credentials = await window.praxis.deployments.evaluateCredentials(deploy);
      return { runValidation, runRead, discovered, deployValidation, capabilities, deployRead, listed, credentials, run, deploy };
    }, folder);
    expect(result.runValidation).toEqual({ valid: true, errors: [] });
    expect(result.deployValidation).toEqual({ valid: true, errors: [] });
    expect(result.runRead).toEqual({ profile: result.run, issues: [] });
    expect(result.deployRead).toEqual({ profile: result.deploy, issues: [] });
    expect(result.listed).toEqual([result.deploy]);
    expect(result.credentials).toEqual({ statuses: [], allBound: true });
    expect(result.capabilities).toEqual([]);
    expect(result.discovered).toEqual([{ executable: 'npm', args: ['run', 'dev'], source: 'package.json', relativeDir: '.' }]);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'run.praxis.json'), 'utf8'))).toEqual(result.run);
    console.log(`[profile-ipc] ${mode}: validated all nine controls; credentials remain in Electron.`);
  } finally { await closeTestApp(app); }
});
