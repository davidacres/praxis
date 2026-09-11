/**
 * Talks to a GitHub Packages npm registry to discover and fetch add-ons.
 *
 * Discovery goes through the **GitHub REST API** — `GET /users|orgs/{owner}/
 * packages?package_type=npm`, Link-header paginated — filtered by a package
 * name prefix. Version metadata and tarballs come from the **npm registry
 * endpoint** (`https://npm.pkg.github.com`), which serves a standard packument.
 * Both require a bearer token even for public packages.
 *
 * The client only speaks HTTP and shapes responses; it does no validation,
 * verification, or disk work — that is {@link MarketplaceService}'s job.
 */

const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_REGISTRY_BASE_URL = 'https://npm.pkg.github.com';
export const DEFAULT_ADDON_PACKAGE_PREFIX = 'praxis-addon-';

export interface RegistryPackageRef {
  /** npm package name. */
  name: string;
  /** GitHub UI URL for the package, when present. */
  htmlUrl?: string;
  /** Last-updated time GitHub reports for the package. */
  updatedAt?: string;
}

export interface PackumentDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

export interface PackumentVersion {
  version: string;
  /** The add-on manifest, straight from the published `package.json`; unvalidated. */
  praxis?: unknown;
  dist: PackumentDist;
}

export interface Packument {
  name: string;
  /** `{ latest: '1.4.0', … }`. */
  distTags: Record<string, string>;
  versions: Record<string, PackumentVersion>;
  /** `{ '1.4.0': isoString, modified: isoString, … }` when the registry includes it. */
  time?: Record<string, string>;
}

export interface MarketplaceRegistryClient {
  /** Add-on packages the owner publishes (name-prefix filtered), newest-updated first. */
  listAddonPackages(): Promise<RegistryPackageRef[]>;
  getPackument(packageName: string): Promise<Packument>;
  downloadTarball(tarballUrl: string): Promise<Uint8Array>;
}

export interface GitHubPackagesConfig {
  owner: string;
  ownerType: 'user' | 'org';
  token: string;
  /** Marks a package as a Praxis add-on. Default `praxis-addon-`. */
  packageNamePrefix?: string;
  /** Default `https://api.github.com`. Set for GitHub Enterprise Server. */
  apiBaseUrl?: string;
  /** Default `https://npm.pkg.github.com`. */
  registryBaseUrl?: string;
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** `@scope/name` → `@scope%2Fname`; unscoped names pass through. */
export function encodePackumentPath(packageName: string): string {
  if (packageName.startsWith('@')) {
    const slash = packageName.indexOf('/');
    if (slash !== -1) {
      return `${packageName.slice(0, slash)}%2F${encodeURIComponent(packageName.slice(slash + 1))}`;
    }
  }
  return encodeURIComponent(packageName);
}

/** Extracts the URL for `rel="next"` from a GitHub `Link` header. */
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

export function formatRegistryError(
  context: string,
  status: number,
  statusText: string,
  body: string
): string {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    } catch {
      /* not JSON */
    }
    const trimmed = body.trim();
    return trimmed.length > 0 && trimmed.length < 300 ? trimmed : '';
  })();
  const suffix = detail ? ` — ${detail}` : '';
  if (status === 401 || status === 403) {
    return `${context}: ${status} ${statusText}${suffix}. Check the marketplace GitHub token and that it has \`read:packages\`.`;
  }
  if (status === 404) {
    return `${context}: not found (404)${suffix}.`;
  }
  return `${context}: ${status} ${statusText}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePackument(name: string, raw: unknown): Packument {
  if (!isRecord(raw)) {
    throw new Error(`Registry returned a non-object packument for ${name}.`);
  }
  const distTagsRaw = raw['dist-tags'];
  const distTags: Record<string, string> = {};
  if (isRecord(distTagsRaw)) {
    for (const [tag, version] of Object.entries(distTagsRaw)) {
      if (typeof version === 'string') distTags[tag] = version;
    }
  }

  const versions: Record<string, PackumentVersion> = {};
  const versionsRaw = raw.versions;
  if (isRecord(versionsRaw)) {
    for (const [version, entry] of Object.entries(versionsRaw)) {
      if (!isRecord(entry)) continue;
      const dist = isRecord(entry.dist) ? entry.dist : undefined;
      const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : undefined;
      if (!tarball) continue;
      versions[version] = {
        version,
        praxis: entry.praxis,
        dist: {
          tarball,
          integrity: typeof dist?.integrity === 'string' ? dist.integrity : undefined,
          shasum: typeof dist?.shasum === 'string' ? dist.shasum : undefined
        }
      };
    }
  }

  const time: Record<string, string> = {};
  if (isRecord(raw.time)) {
    for (const [key, value] of Object.entries(raw.time)) {
      if (typeof value === 'string') time[key] = value;
    }
  }

  return { name, distTags, versions, time: Object.keys(time).length ? time : undefined };
}

export class GitHubPackagesRegistryClient implements MarketplaceRegistryClient {
  private readonly prefix: string;
  private readonly apiBaseUrl: string;
  private readonly registryBaseUrl: string;

  public constructor(
    private readonly config: GitHubPackagesConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {
    this.prefix = config.packageNamePrefix ?? DEFAULT_ADDON_PACKAGE_PREFIX;
    this.apiBaseUrl = trimSlashes(config.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.registryBaseUrl = trimSlashes(config.registryBaseUrl ?? DEFAULT_REGISTRY_BASE_URL);
  }

  public async listAddonPackages(): Promise<RegistryPackageRef[]> {
    const owner = this.config.owner.trim();
    if (!owner) {
      throw new Error('No marketplace owner is configured.');
    }
    const scope = this.config.ownerType === 'org' ? 'orgs' : 'users';
    let url: string | undefined = `${this.apiBaseUrl}/${scope}/${encodeURIComponent(
      owner
    )}/packages?package_type=npm&per_page=100`;

    const refs: RegistryPackageRef[] = [];
    while (url) {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.config.token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION
        }
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          formatRegistryError('Listing marketplace packages', response.status, response.statusText, text)
        );
      }
      const page = text.trim() ? (JSON.parse(text) as unknown) : [];
      if (Array.isArray(page)) {
        for (const item of page) {
          if (!isRecord(item) || typeof item.name !== 'string') continue;
          // Extract package name part after scope (e.g., @owner/praxis-addon-* -> praxis-addon-*)
          const nameWithoutScope = item.name.includes('/') ? item.name.split('/')[1]! : item.name;
          if (!nameWithoutScope.startsWith(this.prefix)) continue;
          refs.push({
            name: item.name,
            htmlUrl: typeof item.html_url === 'string' ? item.html_url : undefined,
            updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined
          });
        }
      }
      url = parseNextLink(response.headers.get('link'));
    }

    return refs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  public async getPackument(packageName: string): Promise<Packument> {
    const url = `${this.registryBaseUrl}/${encodePackumentPath(packageName)}`;
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.token}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        formatRegistryError(`Fetching ${packageName}`, response.status, response.statusText, text)
      );
    }
    return normalizePackument(packageName, JSON.parse(text) as unknown);
  }

  public async downloadTarball(tarballUrl: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(tarballUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        formatRegistryError('Downloading add-on tarball', response.status, response.statusText, text)
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
