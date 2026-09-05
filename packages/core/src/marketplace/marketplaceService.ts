import {
  type AddonKind,
  type AddonManifest,
  type AddonUpdate,
  type CatalogEntry,
  type InstalledAddon,
  DECLARATIVE_ADDON_KINDS
} from './catalogTypes';
import { validateAddonManifest } from './addonManifest';
import { assertTarballIntegrity } from './integrity';
import { type MarketplaceRegistryClient, type Packument } from './registryClient';
import { isNewerVersion, maxVersion, meetsMinimum, sortVersionsDescending } from './semver';

/**
 * Turns the registry client into the operations the app calls: browse, install,
 * check for updates, update, remove, and grant/revoke trust. Everything that
 * touches disk — unpacking a verified tarball, reading/writing install records —
 * is delegated to an {@link AddonStorage} the host provides, so this module
 * stays free of `fs` and Electron.
 */

export interface AddonStorage {
  /** Every installed add-on, read from its on-disk record. */
  list(): Promise<InstalledAddon[]>;
  get(kind: AddonKind, id: string): Promise<InstalledAddon | undefined>;
  /**
   * Replace any existing install of this add-on: unpack the npm tarball
   * (`package/addon/**`) into the add-on's directory and write the record.
   * The tarball has already been integrity-checked.
   */
  write(record: InstalledAddon, tarball: Uint8Array): Promise<void>;
  remove(kind: AddonKind, id: string): Promise<void>;
  setEnabled(kind: AddonKind, id: string, enabled: boolean): Promise<void>;
}

export interface MarketplaceServiceOptions {
  client: MarketplaceRegistryClient;
  storage: AddonStorage;
  /** Running app version, for `minAppVersion` gating. */
  appVersion: string;
  log?: (message: string) => void;
}

export interface InstallOptions {
  /** Pin a specific published version instead of `latest`. */
  version?: string;
  /**
   * Grant an agent add-on trust as part of the install. Ignored for declarative
   * kinds (always enabled) — they cannot be installed disabled.
   */
  trustAgent?: boolean;
}

function noop(): void {
  /* no logger supplied */
}

export class MarketplaceService {
  private readonly client: MarketplaceRegistryClient;
  private readonly storage: AddonStorage;
  private readonly appVersion: string;
  private readonly log: (message: string) => void;

  public constructor(options: MarketplaceServiceOptions) {
    this.client = options.client;
    this.storage = options.storage;
    this.appVersion = options.appVersion;
    this.log = options.log ?? noop;
  }

  /**
   * The browsable catalogue: one entry per publishable add-on package, resolved
   * to its `latest` version. Packages whose latest version has an invalid
   * manifest are logged and dropped; ones that need a newer app are kept but
   * marked `incompatible`.
   */
  public async listCatalog(): Promise<CatalogEntry[]> {
    const packages = await this.client.listAddonPackages();
    const entries: CatalogEntry[] = [];

    for (const pkg of packages) {
      let packument: Packument;
      try {
        packument = await this.client.getPackument(pkg.name);
      } catch (error) {
        this.log(`[marketplace] skipping ${pkg.name}: ${describe(error)}`);
        continue;
      }

      const resolved = this.resolveLatest(packument);
      if (!resolved) {
        this.log(`[marketplace] skipping ${pkg.name}: no usable published version`);
        continue;
      }

      const { manifest, errors, warnings } = validateAddonManifest(
        packument.versions[resolved]?.praxis
      );
      if (!manifest) {
        this.log(
          `[marketplace] skipping ${pkg.name}@${resolved}: invalid manifest (${errors.join('; ')})`
        );
        continue;
      }

      const versions = sortVersionsDescending(Object.keys(packument.versions));
      const incompatible =
        manifest.minAppVersion !== undefined &&
        !meetsMinimum(this.appVersion, manifest.minAppVersion);
      const allWarnings = [...warnings];
      if (incompatible) {
        allWarnings.push(`Needs Praxis ${manifest.minAppVersion} or newer (you have ${this.appVersion}).`);
      }

      entries.push({
        manifest,
        packageName: pkg.name,
        latestVersion: resolved,
        versions,
        updatedAt: packument.time?.[resolved] ?? pkg.updatedAt,
        incompatible,
        warnings: allWarnings
      });
    }

    return entries.sort(
      (a, b) =>
        a.manifest.kind.localeCompare(b.manifest.kind) ||
        a.manifest.name.localeCompare(b.manifest.name)
    );
  }

