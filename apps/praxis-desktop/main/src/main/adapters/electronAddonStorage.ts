import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type AddonKind,
  type AddonStorage,
  type InstalledAddon,
  ADDON_KINDS,
  INSTALL_RECORD_FILE,
  validateAddonManifest
} from '@praxis/core';

/**
 * On-disk home for installed add-ons, under `userData/addons/<kind>/<id>/`.
 *
 * Each add-on directory holds the unpacked `package/addon/**` payload from the
 * npm tarball, plus a `.praxis-addon.json` install record. The tarball handed to
 * `write` has already been integrity-checked by `MarketplaceService`; this
 * class only unpacks it (via `tar`, dynamically imported since it is ESM) and
 * keeps the record in sync.
 */
export class ElectronAddonStorage implements AddonStorage {
  public constructor(private readonly addonsRoot: string) {}

  /** `userData/addons/<kind>` — the discovery root for one kind. */
  public kindRoot(kind: AddonKind): string {
    return path.join(this.addonsRoot, kind);
  }

  /** `userData/addons/<kind>/<id>` — one installed add-on's directory. */
  public addonDir(kind: AddonKind, id: string): string {
    return path.join(this.addonsRoot, kind, sanitizeSegment(id));
  }

  public async list(): Promise<InstalledAddon[]> {
    const out: InstalledAddon[] = [];
    for (const kind of ADDON_KINDS) {
      const root = this.kindRoot(kind);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const record = await this.readRecord(kind, entry.name);
        if (record) out.push(record);
      }
    }
    return out;
  }

  public get(kind: AddonKind, id: string): Promise<InstalledAddon | undefined> {
    return this.readRecord(kind, sanitizeSegment(id));
  }

  public async write(record: InstalledAddon, tarball: Uint8Array): Promise<void> {
    const dir = this.addonDir(record.manifest.kind, record.manifest.id);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });

    await extractAddonPayload(tarball, dir, this.addonsRoot);

    const recordPath = path.join(dir, INSTALL_RECORD_FILE);
    await fs.promises.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  public async remove(kind: AddonKind, id: string): Promise<void> {
    await fs.promises.rm(this.addonDir(kind, id), { recursive: true, force: true });
  }

  public async setEnabled(kind: AddonKind, id: string, enabled: boolean): Promise<void> {
    const record = await this.readRecord(kind, sanitizeSegment(id));
    if (!record) {
      throw new Error(`No installed ${kind} add-on with id "${id}".`);
    }
    record.enabled = enabled;
    await fs.promises.writeFile(
      path.join(this.addonDir(kind, id), INSTALL_RECORD_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8'
    );
  }

  private async readRecord(kind: AddonKind, dirName: string): Promise<InstalledAddon | undefined> {
    const recordPath = path.join(this.kindRoot(kind), dirName, INSTALL_RECORD_FILE);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== 'object') return undefined;
    const candidate = raw as Record<string, unknown>;
    const { manifest } = validateAddonManifest(candidate.manifest);
    if (!manifest || manifest.kind !== kind) return undefined;
    return {
      manifest,
      packageName: typeof candidate.packageName === 'string' ? candidate.packageName : '',
      version: typeof candidate.version === 'string' ? candidate.version : '0.0.0',
      integrity: typeof candidate.integrity === 'string' ? candidate.integrity : undefined,
      installedAt:
        typeof candidate.installedAt === 'string' ? candidate.installedAt : new Date(0).toISOString(),
      enabled: candidate.enabled !== false
    };
  }
}

function sanitizeSegment(value: string): string {
  // Manifest ids are already `[a-z0-9-]`; this is defence in depth against a
  // record that reached disk another way.
  return value.replace(/[^a-z0-9-]/gi, '');
}

/**
 * Unpacks just `package/addon/**` from an npm tarball into `destDir`, flattening
 * away the `package/addon/` prefix. `tar` rejects `..` and absolute paths by
 * default; the post-check is belt-and-braces.
 */
async function extractAddonPayload(
  tarball: Uint8Array,
  destDir: string,
  scratchDir: string
): Promise<void> {
  const tar = await import('tar');
  const tmpFile = path.join(scratchDir, `.incoming-${crypto.randomBytes(8).toString('hex')}.tgz`);
  await fs.promises.mkdir(scratchDir, { recursive: true });
  await fs.promises.writeFile(tmpFile, Buffer.from(tarball));

  let wrote = 0;
  try {
    await tar.x({
      file: tmpFile,
      cwd: destDir,
      strip: 2,
      filter: (entryPath: string) =>
        entryPath === 'package/addon' || entryPath.startsWith('package/addon/'),
      onentry: () => {
        wrote += 1;
      }
    });
  } finally {
    await fs.promises.rm(tmpFile, { force: true });
  }

  if (wrote === 0) {
    throw new Error('The add-on tarball had no `package/addon/` payload.');
  }

  const resolvedDest = path.resolve(destDir);
  for (const relative of await walk(resolvedDest)) {
    if (!path.resolve(resolvedDest, relative).startsWith(resolvedDest + path.sep)) {
      throw new Error(`Add-on tarball tried to write outside its directory: ${relative}`);
    }
  }
}

async function walk(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}
