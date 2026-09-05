import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { type InstalledAddon } from './catalogTypes';
import { MarketplaceService, type AddonStorage } from './marketplaceService';
import {
  type MarketplaceRegistryClient,
  type Packument,
  type RegistryPackageRef
} from './registryClient';

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function tarballFor(name: string): Uint8Array {
  return new TextEncoder().encode(`tarball:${name}`);
}

function manifest(kind: string, id: string, extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, kind, id, name: `${id} ${kind}`, summary: 's', author: 'a', ...extra };
}

function packument(name: string, versions: Record<string, unknown>, latest: string, time?: Record<string, string>): Packument {
  const out: Packument['versions'] = {};
  for (const [version, praxis] of Object.entries(versions)) {
    const bytes = tarballFor(`${name}@${version}`);
    out[version] = {
      version,
      praxis,
      dist: { tarball: `https://reg/${name}/${version}.tgz`, integrity: sri(bytes) }
    };
  }
  return { name, distTags: { latest }, versions: out, time };
}

class FakeClient implements MarketplaceRegistryClient {
  public constructor(
    private readonly packages: RegistryPackageRef[],
    private readonly packuments: Record<string, Packument>
  ) {}

  listAddonPackages(): Promise<RegistryPackageRef[]> {
    return Promise.resolve(this.packages);
  }

  getPackument(packageName: string): Promise<Packument> {
    const found = this.packuments[packageName];
    if (!found) return Promise.reject(new Error(`404 ${packageName}`));
    return Promise.resolve(found);
  }

  downloadTarball(url: string): Promise<Uint8Array> {
    const match = /https:\/\/reg\/(.+)\/([^/]+)\.tgz$/.exec(url);
    if (!match) return Promise.reject(new Error(`bad url ${url}`));
    return Promise.resolve(tarballFor(`${match[1]}@${match[2]}`));
  }
}

class MemoryStorage implements AddonStorage {
  public readonly records = new Map<string, InstalledAddon>();
  public readonly writes: Array<{ record: InstalledAddon; bytes: number }> = [];

  private key(kind: string, id: string): string {
    return `${kind}/${id}`;
  }

  list(): Promise<InstalledAddon[]> {
    return Promise.resolve([...this.records.values()]);
  }

  get(kind: string, id: string): Promise<InstalledAddon | undefined> {
    return Promise.resolve(this.records.get(this.key(kind, id)));
  }

  write(record: InstalledAddon, tarball: Uint8Array): Promise<void> {
    this.writes.push({ record, bytes: tarball.byteLength });
    this.records.set(this.key(record.manifest.kind, record.manifest.id), { ...record });
    return Promise.resolve();
  }

  remove(kind: string, id: string): Promise<void> {
    this.records.delete(this.key(kind, id));
    return Promise.resolve();
  }

  setEnabled(kind: string, id: string, enabled: boolean): Promise<void> {
    const existing = this.records.get(this.key(kind, id));
    if (existing) existing.enabled = enabled;
    return Promise.resolve();
  }
}

function makeService(opts?: { appVersion?: string; packages?: RegistryPackageRef[]; packuments?: Record<string, Packument> }) {
  const packages = opts?.packages ?? [
    { name: 'praxis-addon-nord', updatedAt: '2026-03-01T00:00:00Z' },
    { name: 'praxis-addon-flow', updatedAt: '2026-02-01T00:00:00Z' }
  ];
  const packuments = opts?.packuments ?? {
    'praxis-addon-nord': packument(
      'praxis-addon-nord',
      { '1.0.0': manifest('theme', 'nord'), '1.2.0': manifest('theme', 'nord') },
      '1.2.0',
      { '1.2.0': '2026-03-01T00:00:00Z' }
    ),
    'praxis-addon-flow': packument(
      'praxis-addon-flow',
      { '0.9.0': manifest('agent', 'flow') },
      '0.9.0'
    )
  };
  const storage = new MemoryStorage();
  const logs: string[] = [];
  const service = new MarketplaceService({
    client: new FakeClient(packages, packuments),
    storage,
    appVersion: opts?.appVersion ?? '0.2.1',
    log: (m) => logs.push(m)
  });
  return { service, storage, logs };
}

test('listCatalog resolves each package to its latest version, sorted by kind then name', async () => {
  const { service } = makeService();
  const catalog = await service.listCatalog();
  assert.deepEqual(
    catalog.map((e) => `${e.manifest.kind}/${e.manifest.id}@${e.latestVersion}`),
    ['agent/flow@0.9.0', 'theme/nord@1.2.0']
  );
  assert.deepEqual(catalog[1].versions, ['1.2.0', '1.0.0']);
  assert.equal(catalog[1].updatedAt, '2026-03-01T00:00:00Z');
});

test('listCatalog drops a package whose latest manifest is invalid, keeps the rest', async () => {
  const { service, logs } = makeService({
    packages: [{ name: 'praxis-addon-broken' }, { name: 'praxis-addon-nord' }],
    packuments: {
      'praxis-addon-broken': packument('praxis-addon-broken', { '1.0.0': { schemaVersion: 1, kind: 'theme' } }, '1.0.0'),
      'praxis-addon-nord': packument('praxis-addon-nord', { '1.0.0': manifest('theme', 'nord') }, '1.0.0')
    }
  });
  const catalog = await service.listCatalog();
  assert.deepEqual(catalog.map((e) => e.manifest.id), ['nord']);
  assert.ok(logs.some((l) => l.includes('praxis-addon-broken') && l.includes('invalid manifest')));
});