  public listInstalled(): Promise<InstalledAddon[]> {
    return this.storage.list();
  }

  /** Downloads, verifies, validates, and unpacks one add-on package. */
  public async install(packageName: string, options: InstallOptions = {}): Promise<InstalledAddon> {
    const packument = await this.client.getPackument(packageName);

    const version = options.version ?? this.resolveLatest(packument);
    if (!version) {
      throw new Error(`${packageName} has no installable version.`);
    }
    const versionEntry = packument.versions[version];
    if (!versionEntry) {
      throw new Error(`${packageName} has no published version ${version}.`);
    }

    const { manifest, errors } = validateAddonManifest(versionEntry.praxis);
    if (!manifest) {
      throw new Error(`${packageName}@${version} has an invalid add-on manifest: ${errors.join('; ')}`);
    }
    if (
      manifest.minAppVersion !== undefined &&
      !meetsMinimum(this.appVersion, manifest.minAppVersion)
    ) {
      throw new Error(
        `${manifest.name} needs Praxis ${manifest.minAppVersion} or newer; this build is ${this.appVersion}.`
      );
    }

    const tarball = await this.client.downloadTarball(versionEntry.dist.tarball);
    assertTarballIntegrity(tarball, versionEntry.dist);

    const enabled = this.resolveEnabled(manifest, options.trustAgent);
    const record: InstalledAddon = {
      manifest,
      packageName,
      version,
      integrity: versionEntry.dist.integrity,
      installedAt: new Date().toISOString(),
      enabled
    };

    await this.storage.write(record, tarball);
    this.log(
      `[marketplace] installed ${manifest.kind}/${manifest.id} ${version}` +
        (enabled ? '' : ' (disabled — grant trust to enable)')
    );
    return record;
  }

  /** Installed add-ons that have a newer `latest` on the registry. */
  public async checkForUpdates(): Promise<AddonUpdate[]> {
    const installed = await this.storage.list();
    const updates: AddonUpdate[] = [];

    for (const addon of installed) {
      let packument: Packument;
      try {
        packument = await this.client.getPackument(addon.packageName);
      } catch (error) {
        this.log(`[marketplace] update check failed for ${addon.packageName}: ${describe(error)}`);
        continue;
      }
      const latest = this.resolveLatest(packument);
      if (latest && isNewerVersion(latest, addon.version)) {
        updates.push({
          id: addon.manifest.id,
          kind: addon.manifest.kind,
          packageName: addon.packageName,
          installedVersion: addon.version,
          latestVersion: latest
        });
      }
    }
    return updates;
  }

  /** Reinstalls an add-on at the latest version, preserving its enabled state. */
  public async update(kind: AddonKind, id: string): Promise<InstalledAddon> {
    const current = await this.storage.get(kind, id);
    if (!current) {
      throw new Error(`No installed ${kind} add-on with id "${id}".`);
    }
    return this.install(current.packageName, {
      trustAgent: current.enabled && kind === 'agent'
    });
  }

  public remove(kind: AddonKind, id: string): Promise<void> {
    this.log(`[marketplace] removing ${kind}/${id}`);
    return this.storage.remove(kind, id);
  }

  /** Grants or revokes trust for an installed agent add-on. */
  public async setAgentTrust(id: string, enabled: boolean): Promise<void> {
    const addon = await this.storage.get('agent', id);
    if (!addon) {
      throw new Error(`No installed agent add-on with id "${id}".`);
    }
    await this.storage.setEnabled('agent', id, enabled);
    this.log(`[marketplace] agent/${id} ${enabled ? 'trusted' : 'trust revoked'}`);
  }

  private resolveLatest(packument: Packument): string | undefined {
    const tagged = packument.distTags.latest;
    if (tagged && packument.versions[tagged]) {
      return tagged;
    }
    return maxVersion(Object.keys(packument.versions));
  }

  private resolveEnabled(manifest: AddonManifest, trustAgent: boolean | undefined): boolean {
    if ((DECLARATIVE_ADDON_KINDS as readonly string[]).includes(manifest.kind)) {
      return true;
    }
    return trustAgent === true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
