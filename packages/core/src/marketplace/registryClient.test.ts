import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  GitHubPackagesRegistryClient,
  encodePackumentPath,
  formatRegistryError,
  parseNextLink
} from './registryClient';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

function fakeFetch(handler: Handler): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

test('encodePackumentPath encodes scoped and unscoped names', () => {
  assert.equal(encodePackumentPath('praxis-addon-nord'), 'praxis-addon-nord');
  assert.equal(encodePackumentPath('@acme/praxis-addon-nord'), '@acme%2Fpraxis-addon-nord');
});

test('parseNextLink pulls rel="next" out of a Link header', () => {
  const header =
    '<https://api.github.com/users/x/packages?page=2>; rel="next", <https://api.github.com/users/x/packages?page=5>; rel="last"';
  assert.equal(parseNextLink(header), 'https://api.github.com/users/x/packages?page=2');
  assert.equal(parseNextLink(null), undefined);
  assert.equal(parseNextLink('<x>; rel="prev"'), undefined);
});

test('formatRegistryError adds a token hint on 401/403 and stays terse otherwise', () => {
  assert.match(
    formatRegistryError('Listing', 403, 'Forbidden', '{"message":"Bad credentials"}'),
    /Bad credentials.*read:packages/s
  );
  assert.match(formatRegistryError('Fetching x', 404, 'Not Found', ''), /not found \(404\)/);
  assert.match(formatRegistryError('X', 500, 'Server Error', ''), /500 Server Error/);
});

test('listAddonPackages filters by prefix, follows pagination, and sorts newest-first', async () => {
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'org', token: 't' },
    fakeFetch((url) => {
      if (url === 'https://api.github.com/orgs/acme/packages?package_type=npm&per_page=100') {
        return json(
          [
            { name: 'praxis-addon-nord', html_url: 'https://gh/nord', updated_at: '2026-01-01T00:00:00Z' },
            { name: 'some-other-lib', updated_at: '2026-09-01T00:00:00Z' }
          ],
          { headers: { link: '<https://api.github.com/orgs/acme/packages?page=2>; rel="next"' } }
        );
      }
      if (url === 'https://api.github.com/orgs/acme/packages?page=2') {
        return json([
          { name: 'praxis-addon-solarized', updated_at: '2026-05-05T00:00:00Z' }
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    })
  );

  const refs = await client.listAddonPackages();
  assert.deepEqual(
    refs.map((r) => r.name),
    ['praxis-addon-solarized', 'praxis-addon-nord']
  );
  assert.equal(refs[1].htmlUrl, 'https://gh/nord');
});

test('listAddonPackages surfaces a 403 with the token hint', async () => {
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 'bad' },
    fakeFetch(() => new Response('{"message":"Bad credentials"}', { status: 403, statusText: 'Forbidden' }))
  );
  await assert.rejects(() => client.listAddonPackages(), /read:packages/);
});

test('getPackument normalizes dist-tags, versions, and time; drops versions with no tarball', async () => {
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 't' },
    fakeFetch((url) => {
      assert.equal(url, 'https://npm.pkg.github.com/praxis-addon-nord');
      return json({
        name: 'praxis-addon-nord',
        'dist-tags': { latest: '1.2.0', next: '1.3.0-rc.1' },
        time: { '1.2.0': '2026-02-02T00:00:00Z', modified: '2026-02-02T00:00:00Z' },
        versions: {
          '1.1.0': { version: '1.1.0', dist: {} }, // no tarball -> dropped
          '1.2.0': {
            version: '1.2.0',
            praxis: { schemaVersion: 1, kind: 'theme', id: 'nord', name: 'Nord' },
            dist: { tarball: 'https://npm.pkg.github.com/download/nord/1.2.0/x.tgz', integrity: 'sha512-AAA' }
          }
        }
      });
    })
  );

  const packument = await client.getPackument('praxis-addon-nord');
  assert.equal(packument.distTags.latest, '1.2.0');
  assert.deepEqual(Object.keys(packument.versions), ['1.2.0']);
  assert.equal(packument.versions['1.2.0'].dist.integrity, 'sha512-AAA');
  assert.equal(packument.time?.['1.2.0'], '2026-02-02T00:00:00Z');
});

test('downloadTarball returns the raw bytes and sends the bearer token', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 'sekret' },
    fakeFetch((url, init) => {
      assert.equal(url, 'https://npm.pkg.github.com/download/nord/1.2.0/x.tgz');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sekret');
      return new Response(bytes, { status: 200 });
    })
  );

  const out = await client.downloadTarball('https://npm.pkg.github.com/download/nord/1.2.0/x.tgz');
  assert.deepEqual([...out], [1, 2, 3, 4]);
});

test('downloadTarball throws a formatted error on a bad response', async () => {
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 't' },
    fakeFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }))
  );
  await assert.rejects(() => client.downloadTarball('https://x/y.tgz'), /not found \(404\)/);
});
