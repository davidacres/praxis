# Local branch and worktree register

Snapshot: 2026-11-09. This is a manual inventory of this machine, not a live Git view. Refresh it whenever a branch or worktree is created, handed over, merged or removed. Paths and status can differ on another machine.

| Branch | Worktree | Purpose | Status and outstanding work |
| --- | --- | --- | --- |
| `main` | `/Users/daveacres/dev/tools/praxis` | Primary checkout and integration branch for the Rust migration. | At `5a21f6c8` when inventoried; 73 commits ahead of the local `origin/main` reference, which was not fetched for this inventory. Untracked `apps/praxis-desktop/.agents/` contains scratch files; review before removing. |
| `worktree-agent-a8abe85fe9cfcb5b9` | `/Users/daveacres/dev/tools/praxis/.claude/worktrees/agent-a8abe85fe9cfcb5b9` | TASK-520 mobile host foundations and projections. | At `f3178f5f`, an ancestor of `main` (no unique commits; six commits behind at inventory). Two untracked drafts remain: `crates/praxis-mobile/src/host/services.rs` and `scheduled_runs.rs`. Preserve and review them before removing this worktree. |

## Keeping this register current

When creating a branch or worktree, add its branch name, absolute path, purpose, owner or task, starting point and current status. Update the entry at handover and after integration; record uncommitted or untracked work and any remaining action. When retiring one, verify its unique commits and working-tree changes first, preserve needed work, then record its removal or remove its entry. Never force-delete unmerged history without explicit approval.

For a fresh inventory, run `git worktree list --porcelain`, `git branch -vv`, and `git status --short` in each worktree. Compare each branch against the intended integration branch with `git rev-list --left-right --count main...<branch>` and inspect any unique commits and diffs. A clean Git status does not establish that ignored files are disposable.
