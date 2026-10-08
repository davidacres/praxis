/**
 * Changes outside what a session declared (FX-BE-094 / TASK-265).
 *
 * A session that claimed specific files or folders has said what it is working on. A
 * change anywhere else is either a mistake or something nobody agreed to — and with
 * several sessions in flight, possibly a collision with another session's work. Policy
 * decides what happens: `escalate` lets the change set stand but flags it for a person;
 * `block` holds it back from commit and merge until a person approves it. A session that
 * declared nothing (or a coarse worktree claim) has no narrower scope to be outside of.
 */

import { canonicalPath } from './coordinationPolicy';
import type { CoordinationResource } from './coordinationTypes';

export type OutOfScopePolicy = 'block' | 'escalate';

export interface ChangeScopeAssessment {
  /** The session declared a narrower scope than its whole worktree. */
  scoped: boolean;
  inScope: string[];
  outOfScope: string[];
  /** What the policy asks for: nothing to do, a flag for a person, or a hold. */
  action: 'none' | 'escalate' | 'block';
  message?: string;
}

export function assessChangeScope(
  changedPaths: readonly string[],
  declared: readonly CoordinationResource[],
  worktree: string,
  policy: OutOfScopePolicy,
  caseInsensitive = false
): ChangeScopeAssessment {
  const root = canonicalPath(worktree);
  const mine = declared.filter(resource => 'worktree' in resource && canonicalPath(resource.worktree) === root);
  const coarse = mine.some(resource => resource.kind === 'worktree' || resource.kind === 'checkout');
  const narrow = mine.filter((resource): resource is Extract<CoordinationResource, { kind: 'file' | 'directory' }> => resource.kind === 'file' || resource.kind === 'directory');
  const paths = [...new Set(changedPaths.map(changed => canonicalPath(changed, caseInsensitive)).filter(Boolean))];
  if (coarse || narrow.length === 0) return { scoped: false, inScope: paths, outOfScope: [], action: 'none' };

  const covers = (changed: string) =>
    narrow.some(resource => {
      const target = canonicalPath(resource.path, caseInsensitive);
      return resource.kind === 'file' ? changed === target : target === '' || changed === target || changed.startsWith(`${target}/`);
    });
  const inScope = paths.filter(covers);
  const outOfScope = paths.filter(changed => !covers(changed));
  if (outOfScope.length === 0) return { scoped: true, inScope, outOfScope, action: 'none' };
  const list = outOfScope.slice(0, 10).join(', ') + (outOfScope.length > 10 ? `, and ${outOfScope.length - 10} more` : '');
  return {
    scoped: true,
    inScope,
    outOfScope,
    action: policy,
    message:
      policy === 'block'
        ? `Held back: ${outOfScope.length} changed path${outOfScope.length === 1 ? '' : 's'} outside what this session claimed (${list}). Approve them, or undo them, before this change set is committed or merged.`
        : `${outOfScope.length} changed path${outOfScope.length === 1 ? '' : 's'} outside what this session claimed (${list}). Check they belong in this change.`
  };
}
