/**
 * Values a check stage's arguments can refer to.
 *
 * `{baseCommit}` is the commit the run branched from. A scanner given it can
 * report only what the run introduced, so a gate judges the change rather than
 * findings that were already in the repository before the run started.
 *
 * When the base commit cannot be worked out (a check run outside a run
 * worktree, a detached checkout), any argument that names it is dropped, so
 * the scanner falls back to checking everything. That fails safe: it can only
 * report more findings, never fewer.
 */

export const CHECK_ARG_BASE_COMMIT = '{baseCommit}';

export function checkArgsNeedBaseCommit(args: readonly string[] | undefined): boolean {
  return (args ?? []).some(arg => arg.includes(CHECK_ARG_BASE_COMMIT));
}

export function resolveCheckArgs(args: readonly string[] | undefined, values: { baseCommit?: string }): string[] {
  const baseCommit = values.baseCommit?.trim();
  return (args ?? []).flatMap(arg => {
    if (!arg.includes(CHECK_ARG_BASE_COMMIT)) return [arg];
    return baseCommit ? [arg.split(CHECK_ARG_BASE_COMMIT).join(baseCommit)] : [];
  });
}
