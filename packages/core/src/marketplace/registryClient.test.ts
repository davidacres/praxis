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
  // The name is kept exactly as the registry's own REST listing returns it —
  // see getPackument's scoped-retry test for why normalizing it here would be
  // wrong (it broke this project's own mock-registry e2e suite once already).
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

test('getPackument retries scoped on a 404 for an unscoped name (GitHub Packages requires it for some accounts)', async () => {
  const requested: string[] = [];
  const client = new GitHubPackagesRegistryClient(
    { owner: 'davidacres', ownerType: 'user', token: 't' },
    fakeFetch((url) => {
      requested.push(url);
      if (url === 'https://npm.pkg.github.com/praxis-addon-solarized') {
        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
      if (url === 'https://npm.pkg.github.com/@davidacres%2Fpraxis-addon-solarized') {
        return json({ name: '@davidacres/praxis-addon-solarized', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': { version: '1.0.0', praxis: { schemaVersion: 1, kind: 'theme', id: 'solarized', name: 'Solarized' }, dist: { tarball: 'https://x/tgz', integrity: 'sha512-AAA' } }
        } });
      }
      throw new Error(`unexpected url ${url}`);
    })
  );

  const packument = await client.getPackument('praxis-addon-solarized');
  assert.deepEqual(requested, [
    'https://npm.pkg.github.com/praxis-addon-solarized',
    'https://npm.pkg.github.com/@davidacres%2Fpraxis-addon-solarized'
  ]);
  assert.equal(packument.distTags.latest, '1.0.0');
});

test('getPackument does not retry when the unscoped name already resolves (this project\'s mock registry)', async () => {
  const requested: string[] = [];
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 't' },
    fakeFetch((url) => {
      requested.push(url);
      return json({ name: 'praxis-addon-nord', 'dist-tags': { latest: '1.0.0' }, versions: {
        '1.0.0': { version: '1.0.0', praxis: { schemaVersion: 1, kind: 'theme', id: 'nord', name: 'Nord' }, dist: { tarball: 'https://x/tgz', integrity: 'sha512-AAA' } }
      } });
    })
  );

  await client.getPackument('praxis-addon-nord');
  assert.deepEqual(requested, ['https://npm.pkg.github.com/praxis-addon-nord']);
});

test('getPackument surfaces the real error for a package that is missing under both forms', async () => {
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 't' },
    fakeFetch(() => new Response('not found', { status: 404, statusText: 'Not Found' }))
  );
  await assert.rejects(() => client.getPackument('praxis-addon-ghost'), /not found \(404\)/);
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
  await assert.rejects(() => client.downloadTarball('https://npm.pkg.github.com/download/y.tgz'), /not found \(404\)/);
});

test('the marketplace token is only ever sent to the configured origins', async () => {
  const requested: Array<{ url: string; authorization: string | undefined }> = [];
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 'secret-token' },
    fakeFetch((url, init) => {
      requested.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(new Uint8Array([1, 2, 3]));
    })
  );
  // A packument can name any tarball URL; one on another host is refused before any request.
  await assert.rejects(() => client.downloadTarball('https://attacker.example/pkg.tgz'), /Refusing an add-on tarball from https:\/\/attacker\.example/);
  await assert.rejects(() => client.downloadTarball('http://npm.pkg.github.com/pkg.tgz'), /Refusing/);
  assert.equal(requested.length, 0);
  // The registry's own origin still works.
  assert.equal((await client.downloadTarball('https://npm.pkg.github.com/download/@acme/p/1.0.0/abc')).length, 3);
  assert.equal(requested[0]?.authorization, 'Bearer secret-token');
});

test('a Link header pointing at another host ends pagination with an error, not a leaked token', async () => {
  const requested: string[] = [];
  const client = new GitHubPackagesRegistryClient(
    { owner: 'acme', ownerType: 'user', token: 'secret-token' },
    fakeFetch(url => {
      requested.push(url);
      return json([], { headers: { 'content-type': 'application/json', link: '<https://attacker.example/page2>; rel="next"' } });
    })
  );
  await assert.rejects(() => client.listAddonPackages(), /Refusing the next page of marketplace packages from https:\/\/attacker\.example/);
  assert.equal(requested.length, 1);
});

test('marketplace endpoints must be https, except a loopback registry', () => {
  assert.throws(
    () => new GitHubPackagesRegistryClient({ owner: 'a', ownerType: 'user', token: 't', registryBaseUrl: 'http://registry.example' }),
    /must use https:/
  );
  assert.doesNotThrow(
    () => new GitHubPackagesRegistryClient({ owner: 'a', ownerType: 'user', token: 't', registryBaseUrl: 'http://127.0.0.1:4873', apiBaseUrl: 'http://127.0.0.1:4873' })
  );
});
