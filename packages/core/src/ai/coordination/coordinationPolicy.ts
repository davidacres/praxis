/**
 * Which claims conflict (FX-BF-048 / TASK-391; FX-BE-094 / TASK-263 overlap detection).
 *
 * Two shared claims never conflict. Otherwise two resources conflict when they can be
 * changed by, or depend on, the same thing:
 *
 * - inside one worktree, a checkout operation conflicts with everything; a coarse
 *   worktree claim conflicts with every file and directory claim; a directory conflicts
 *   with anything beneath it; a file with the same file. Different worktrees never
 *   conflict — corresponding files there are separate checkouts.
 * - the index of one worktree is separate from its files: staging does not block edits.
 * - a live app instance, a browser surface, a port, a fixture, a process group: the same one conflicts.
 * - the desktop's input is one resource for the whole machine.
 * - build output: the same directory, or one inside the other.
 */

import type { ClaimMode, CoordinationResource, CoordinationResourceKind } from './coordinationTypes';

const WORKTREE_KINDS: ReadonlySet<CoordinationResourceKind> = new Set(['file', 'directory', 'worktree', 'checkout', 'git-index']);

/** A path normalised for comparison: forward slashes, no leading `./`, no trailing slash. */
export function canonicalPath(value: string, caseInsensitive = false): string {
  const normal = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return caseInsensitive ? normal.toLowerCase() : normal;
}

function within(child: string, parent: string): boolean {
  return parent === '' || child === parent || child.startsWith(`${parent}/`);
}

function worktreeOf(resource: CoordinationResource): string | undefined {
  return 'worktree' in resource ? canonicalPath(resource.worktree) : undefined;
}

/** Whether two resources overlap, whatever the mode. */
export function resourcesOverlap(left: CoordinationResource, right: CoordinationResource, caseInsensitive = false): boolean {
  if (WORKTREE_KINDS.has(left.kind) && WORKTREE_KINDS.has(right.kind)) {
    if (worktreeOf(left) !== worktreeOf(right)) return false;
    if (left.kind === 'checkout' || right.kind === 'checkout') return true;
    if (left.kind === 'git-index' || right.kind === 'git-index') return left.kind === right.kind;
    if (left.kind === 'worktree' || right.kind === 'worktree') return true;
    const a = canonicalPath((left as { path: string }).path, caseInsensitive);
    const b = canonicalPath((right as { path: string }).path, caseInsensitive);
    if (left.kind === 'file' && right.kind === 'file') return a === b;
    if (left.kind === 'directory' && right.kind === 'directory') return within(a, b) || within(b, a);
    return left.kind === 'directory' ? within(b, a) : within(a, b);
  }
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'desktop':
      return true;
    case 'app-ui':
      return left.instance === (right as typeof left).instance;
    case 'browser':
      return left.surface === (right as typeof left).surface;
    case 'port':
      return left.port === (right as typeof left).port;
    case 'fixture':
      return left.id === (right as typeof left).id;
    case 'process':
      return left.host === (right as typeof left).host && left.pgid === (right as typeof left).pgid;
    case 'build-output': {
      const a = canonicalPath(left.dir, caseInsensitive);
      const b = canonicalPath((right as typeof left).dir, caseInsensitive);
      return within(a, b) || within(b, a);
    }
    default:
      return false;
  }
}

/** Whether two claims, with their modes, may not be held at once. */
export function claimsConflict(
  left: { resource: CoordinationResource; mode: ClaimMode },
  right: { resource: CoordinationResource; mode: ClaimMode },
  caseInsensitive = false
): boolean {
  if (left.mode === 'shared' && right.mode === 'shared') return false;
  return resourcesOverlap(left.resource, right.resource, caseInsensitive);
}

/** A one-line, human description of a resource for a blocker message. */
export function describeResource(resource: CoordinationResource): string {
  switch (resource.kind) {
    case 'file': return `file ${resource.path}`;
    case 'directory': return `folder ${resource.path}/`;
    case 'worktree': return `the checkout at ${resource.worktree}`;
    case 'checkout': return `branch operations in ${resource.worktree}`;
    case 'git-index': return `the Git index of ${resource.worktree}`;
    case 'app-ui': return `the live app (${resource.instance})`;
    case 'browser': return `the in-app browser (${resource.surface})`;
    case 'desktop': return 'the desktop (mouse and keyboard)';
    case 'build-output': return `build output ${resource.dir}`;
    case 'port': return `port ${resource.port}`;
    case 'fixture': return `fixture ${resource.id}`;
    case 'process': return `process group ${resource.pgid}`;
  }
}