test('listCatalog marks an add-on that needs a newer app as incompatible but still lists it', async () => {
  const { service } = makeService({
    appVersion: '0.2.1',
    packages: [{ name: 'praxis-addon-future' }],
    packuments: {
      'praxis-addon-future': packument(
        'praxis-addon-future',
        { '2.0.0': manifest('theme', 'future', { minAppVersion: '9.0.0' }) },
        '2.0.0'
      )
    }
  });
  const [entry] = await service.listCatalog();
  assert.equal(entry.incompatible, true);
  assert.ok(entry.warnings.some((w) => w.includes('9.0.0')));
});

test('install verifies integrity, unpacks, and enables a declarative add-on', async () => {
  const { service, storage } = makeService();
  const record = await service.install('praxis-addon-nord');
  assert.equal(record.version, '1.2.0');
  assert.equal(record.enabled, true);
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.writes[0].bytes, tarballFor('praxis-addon-nord@1.2.0').byteLength);
});

test('install leaves an agent add-on disabled unless trust is granted', async () => {
  const { service } = makeService();
  const untrusted = await service.install('praxis-addon-flow');
  assert.equal(untrusted.enabled, false);

  const trusted = await service.install('praxis-addon-flow', { trustAgent: true });
  assert.equal(trusted.enabled, true);
});

test('install can pin a specific version', async () => {
  const { service } = makeService();
  const record = await service.install('praxis-addon-nord', { version: '1.0.0' });
  assert.equal(record.version, '1.0.0');
});

test('install rejects a tampered tarball', async () => {
  const badBytes = new TextEncoder().encode('not what was hashed');
  const client: MarketplaceRegistryClient = {
    listAddonPackages: () => Promise.resolve([]),
    getPackument: () =>
      Promise.resolve({
        name: 'praxis-addon-evil',
        distTags: { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            version: '1.0.0',
            praxis: manifest('theme', 'evil'),
            dist: { tarball: 'https://reg/evil/1.0.0.tgz', integrity: sri(new Uint8Array([9, 9, 9])) }
          }
        }
      }),
    downloadTarball: () => Promise.resolve(badBytes)
  };
  const service = new MarketplaceService({
    client,
    storage: new MemoryStorage(),
    appVersion: '1.0.0'
  });
  await assert.rejects(() => service.install('praxis-addon-evil'), /did not match the integrity hash/);
});

test('install refuses an add-on that requires a newer app', async () => {
  const { service } = makeService({
    appVersion: '0.2.1',
    packages: [{ name: 'praxis-addon-future' }],
    packuments: {
      'praxis-addon-future': packument(
        'praxis-addon-future',
        { '2.0.0': manifest('theme', 'future', { minAppVersion: '9.0.0' }) },
        '2.0.0'
      )
    }
  });
  await assert.rejects(() => service.install('praxis-addon-future'), /needs Praxis 9\.0\.0 or newer/);
});

test('checkForUpdates reports only installed add-ons with a strictly newer latest', async () => {
  const { service, storage } = makeService();
  await service.install('praxis-addon-nord', { version: '1.0.0' });
  await service.install('praxis-addon-flow', { trustAgent: true });

  const updates = await service.checkForUpdates();
  assert.deepEqual(updates, [
    {
      id: 'nord',
      kind: 'theme',
      packageName: 'praxis-addon-nord',
      installedVersion: '1.0.0',
      latestVersion: '1.2.0'
    }
  ]);
  assert.ok(storage); // flow is already latest -> no update
});

test('update reinstalls at latest and preserves agent trust', async () => {
  const { service, storage } = makeService({
    packages: [{ name: 'praxis-addon-flow' }],
    packuments: {
      'praxis-addon-flow': packument(
        'praxis-addon-flow',
        { '0.9.0': manifest('agent', 'flow'), '1.0.0': manifest('agent', 'flow') },
        '1.0.0'
      )
    }
  });
  await service.install('praxis-addon-flow', { version: '0.9.0', trustAgent: true });
  const updated = await service.update('agent', 'flow');
  assert.equal(updated.version, '1.0.0');
  assert.equal(updated.enabled, true);
  assert.equal(storage.records.get('agent/flow')?.version, '1.0.0');
});

test('setAgentTrust flips the stored enabled flag and rejects an unknown id', async () => {
  const { service, storage } = makeService();
  await service.install('praxis-addon-flow');
  await service.setAgentTrust('flow', true);
  assert.equal(storage.records.get('agent/flow')?.enabled, true);
  await service.setAgentTrust('flow', false);
  assert.equal(storage.records.get('agent/flow')?.enabled, false);
  await assert.rejects(() => service.setAgentTrust('ghost', true), /No installed agent add-on/);
});

test('remove deletes the install record', async () => {
  const { service, storage } = makeService();
  await service.install('praxis-addon-nord');
  await service.remove('theme', 'nord');
  assert.equal(storage.records.size, 0);
});
