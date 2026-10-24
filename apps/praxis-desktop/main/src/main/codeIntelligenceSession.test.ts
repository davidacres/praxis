import test from 'node:test';
import assert from 'node:assert/strict';
import { type CodeIntelligenceResponse } from '@praxis/core';
import { sessionCodeIntelligenceServer } from './codeIntelligenceSession';

function fixture() {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const dependencies: Parameters<typeof sessionCodeIntelligenceServer>[2] = {
    settings: { enabled: true, projectOverrides: {} },
    settingsPath: '/fixture/settings.json',
    runtime: () => ({ executable: 'service', contracts: __filename }),
    nodeExecutable: process.execPath, bridgePath: 'mcpBridge.js', dataDirectory: '/fixture/data',
    invoke: async args => {
      calls.push(args);
      if (args[0] === 'list') return { data: [] };
      if (args[0] === 'register') return { data: { repositoryId: 'pci:repo:fixture' } };
      return { data: {} };
    },
    installedModelFingerprint: async () => undefined,
    activateModel: async () => [],
    warn: (message, error) => warnings.push(`${message} ${error}`)
  };
  return { dependencies, calls, warnings };
}

test('folderless sessions get discovery and knowledge tools without registering or granting a folder', async () => {
  const { dependencies, calls, warnings } = fixture();
  const server = await sessionCodeIntelligenceServer(undefined, 'codex', dependencies);
  assert.equal(server?.name, 'code_intelligence');
  assert.equal(server?.args?.[4], '*');
  assert.equal(server?.env?.PRAXIS_CODE_INTELLIGENCE_PROVIDER, 'codex');
  assert.equal(server?.env?.PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH, '/fixture/settings.json');
  assert.equal(server?.env?.PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(warnings, []);
});

test('a folder still registers, indexes and grants only the destination provider without a semantic model', async () => {
  const { dependencies, calls } = fixture();
  const server = await sessionCodeIntelligenceServer('/fixture/docs', 'codex', dependencies);
  assert.equal(server?.args?.[4], 'pci:repo:fixture');
  assert.equal(server?.env?.PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY, '/fixture/docs');
  assert.deepEqual(calls, [['list'], ['register', '/fixture/docs'], ['index', 'pci:repo:fixture'], ['grant', 'pci:repo:fixture', '--client', 'codex']]);
});

test('an existing index is reused and receives model activation', async () => {
  const { dependencies, calls } = fixture();
  dependencies.invoke = async args => {
    calls.push(args);
    return args[0] === 'list' ? { data: [{ id: 'existing', root: '/fixture/docs' }] } : { data: {} };
  };
  let activated: unknown;
  dependencies.installedModelFingerprint = async () => 'fingerprint';
  dependencies.activateModel = async (...args) => { activated = args; return []; };
  const server = await sessionCodeIntelligenceServer('/fixture/docs', 'claude-cli', dependencies);
  assert.equal(server?.args?.[4], 'existing');
  assert.deepEqual(activated, ['fingerprint', ['existing']]);
  assert.deepEqual(calls, [['list'], ['grant', 'existing', '--client', 'claude-cli']]);
});

test('folder setup failures retain discovery of existing grants and report the reason', async () => {
  for (const operation of ['list', 'register', 'grant']) {
    for (const throws of [false, true]) {
      const { dependencies, warnings } = fixture();
      const invoke = dependencies.invoke;
      dependencies.invoke = async args => {
        if (args[0] !== operation) return invoke(args);
        if (throws) throw new Error(`${operation} failed`);
        return { error: { code: 'CAPABILITY_UNAVAILABLE', message: `${operation} failed` } } as CodeIntelligenceResponse;
      };
      const server = await sessionCodeIntelligenceServer('/fixture/docs', 'codex', dependencies);
      assert.equal(server?.args?.[4], '*', `${operation}, throws=${throws}`);
      assert.match(warnings[0], new RegExp(`${operation} failed`));
    }
  }
});

test('explicit global and project disable settings still apply', async () => {
  const { dependencies, calls } = fixture();
  dependencies.settings = { enabled: false, projectOverrides: { '/fixture/docs': true, '/fixture/off': false } };
  assert.equal(await sessionCodeIntelligenceServer(undefined, 'codex', dependencies), undefined);
  assert.equal(await sessionCodeIntelligenceServer('/fixture/off', 'codex', dependencies), undefined);
  assert.deepEqual(calls, []);
  assert.ok(await sessionCodeIntelligenceServer('/fixture/docs', 'codex', dependencies));
});

test('missing runtime or contracts is reported rather than silently omitted', async () => {
  const { dependencies, warnings } = fixture();
  dependencies.runtime = () => { throw new Error('service not installed'); };
  assert.equal(await sessionCodeIntelligenceServer(undefined, 'codex', dependencies), undefined);
  assert.match(warnings[0], /service not installed/);
  dependencies.runtime = () => ({ executable: 'service', contracts: `${__filename}.missing` });
  assert.equal(await sessionCodeIntelligenceServer(undefined, 'codex', dependencies), undefined);
  assert.match(warnings[1], /contracts are missing/);
});
