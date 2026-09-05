/**
 * A deliberately small semver comparator — enough to order add-on versions and
 * gate `minAppVersion`, without pulling `semver` into core's dependency set.
 *
 * Supports `MAJOR.MINOR.PATCH` with an optional `-prerelease` and an ignored
 * `+build`. Prerelease ordering follows the spec: a prerelease is lower than the
 * associated release, numeric identifiers compare numerically, and a longer set
 * of identifiers wins when every shared identifier is equal.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses a semver string, or returns undefined when it is not valid semver. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_RE.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease
      ? prerelease.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
      : []
  };
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== undefined;
}

function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  // A version with no prerelease outranks one that has any.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;

    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && bNum) return (ai as number) - (bi as number);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNum) return -1;
    if (bNum) return 1;
    return String(ai) < String(bi) ? -1 : 1;
  }
  return 0;
}

/**
 * Returns a negative number when `a < b`, zero when equal, positive when `a > b`.
 * Unparseable versions sort below every valid one, and equal to each other.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is a strictly higher version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** The highest version in the list, or undefined when none parse. */
export function maxVersion(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const version of versions) {
    if (!isValidVersion(version)) continue;
    if (best === undefined || isNewerVersion(version, best)) {
      best = version;
    }
  }
  return best;
}

/** True when `version` is at least `minimum` (both must be valid semver). */
export function meetsMinimum(version: string, minimum: string): boolean {
  if (!isValidVersion(version) || !isValidVersion(minimum)) return false;
  return compareVersions(version, minimum) >= 0;
}

/** Sorts a copy of the list newest-first. */
export function sortVersionsDescending(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}
