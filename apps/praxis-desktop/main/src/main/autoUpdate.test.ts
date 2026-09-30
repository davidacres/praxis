import assert from 'node:assert/strict';
import test from 'node:test';
import type { UpdateStatus } from '@praxis/core';
import { githubReleaseUrl, resolveElectronAutoUpdater, UpdateController, type UpdaterPort, type UpdateControllerDeps } from './autoUpdate';

function fakeUpdater(latest: string | null, current = '0.3.3') {
  let progress: ((percent: number) => void) | undefined;
  const calls = { check: 0, download: 0, install: 0 };
  const updater: UpdaterPort = {
    checkForUpdates: async () => {
      calls.check++;
      return latest === null ? null : { isUpdateAvailable: latest !== current, updateInfo: { version: latest } };
    },
    downloadUpdate: async () => {
      calls.download++;
      progress?.(42.4);
      return [];
    },
    quitAndInstall: () => { calls.install++; },
    onDownloadProgress: listener => { progress = listener; }
  };
  return { updater, calls };
}

function controller(updater: UpdaterPort, overrides: Partial<UpdateControllerDeps> = {}) {
  const seen: UpdateStatus[] = [];
  const logs: string[] = [];
  const ctl = new UpdateController({
    currentVersion: '0.3.3',
    canInstall: async () => true,
    releaseUrl: version => `https://example.test/v${version}`,
    loadUpdater: async () => updater,
    publish: status => seen.push(status),
    log: line => logs.push(line),
    ...overrides
  });
  return { ctl, seen, logs };
}

test('downloads a newer release in the background and waits for a restart', async () => {
  const { updater, calls } = fakeUpdater('0.4.0');
  const { ctl, seen } = controller(updater);

  const final = await ctl.check();

  assert.deepEqual(final, { state: 'ready', version: '0.4.0' });
  assert.deepEqual(seen.map(s => s.state), ['checking', 'available', 'downloading', 'downloading', 'ready']);
  assert.deepEqual(seen[3], { state: 'downloading', version: '0.4.0', percent: 42 });
  assert.equal(calls.download, 1);

  await ctl.check();
  assert.equal(calls.check, 1, 'a downloaded update is not re-checked until the restart');

  await ctl.installNow();
  assert.equal(calls.install, 1);
});

test('reports an update it cannot install without downloading it', async () => {
  const { updater, calls } = fakeUpdater('0.4.0');
  const { ctl } = controller(updater, { canInstall: async () => false });

  const final = await ctl.check();

  assert.deepEqual(final, { state: 'available', version: '0.4.0', canInstall: false, releaseUrl: 'https://example.test/v0.4.0' });
  assert.equal(calls.download, 0);
  assert.deepEqual(await ctl.download(), final, 'an explicit download request is refused too');
  await ctl.installNow();
  assert.equal(calls.install, 0);
});

test('says the build is current when the feed has nothing newer', async () => {
  for (const latest of ['0.3.3', null]) {
    const { ctl } = controller(fakeUpdater(latest).updater);
    assert.deepEqual(await ctl.check(), { state: 'current', version: '0.3.3' });
  }
});

test('shares one in-flight check between concurrent callers', async () => {
  const { updater, calls } = fakeUpdater('0.3.3');
  const { ctl } = controller(updater);
  await Promise.all([ctl.check(), ctl.check(), ctl.check()]);
  assert.equal(calls.check, 1);
});

test('surfaces a feed failure as an error state and logs it', async () => {
  const updater: UpdaterPort = {
    ...fakeUpdater('0.4.0').updater,
    checkForUpdates: async () => { throw new Error('HttpError: 404'); }
  };
  const { ctl, logs } = controller(updater);
  assert.deepEqual(await ctl.check(), { state: 'error', message: 'HttpError: 404' });
  assert.deepEqual(logs, ['[update] check failed: HttpError: 404']);
});

test('never touches the updater in an unsupported build', async () => {
  let loaded = false;
  const { ctl, seen } = controller(fakeUpdater('0.4.0').updater, {
    unsupportedReason: 'Updates are only checked in a packaged build.',
    loadUpdater: async () => { loaded = true; return fakeUpdater('0.4.0').updater; }
  });
  assert.equal(ctl.getStatus().state, 'unsupported');
  assert.deepEqual(await ctl.check(), { state: 'unsupported', reason: 'Updates are only checked in a packaged build.' });
  assert.equal(loaded, false);
  assert.equal(seen.length, 1);
});

test('builds the release page link from a GitHub feed config only', () => {
  const feed = 'owner: davidacres\nrepo: praxis\nprovider: github\nupdaterCacheDirName: praxis-updater\n';
  assert.equal(githubReleaseUrl(feed, '0.4.0'), 'https://github.com/davidacres/praxis/releases/tag/v0.4.0');
  assert.equal(githubReleaseUrl('provider: generic\nurl: https://x.test\n', '0.4.0'), undefined);
  assert.equal(githubReleaseUrl('', '0.4.0'), undefined);
});

test('resolves autoUpdater from named and CommonJS default import shapes', () => {
  const updater = { marker: 'updater' };
  assert.equal(resolveElectronAutoUpdater({ autoUpdater: updater }), updater);
  assert.equal(resolveElectronAutoUpdater({ default: { autoUpdater: updater } }), updater);
  assert.throws(() => resolveElectronAutoUpdater({}), /did not expose autoUpdater/);
});
