/**
 * Scoped preview origin grants (FX-BE-055 / TASK-145).
 *
 * The in-app AI browser (`ai/tools/browserTools.ts`) gates loopback/private
 * hosts behind one global on/off flag — appropriate for an agent that should
 * never reach the local network at all. A Run preview is the opposite case:
 * the whole point is to show the user their own locally-running service, but
 * only that exact origin, only while its run is active, and never anything
 * else reachable from loopback or the private network by accident (another
 * project's port, a redirect off to a different private host, a subresource
 * the previewed page's own script tries to pull from somewhere else private).
 *
 * `PreviewAccessRegistry` is the source of truth for which origins are
 * currently granted; `previewAccessBlockedReason` is the one decision
 * function applied identically to top-level navigation, a mid-navigation
 * redirect, and a subresource load — the policy is the same in all three
 * cases, only the Electron hook that calls it differs (`will-navigate`,
 * `will-redirect`, `session.webRequest.onBeforeRequest`), which is why this
 * stays a single exported function rather than three near-duplicates.
 */

import { isPrivateOrLoopbackHost } from '../ai/tools/browserTools';

export interface PreviewOriginGrant {
  projectId: string;
  runId: string;
  serviceId: string;
  /** Scheme + host + port, no path/query — e.g. "http://127.0.0.1:5173". */
  origin: string;
  grantedAt: string;
}

/** The scheme+host+port an origin string normalizes to, or undefined if the URL isn't loopback/private http(s). */
function normalizeOrigin(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return `${url.protocol}//${url.host}`;
}

export class PreviewAccessRegistry {
  private grantsByOrigin = new Map<string, PreviewOriginGrant>();

  /**
   * Grants one loopback/private origin to a project's run. Fails closed on a
   * non-loopback/private origin — a "preview" grant exists to carve a hole in
   * the private-host restriction, so granting a public origin would be a
   * no-op at best and a confusing mislabel at worst; refused outright instead.
   */
  grant(projectId: string, runId: string, serviceId: string, rawOrigin: string): void {
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) throw new Error(`Not a valid http(s) origin: "${rawOrigin}".`);
    const host = new URL(origin).hostname;
    if (!isPrivateOrLoopbackHost(host)) {
      throw new Error(`Refusing to grant a non-private origin (${origin}) — preview grants are for loopback/private hosts only.`);
    }
    this.grantsByOrigin.set(origin, { projectId, runId, serviceId, origin, grantedAt: new Date().toISOString() });
  }

  /** Revokes every grant belonging to one project's run — call this the moment that run stops. */
  revokeRun(projectId: string, runId: string): void {
    for (const [origin, grant] of this.grantsByOrigin) {
      if (grant.projectId === projectId && grant.runId === runId) this.grantsByOrigin.delete(origin);
    }
  }

  revokeAll(): void {
    this.grantsByOrigin.clear();
  }

  grants(): PreviewOriginGrant[] {
    return [...this.grantsByOrigin.values()];
  }

  /** Whether `rawUrl`'s own origin currently has an active grant (from any run). */
  isOriginGranted(rawUrl: string): boolean {
    const origin = normalizeOrigin(rawUrl);
    return origin !== undefined && this.grantsByOrigin.has(origin);
  }

  /** The grant (and so the owning project/run/service) behind `rawUrl`'s origin, if any — how a consumer that only has a URL (e.g. the preview surface, capturing diagnostics for whatever page is currently open) recovers whose evidence this is. */
  grantFor(rawUrl: string): PreviewOriginGrant | undefined {
    const origin = normalizeOrigin(rawUrl);
    return origin !== undefined ? this.grantsByOrigin.get(origin) : undefined;
  }
}

/**
 * The one access decision, applied identically whether `rawUrl` is a
 * top-level navigation target, a redirect target, or a subresource request:
 * a non-private host is always allowed (ordinary public browsing is not
 * this policy's concern); a private/loopback host is allowed only when its
 * exact origin is currently granted. Returns a rejection reason, or
 * `undefined` when the request may proceed.
 */
export function previewAccessBlockedReason(rawUrl: string, registry: Pick<PreviewAccessRegistry, 'isOriginGranted'>): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Not a valid absolute URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Unsupported scheme "${url.protocol}" — only http and https are allowed.`;
  }
  if (!isPrivateOrLoopbackHost(url.hostname)) return undefined;
  if (registry.isOriginGranted(rawUrl)) return undefined;
  return `Refusing a loopback / private-network origin with no active preview grant (${url.protocol}//${url.host}).`;
}
