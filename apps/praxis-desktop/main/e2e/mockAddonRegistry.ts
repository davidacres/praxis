// SPDX-License-Identifier: MIT
//
// In-process mock of the GitHub Packages surface the add-on marketplace uses:
//   • GitHub REST — GET /users|orgs/<owner>/packages?package_type=npm
//   • npm registry — GET /<packageName>            (packument)
//                    GET /<packageName>/-/<file>.tgz (tarball)
//
// One `node:http` server serves both, so an e2e can point the app's
// `apiBaseUrl` and `registryBaseUrl` at the same base. Tarballs are built for
// real with `tar` so `MarketplaceService`'s integrity check runs against a
// genuine gzipped tar, exactly as in production.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface MockAddon {
  /** npm package name (must match the app's configured prefix, e.g. `praxis-addon-…`). */
  packageName: string;
  version: string;
  /** The `praxis` block that goes into the published package.json. */
  manifest: Record<string, unknown>;
  /** Files placed under `package/addon/` in the tarball, e.g. `{ 'theme.json': {...} }`. */
  payload: Record<string, unknown | string>;
}

export interface MockAddonRegistry {
  baseUrl: string;
  /** Add or replace an add-on after startup; the catalogue picks it up on the next list. */
  put(addon: MockAddon): Promise<void>;
  close(): Promise<void>;
}

interface BuiltAddon {
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  tarball: Buffer;
  integrity: string;
  updatedAt: string;
}

async function buildTarball(addon: MockAddon): Promise<Buffer> {
  const tar = await import('tar');
  const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'praxis-addon-fixture-'));
  const pkgDir = path.join(stage, 'package');
  const addonDir = path.join(pkgDir, 'addon');
  await fs.promises.mkdir(addonDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      { name: addon.packageName, version: addon.version, praxis: addon.manifest },
      null,
      2
    )
  );
  for (const [file, content] of Object.entries(addon.payload)) {
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    await fs.promises.writeFile(path.join(addonDir, file), body);
  }

  const tgzPath = path.join(stage, 'out.tgz');
  await tar.c({ file: tgzPath, cwd: stage, gzip: true }, ['package']);
  const buffer = await fs.promises.readFile(tgzPath);
  await fs.promises.rm(stage, { recursive: true, force: true });
  return buffer;
}

export async function startMockAddonRegistry(options: {
  owner: string;
  ownerType?: 'user' | 'org';
  addons: MockAddon[];
}): Promise<MockAddonRegistry> {
  const ownerScope = (options.ownerType ?? 'user') === 'org' ? 'orgs' : 'users';
  const built = new Map<string, BuiltAddon>();

  const ingest = async (addon: MockAddon): Promise<void> => {
    const tarball = await buildTarball(addon);
    built.set(addon.packageName, {
      packageName: addon.packageName,
      version: addon.version,
      manifest: addon.manifest,
      tarball,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      updatedAt: new Date().toISOString()
    });
  };
  for (const addon of options.addons) {
    await ingest(addon);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // GitHub REST — package listing.
    if (url.pathname === `/${ownerScope}/${options.owner}/packages`) {
      send(
        200,
        [...built.values()].map(addon => ({
          name: addon.packageName,
          package_type: 'npm',
          html_url: `${base()}/${addon.packageName}`,
          updated_at: addon.updatedAt
        }))
      );
      return;
    }

    // npm registry — tarball.
    const tgz = /^\/(.+)\/-\/(.+)\.tgz$/.exec(url.pathname);
    if (tgz) {
      const addon = built.get(decodeURIComponent(tgz[1]));
      if (!addon) return send(404, { message: 'no such package' });
      return send(200, addon.tarball, 'application/octet-stream');
    }

    // npm registry — packument.
    const name = decodeURIComponent(url.pathname.replace(/^\//, '').replace('%2F', '/'));
    const addon = built.get(name);
    if (addon) {
      send(200, {
        name: addon.packageName,
        'dist-tags': { latest: addon.version },
        time: { [addon.version]: addon.updatedAt, modified: addon.updatedAt },
        versions: {
          [addon.version]: {
            name: addon.packageName,
            version: addon.version,
            praxis: addon.manifest,
            dist: {
              tarball: `${base()}/${addon.packageName}/-/${addon.packageName}-${addon.version}.tgz`,
              integrity: addon.integrity
            }
          }
        }
      });
      return;
    }

    send(404, { message: `unhandled ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const base = () => `http://127.0.0.1:${port}`;

  return {
    baseUrl: base(),
    put: ingest,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
