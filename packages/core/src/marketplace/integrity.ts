import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a downloaded tarball against what the registry advertised, before it
 * is ever unpacked. Two shapes are accepted, in this order of preference:
 *
 * - **Subresource Integrity** (`dist.integrity`), e.g. `sha512-<base64>`. This is
 *   what modern npm registries publish; a space-separated list is allowed and
 *   any one entry matching is a pass.
 * - **Legacy shasum** (`dist.shasum`), a hex SHA-1. Weaker, but still worth
 *   checking when it is the only thing on offer.
 *
 * A missing/blank expectation is treated as a hard failure: an add-on install
 * downloads code and content onto the machine, so "the registry told us nothing
 * to check" is not something to wave through.
 */

export interface IntegrityResult {
  ok: boolean;
  /** The algorithm that was checked (`sha512`, `sha1`, …), when one could be. */
  algorithm?: string;
  reason?: string;
}

const SUPPORTED_SRI_ALGORITHMS = new Set(['sha256', 'sha384', 'sha512']);

function digest(bytes: Uint8Array, algorithm: string, encoding: 'base64' | 'hex'): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Checks `bytes` against an SRI string (`sha512-…`), possibly space-separated. */
export function verifySubresourceIntegrity(bytes: Uint8Array, sri: string): IntegrityResult {
  const entries = sri
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(entry => {
      const dash = entry.indexOf('-');
      return dash === -1
        ? undefined
        : { algorithm: entry.slice(0, dash).toLowerCase(), expected: entry.slice(dash + 1) };
    })
    .filter((entry): entry is { algorithm: string; expected: string } => entry !== undefined);

  if (entries.length === 0) {
    return { ok: false, reason: 'Integrity string was not in `<algorithm>-<hash>` form.' };
  }

  const checkable = entries.filter(entry => SUPPORTED_SRI_ALGORITHMS.has(entry.algorithm));
  if (checkable.length === 0) {
    return {
      ok: false,
      reason: `No supported hash algorithm in integrity string (saw ${entries
        .map(entry => entry.algorithm)
        .join(', ')}).`
    };
  }

  for (const entry of checkable) {
    const actual = digest(bytes, entry.algorithm, 'base64');
    if (constantTimeEquals(actual, entry.expected)) {
      return { ok: true, algorithm: entry.algorithm };
    }
  }
  return {
    ok: false,
    algorithm: checkable[0].algorithm,
    reason: 'Downloaded tarball did not match the integrity hash the registry advertised.'
  };
}

/** Checks `bytes` against a hex SHA-1 `shasum`. */
export function verifyShasum(bytes: Uint8Array, shasum: string): IntegrityResult {
  const expected = shasum.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return { ok: false, reason: 'shasum was not a 40-character hex SHA-1.' };
  }
  const actual = digest(bytes, 'sha1', 'hex');
  return constantTimeEquals(actual, expected)
    ? { ok: true, algorithm: 'sha1' }
    : {
        ok: false,
        algorithm: 'sha1',
        reason: 'Downloaded tarball did not match the shasum the registry advertised.'
      };
}

/**
 * Verifies `bytes` against whatever the registry gave us, preferring SRI. Throws
 * with a specific reason on any failure, including "nothing to verify against".
 */
export function assertTarballIntegrity(
  bytes: Uint8Array,
  dist: { integrity?: string; shasum?: string }
): void {
  if (dist.integrity && dist.integrity.trim()) {
    const result = verifySubresourceIntegrity(bytes, dist.integrity);
    if (!result.ok) {
      throw new Error(result.reason ?? 'Tarball failed integrity verification.');
    }
    return;
  }
  if (dist.shasum && dist.shasum.trim()) {
    const result = verifyShasum(bytes, dist.shasum);
    if (!result.ok) {
      throw new Error(result.reason ?? 'Tarball failed shasum verification.');
    }
    return;
  }
  throw new Error(
    'The registry published no integrity hash or shasum for this version — refusing to install it.'
  );
}
